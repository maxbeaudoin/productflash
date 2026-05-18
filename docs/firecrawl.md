# Firecrawl

**Used by:** `src/sources/firecrawl.ts` (task #4) · scheduled via worker ingestion (task #7)
**Probe script:** `scripts/test-source-firecrawl.ts` (end-to-end against real Firecrawl + DB)

## Canonical docs

- API reference: <https://docs.firecrawl.dev/api-reference/introduction>
- Scrape endpoint: <https://docs.firecrawl.dev/api-reference/endpoint/scrape>

Endpoint: `POST https://api.firecrawl.dev/v2/scrape` with `Authorization: Bearer fc-...`.

## Auth

`FIRECRAWL_API_KEY` env var. (Procured — already in `.env`.)

## What we use it for

**Pricing-page change detection only.** Pricing pages almost never have RSS, so Firecrawl fills that one source-matrix gap. RSS handles changelogs/blogs, PH handles launches, Firehose handles broader news; Firecrawl is the synthetic feed for the one high-value static surface.

Scope is deliberately narrow for the PoC — see [`SCOPE.md`](../SCOPE.md) §3. Marketing-page diff and homepage-as-RSS-fallback are explicitly out.

## Request shape

We call `/v2/scrape` with the minimum useful payload:

```json
{
  "url": "<competitor.pricingUrl>",
  "formats": [{ "type": "markdown" }],
  "onlyMainContent": true,
  "timeout": 60000
}
```

`onlyMainContent: true` strips nav/header/footer chrome — critical for diff stability since global nav rebuilds shouldn't look like pricing changes.

## Response (verified 2026-05-14)

```ts
{ success: boolean
  data: {
    markdown: string | null
    metadata: { title, sourceURL, url, statusCode, ... } | null
    // also: html, rawHtml, links, screenshot, etc. — all null when not requested
  }
  error?: string }
```

We read `data.markdown` only. Metadata is logged for debugging but not persisted.

## Storage + diff strategy

- **Snapshot table:** `competitor_pricing_snapshots(competitor_id PK, content, content_hash, scraped_at)`. One row per competitor — we only keep the latest. Migration: `drizzle/0001_sticky_cerebro.sql`.
- **Hash:** sha256 of normalized markdown (CRLF→LF, trailing whitespace trimmed, runs of blank lines collapsed). Conservative normalization — we'd rather emit one false-positive diff than swallow a real price change.
- **Diff format:** standard unified diff via `diff` package's `createPatch()`. Filename is the pricing URL; old/new headers are ISO timestamps.
- **First scrape per competitor:** snapshot stored, no `raw_item` emitted (nothing to diff against).
- **Subsequent unchanged scrapes:** snapshot timestamp updated, no `raw_item`.
- **Subsequent changed scrapes:** new snapshot stored AND a `raw_item` is emitted with the unified diff in `body`.

## Adapter shape

Adapter is **pure** — no DB. Persistence lives in `src/sources/firecrawl-store.ts`:

```ts
scrapePricingPage(competitor, previousSnapshot, options)
  → { newSnapshot, item: NormalizedItem | null } | null  // null when no pricingUrl

scrapePricingPagesForCompetitors(competitors, prevSnapshots, options)
  → Map<competitorId, { newSnapshot, item }>             // skips no-pricingUrl + failures

loadLatestPricingSnapshots(db, competitorIds) → Map<id, PricingSnapshot>
saveLatestPricingSnapshot(db, competitorId, snapshot)
```

The orchestrator (#7) loads prior snapshots, calls the batch adapter, then for each result writes the snapshot back AND inserts the `raw_item` (when present) with `onConflictDoNothing` on `(source, source_id)`.

## raw_item shape

| field          | value                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `source`       | `'firecrawl'`                                                                                                            |
| `source_id`    | `${competitor_id}:${newContentHash[:16]}` — collision-proof per competitor; cyclic A→B→A re-emits B but not the second A |
| `url`          | competitor.pricingUrl                                                                                                    |
| `title`        | `Pricing page changed: <competitor.name>`                                                                                |
| `body`         | unified diff (full) — Postgres `text`, no length cap                                                                     |
| `published_at` | scrape time (pricing pages don't expose a real publication date)                                                         |

## Quotas + cost

Per scrape ≈ 1 Firecrawl credit. Daily ingestion = N competitors with `pricing_url`. At PoC scale (5–10 competitors) this is trivial — well under any plan's daily allowance. When a competitor has no `pricing_url` we skip; cost is competitor-cardinality-bound, not user-cardinality-bound.

## Failure handling

Firecrawl errors (timeout, 4xx, 5xx, empty markdown) throw from the per-competitor scrape function. The batch helper catches and logs, so one broken pricing URL doesn't poison the run. The orchestrator's pg-boss retry policy decides whether to re-attempt the batch.

## Probe script

```bash
pnpm tsx scripts/test-source-firecrawl.ts            # normal run
pnpm tsx scripts/test-source-firecrawl.ts --reset    # wipe snapshots first
pnpm tsx scripts/test-source-firecrawl.ts --tamper   # mutate stored snapshots so NEXT run emits a diff
```

Useful sequences:

- `--reset` then plain run: verifies "first snapshot, no diff" path.
- Two plain runs in a row: verifies "no change, no diff" path.
- Plain run then `--tamper` then plain run: verifies the diff emission path without waiting for a real pricing change.
