import { requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import type { CompetitorRef, NormalizedItem } from './types'

// Product Hunt API v2 (GraphQL) source adapter.
//
// Schema reality (verified via introspection, see scripts/test-source-ph-debug.ts):
//  - Root queries are: collection, collections, comment, post, posts, topic,
//    topics, user, viewer. There is NO `product`/`products` root query.
//  - `Post` has no `product` field — PH's "Product" page is a website-only
//    aggregation, not exposed in the API.
//  - `posts(...)` filter args: featured, postedBefore, postedAfter, topic,
//    order, twitterUrl, url, after, before, first, last. There is no name,
//    slug, or keyword search.
//  - `posts(url:)` empirically returns 0 hits even when given the canonical
//    URL of a post the API just returned — not a usable filter.
//  - `User` fields are redacted under a Developer Token (id=0, name="[REDACTED]"),
//    so user.madePosts / submittedPosts can't be used for per-company lookup.
//  - Rate limit: 6250 complexity points per 15 min.
//
// Consequence: PH is a global firehose. We pull recent posts ONCE per
// ingestion run and dispatch matches across all competitors. The per-competitor
// adapter signature (#7's orchestrator expects fan-out) is preserved via a
// thin wrapper, but the orchestrator should prefer `fetchPHForCompetitors`
// to amortize the firehose scan.
//
// Matching: every Post.url has the form `https://www.producthunt.com/products/<slug>?...`.
// The `<slug>` segment is the canonical product slug (matches PH's public product
// page slug). We extract it and exact-match against competitor.phSlug. As a
// secondary signal we also accept exact / prefix matches on post.name.

const PH_ENDPOINT = 'https://api.producthunt.com/v2/api/graphql'

const RECENT_POSTS_QUERY = `
  query RecentPosts($first: Int!, $postedAfter: DateTime!, $after: String) {
    posts(first: $first, postedAfter: $postedAfter, after: $after, order: NEWEST) {
      pageInfo {
        endCursor
        hasNextPage
      }
      edges {
        node {
          id
          name
          slug
          tagline
          description
          url
          createdAt
        }
      }
    }
  }
`

interface PHPost {
  id: string
  name: string
  slug: string
  tagline: string | null
  description: string | null
  url: string
  createdAt: string
}

interface PHPostsResponse {
  data?: {
    posts: {
      pageInfo: { endCursor: string | null; hasNextPage: boolean }
      edges: Array<{ node: PHPost }>
    }
  }
  errors?: Array<{ message: string }>
}

export interface PHFetchOptions {
  lookbackDays?: number
  maxPages?: number
  pageSize?: number
  fetchImpl?: typeof fetch
}

interface PreparedPost {
  raw: PHPost
  productSlug: string | null
  loweredName: string
  publishedAt: Date | null
}

/**
 * Batched adapter — pulls the recent PH firehose once, dispatches matches per
 * competitor. Prefer this in the orchestrator.
 */
export async function fetchPHForCompetitors(
  competitors: CompetitorRef[],
  options: PHFetchOptions = {},
): Promise<Map<string, NormalizedItem[]>> {
  const result = new Map<string, NormalizedItem[]>()
  for (const c of competitors) result.set(c.id, [])

  if (competitors.length === 0) return result

  const posts = await fetchRecentPosts(options)
  if (posts.length === 0) return result

  for (const c of competitors) {
    const matchers = buildMatchers(c)
    if (matchers.names.length === 0 && !matchers.slug) {
      logger.warn(
        { competitorId: c.id, name: c.name },
        'ph: competitor has no matchable identity (no name and no phSlug), skipping',
      )
      continue
    }
    const seen = new Set<string>()
    for (const p of posts) {
      if (seen.has(p.raw.id)) continue
      if (!matchesCompetitor(p, matchers)) continue
      seen.add(p.raw.id)
      result.get(c.id)!.push(toNormalizedItem(p))
    }
  }

  return result
}

/**
 * Per-competitor convenience. Does a full firehose scan internally — when
 * ingesting many competitors, call fetchPHForCompetitors instead so the scan
 * is amortized.
 */
export async function fetchPH(
  competitor: CompetitorRef,
  options: PHFetchOptions = {},
): Promise<NormalizedItem[]> {
  const map = await fetchPHForCompetitors([competitor], options)
  return map.get(competitor.id) ?? []
}

async function fetchRecentPosts(options: PHFetchOptions): Promise<PreparedPost[]> {
  const token = requireEnv('PRODUCT_HUNT_TOKEN')
  const lookbackDays = options.lookbackDays ?? 2
  const maxPages = options.maxPages ?? 6
  const pageSize = options.pageSize ?? 50
  const fetchImpl = options.fetchImpl ?? fetch
  const postedAfter = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()

  const out: PreparedPost[] = []
  let cursor: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const variables: { first: number; postedAfter: string; after?: string } = {
      first: pageSize,
      postedAfter,
    }
    if (cursor) variables.after = cursor

    let response: PHPostsResponse
    try {
      response = await graphqlRequest<PHPostsResponse>(
        fetchImpl,
        token,
        RECENT_POSTS_QUERY,
        variables,
      )
    } catch (err) {
      logger.warn({ err, page }, 'ph: firehose request failed')
      break
    }

    if (response.errors?.length) {
      logger.warn({ page, errors: response.errors }, 'ph: firehose graphql errors')
      break
    }

    const posts = response.data?.posts
    if (!posts) break

    for (const edge of posts.edges) {
      out.push(preparePost(edge.node))
    }

    if (!posts.pageInfo.hasNextPage || !posts.pageInfo.endCursor) break
    cursor = posts.pageInfo.endCursor
  }

  logger.info({ count: out.length, lookbackDays }, 'ph: firehose scan complete')
  return out
}

function preparePost(raw: PHPost): PreparedPost {
  return {
    raw,
    productSlug: extractProductSlug(raw.url),
    loweredName: raw.name.toLowerCase(),
    publishedAt: raw.createdAt ? new Date(raw.createdAt) : null,
  }
}

function extractProductSlug(url: string): string | null {
  try {
    const u = new URL(url)
    const m = u.pathname.match(/^\/products\/([^/]+)\/?$/)
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

interface Matchers {
  names: string[]
  slug: string | null
}

function buildMatchers(c: CompetitorRef): Matchers {
  const names = [c.name.trim().toLowerCase()].filter((n) => n.length > 0)
  return {
    names,
    slug: c.phSlug?.trim().toLowerCase() || null,
  }
}

function matchesCompetitor(p: PreparedPost, m: Matchers): boolean {
  if (m.slug && p.productSlug === m.slug) return true

  for (const candidate of m.names) {
    if (
      p.loweredName === candidate ||
      p.loweredName.startsWith(`${candidate} `) ||
      p.loweredName.startsWith(`${candidate}:`)
    ) {
      return true
    }
  }
  return false
}

function toNormalizedItem(p: PreparedPost): NormalizedItem {
  const title = p.raw.tagline ? `${p.raw.name} — ${p.raw.tagline}` : p.raw.name
  return {
    source: 'ph',
    sourceId: p.raw.id,
    url: p.raw.url,
    title,
    body: p.raw.description,
    publishedAt: p.publishedAt,
  }
}

async function graphqlRequest<T>(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetchImpl(PH_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`PH API ${res.status}: ${text.slice(0, 300)}`)
  }

  return res.json() as Promise<T>
}
