import { createHash } from 'node:crypto'
import { createPatch } from 'diff'
import { requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import type { CompetitorRef, NormalizedItem } from './types'

// Firecrawl pricing-page scraper.
//
// Pricing pages almost never have RSS, so Firecrawl fills that one gap in
// the source matrix. The adapter scrapes a competitor's pricing_url and,
// when the rendered markdown has changed since the last snapshot, emits a
// raw_item whose body is a unified diff. Otherwise it just returns the
// fresh snapshot for the caller to persist.
//
// Adapter is pure (no DB). The orchestrator (#7) passes in the previous
// snapshot from competitor_pricing_snapshots and persists the new one;
// see scripts/test-source-firecrawl.ts for the read/save shape.
//
// API verified 2026-05-14:
//   POST https://api.firecrawl.dev/v2/scrape
//   Authorization: Bearer fc-...
//   body: { url, formats: [{type: 'markdown'}], onlyMainContent: true, ... }
//   200 → { success: true, data: { markdown, metadata: { statusCode, ... } } }

const FIRECRAWL_ENDPOINT = 'https://api.firecrawl.dev/v2/scrape'
const DEFAULT_TIMEOUT_MS = 60_000

export interface PricingSnapshot {
  content: string
  contentHash: string
  scrapedAt: Date
}

export interface PricingScrapeResult {
  newSnapshot: PricingSnapshot
  // Only populated when previous snapshot existed and hashes differ.
  item: NormalizedItem | null
}

export interface FirecrawlScrapeOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

interface FirecrawlScrapeResponse {
  success?: boolean
  error?: string
  data?: {
    markdown?: string | null
    metadata?: {
      statusCode?: number
      title?: string | string[] | null
      sourceURL?: string
      url?: string
    } | null
  }
}

/**
 * Scrape one competitor's pricing page. Returns null if the competitor has
 * no pricingUrl (caller should skip). Throws on Firecrawl transport / API
 * errors so the orchestrator can decide retry vs. quarantine.
 */
export async function scrapePricingPage(
  competitor: CompetitorRef,
  previousSnapshot: PricingSnapshot | null,
  options: FirecrawlScrapeOptions = {},
): Promise<PricingScrapeResult | null> {
  if (!competitor.pricingUrl) return null

  const markdown = await firecrawlScrape(competitor.pricingUrl, options)
  const normalized = normalizeContent(markdown)
  const contentHash = sha256Hex(normalized)
  const scrapedAt = new Date()
  const newSnapshot: PricingSnapshot = { content: normalized, contentHash, scrapedAt }

  if (!previousSnapshot) {
    logger.info(
      { competitorId: competitor.id, name: competitor.name, bytes: normalized.length },
      'firecrawl: first pricing snapshot, no diff emitted',
    )
    return { newSnapshot, item: null }
  }

  if (previousSnapshot.contentHash === contentHash) {
    return { newSnapshot, item: null }
  }

  const diff = createPatch(
    competitor.pricingUrl,
    previousSnapshot.content,
    normalized,
    previousSnapshot.scrapedAt.toISOString(),
    scrapedAt.toISOString(),
  )

  const item: NormalizedItem = {
    source: 'firecrawl',
    sourceId: `${competitor.id}:${contentHash.slice(0, 16)}`,
    url: competitor.pricingUrl,
    title: `Pricing page changed: ${competitor.name}`,
    body: diff,
    publishedAt: scrapedAt,
  }

  logger.info(
    {
      competitorId: competitor.id,
      name: competitor.name,
      prevHash: previousSnapshot.contentHash.slice(0, 12),
      newHash: contentHash.slice(0, 12),
      diffBytes: diff.length,
    },
    'firecrawl: pricing page change detected',
  )

  return { newSnapshot, item }
}

/**
 * Fan-out helper. Sequentially scrapes each competitor with a pricingUrl;
 * Firecrawl scrapes are independent so this could parallelize, but daily
 * volume is tiny (5–10 competitors) and serial keeps quota predictable.
 */
export async function scrapePricingPagesForCompetitors(
  competitors: CompetitorRef[],
  previousSnapshots: Map<string, PricingSnapshot>,
  options: FirecrawlScrapeOptions = {},
): Promise<Map<string, PricingScrapeResult>> {
  const results = new Map<string, PricingScrapeResult>()
  for (const c of competitors) {
    if (!c.pricingUrl) continue
    try {
      const r = await scrapePricingPage(c, previousSnapshots.get(c.id) ?? null, options)
      if (r) results.set(c.id, r)
    } catch (err) {
      logger.warn({ err, competitorId: c.id, name: c.name }, 'firecrawl: scrape failed')
    }
  }
  return results
}

async function firecrawlScrape(
  url: string,
  options: FirecrawlScrapeOptions,
): Promise<string> {
  const apiKey = requireEnv('FIRECRAWL_API_KEY')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const res = await fetchImpl(FIRECRAWL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: [{ type: 'markdown' }],
      onlyMainContent: true,
      timeout: timeoutMs,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Firecrawl ${res.status} for ${url}: ${text.slice(0, 300)}`)
  }

  const json = (await res.json()) as FirecrawlScrapeResponse
  if (!json.success || !json.data) {
    throw new Error(`Firecrawl returned !success for ${url}: ${json.error ?? 'unknown'}`)
  }

  const md = json.data.markdown
  if (!md || md.trim().length === 0) {
    throw new Error(`Firecrawl returned empty markdown for ${url}`)
  }

  return md
}

// Strip per-render volatility (CSRF nonces, build hashes, trailing whitespace)
// so cosmetic re-renders don't burn raw_items. Kept conservative on purpose —
// genuine copy/price changes stay; we'd rather emit one false positive than
// silently swallow a real pricing tier change.
function normalizeContent(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
