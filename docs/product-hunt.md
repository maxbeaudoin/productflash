# Product Hunt API v2

**Used by:** `src/sources/ph.ts` (task #3) · scheduled via `src/worker` ingestion job (task #7)
**Probe script:** `scripts/test-source-ph.ts` (end-to-end) + `scripts/test-source-ph-debug.ts` (introspection)

## Canonical docs

- Welcome page: <https://api.producthunt.com/v2/docs>
- API reference: <https://api-v2-docs.producthunt.com/operation/query/>
- Interactive explorer: <https://ph-graph-api-explorer.herokuapp.com/>

Endpoint: `POST https://api.producthunt.com/v2/api/graphql` with `Authorization: Bearer <token>`.

## Auth

Use a **Developer Token** (not OAuth). Create one at <https://www.producthunt.com/v2/oauth/applications> → create application → "Developer Token" section. The redirect URI field is required by the form but unused for developer tokens — any URL works (`http://localhost` is fine).

Token goes in env as `PRODUCT_HUNT_TOKEN`.

## Rate limit

**6250 complexity points per 15-minute window.** Exceeding it returns HTTP 200 with a `rate_limit_reached` error body and `details.reset_in` seconds. Each `posts(first: N)` page costs roughly `N + scalar overhead` — empirically ~50–70 points for `first: 50`. Aggressive debugging burns it fast; conservatively budget ≤ 30 queries per probe session.

## Schema reality (verified 2026-05-14 via introspection)

### Root Query fields

```
collection(id, slug) -> Collection
collections(...) -> CollectionConnection!
comment(id!) -> Comment
post(id, slug) -> Post
posts(featured, postedBefore, postedAfter, topic, order, twitterUrl, url, after, before, first, last) -> PostConnection!
topic(id, slug) -> Topic
topics(followedByUserid, query, order, after, before, first, last) -> TopicConnection!
user(id, username) -> User
viewer -> Viewer
```

**There is no `product` / `products` root query.** PH's website has product pages (`/products/<slug>`) but they are NOT exposed via the API — the "Product" entity isn't part of the GraphQL schema. Each launch ("Post") stands on its own.

### Post fields

```
id, name, slug, tagline, description, url, website, createdAt, scheduledAt, featuredAt,
commentsCount, votesCount, reviewsCount, reviewsRating,
dailyRank, weeklyRank, monthlyRank, yearlyRank,
isVoted, isCollected,
user, userId, makers, media, thumbnail, productLinks,
topics, comments, collections, votes,
latestScore, makerReplies
```

Notably **no `Post.product` field** — confirms no Product entity in the API.

### What we discovered the hard way

- `posts(url:)` filter accepts the argument but empirically returns **0 hits** even for canonical URLs the API itself just returned. Not a usable filter as of 2026-05-14.
- `Post.website` is a redirect URL (`https://www.producthunt.com/r/<token>?utm...`) — **not the actual website**. Don't try to extract the competitor's domain from it.
- `Post.url` looks like `https://www.producthunt.com/products/<product-slug>?utm...`. The `<product-slug>` segment IS the canonical product slug that matches PH's public product-page URL. Parse the path to extract it — this is the only reliable per-product identifier.
- `User` data is **redacted** under a Developer Token: `id=0`, `name="[REDACTED]"`, and `madePosts` / `submittedPosts` return 0 edges. Per-company lookup by username is dead.
- `User.madePosts` accepts `first/after/before/last` but **NOT `order`** (`posts(order:)` does though — easy mistake).

## Matching strategy (current adapter)

Given the constraints above, the API is effectively a **global firehose**. The adapter:

1. Pulls recent posts ONCE via `posts(postedAfter, first, after, order: NEWEST)`, paginated up to `maxPages × pageSize`.
2. Parses `<product-slug>` out of each `Post.url`.
3. For each competitor:
   - **Primary:** match if `productSlugFromUrl === competitor.phSlug` (exact, lowercased).
   - **Secondary:** match if `Post.name` equals competitor name, or starts with `"<name> "` / `"<name>:"`.

The batch fan-out is `fetchPHForCompetitors(competitors, opts) → Map<id, NormalizedItem[]>`. The orchestrator (#7) should prefer the batch form so the firehose is scanned ONCE per ingestion run, not N times. The per-competitor convenience `fetchPH(competitor, opts)` exists but does its own full scan.

## Realistic signal expectations

PH's launch feed skews toward indie / new products. Mature SaaS competitors like Linear, Notion, Vercel rarely post — when they do, it's 1–2× per year. **Zero results for an established competitor is not a bug.** The synthetic-injection test in `scripts/test-source-ph.ts --inject` proves the matcher works against live data even when no seeded competitor is launching today.

## Default options

```ts
{
  lookbackDays: 2,    // ingestion runs daily so 48h covers same-day + safety margin
  maxPages: 6,        // ≈ 300 posts max — well within rate budget
  pageSize: 50,       // max allowed
}
```

## Scaling analysis — does the rate limit constrain us?

**No, not at the scale this PoC targets.** The 6250-points-per-15-min limit looks tight in isolation, but PH is a *shared firehose*, not a per-customer resource. A daily scan with the defaults above costs roughly:

| Calculation | Value |
|---|---|
| Cost per `posts(first: 50)` page | ~50–70 points |
| Daily ingestion: 6 pages | **~360 points** |
| Fraction of one 15-min window | **~6%** |

Adding customers does **not** add PH calls — `fetchPHForCompetitors` scans the firehose once per ingestion run and dispatches matches in-memory. 5 customers × 10 competitors uses the same PH quota as 1 customer × 1 competitor.

**When rate limit DOES matter:**
- Dev iteration: schema probes, repeated debug runs, and `posts(url:)`-style experiments burn quota fast — debug sessions can cross 6250 in 10 min. Use `--dry-run` style flags or cache responses locally when iterating.
- Historical backfill for a new customer (if we ever add it) would be a one-time burst — needs to be paced through pg-boss with retries.
- If PH tightens the limit without notice, we'd want a soft cache + fallback. Out of scope for PoC.

The bigger cost concern at our scale is **Anthropic token spend** (Haiku classify + Sonnet synth) — covered in `SCOPE.md` §9, not here.
