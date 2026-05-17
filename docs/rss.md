# RSS

**Used by:** `src/sources/rss.ts` (task #5) · scheduled via worker ingestion (task #7) · autodetect helper consumed by signup (task #15)
**Status:** implemented 2026-05-14 — `rss-parser` wrapper + path-probe autodetect

## Canonical specs

- RSS 2.0: <https://www.rssboard.org/rss-specification>
- Atom 1.0: <https://datatracker.ietf.org/doc/html/rfc4287>
- Discovery convention (`<link rel="alternate" type="application/(rss|atom)+xml">`): <https://www.rssboard.org/rss-autodiscovery>

## Parser choice

`rss-parser` (3.13.0). Handles RSS 2.0 + Atom 1.0 transparently and surfaces the union of both vocabularies in one `Item` shape (`isoDate` normalizes `pubDate` / `updated`, `contentSnippet` strips HTML from `content` / `summary`). Verified against the seven seeded competitors — covers `linear.app/changelog/rss.xml` (RSS), `vercel.com/atom` (Atom), `posthog.com/rss.xml` (RSS), etc.

We do the HTTP fetch ourselves (`fetchImpl` injection + `AbortController` timeout + real UA) and hand the XML to `parser.parseString`. `parser.parseURL` is avoided because its timeout is unreliable across redirects.

## Dedupe key

`sourceId = guid || link`. Both empty → drop item (no stable identity). Per RSS 2.0 §`<guid>` is the canonical key when present; Atom's `<id>` surfaces as `guid` via rss-parser. Items with only a `link` (some changelog feeds omit guid) still dedupe correctly because the link is stable per post.

The `raw_items` table has `unique(source, source_id)` so duplicate inserts no-op via `onConflictDoNothing` in the ingestion orchestrator (#7). Probe script `--dedupe` mode confirms two consecutive runs produce identical sourceId sets.

## Autodetect heuristic

Used at signup (#15) when a user enters a homepage URL without an RSS URL.

1. **`<link rel="alternate">` sniff** — fetch homepage HTML, regex-scan `<head>` for an alternate-feed declaration. This is the standard mechanism and resolves most modern SaaS homepages correctly.
2. **Path probe** — try common suffixes against the homepage origin, in order:
   - `/feed`, `/rss`, `/rss.xml`, `/feed.xml`
   - `/atom`, `/atom.xml`
   - `/changelog/rss.xml`, `/changelog.rss`
   - `/blog/feed`, `/blog/rss`, `/blog/rss.xml`
3. For each candidate, fetch + parse + require ≥1 item. First match wins.

Capped at `maxProbes=16` so a homepage with many `<link rel>` declarations doesn't fan out unboundedly.

## Known quirks

- **UA matters**: some Cloudflare-fronted changelog hosts return 403 to bare `node-fetch`. Default UA is `Mozilla/5.0 (compatible; ProductFlashBot/0.1; +https://productflash.ai)`.
- **Body field preference**: we surface `contentSnippet` (plain text) over `content` (HTML) because Haiku doesn't need markup and snippets cut token cost ~3x.
- **Missing `pubDate`**: rss-parser leaves `isoDate` undefined; we persist `publishedAt = null` and let the orchestrator fall back to `ingestedAt` when sorting recency.
- **Atom feeds without `<link rel="alternate">`** declare their own URL in `<id>` — autodetect won't trip on this, but the path probe catches the common `/atom`/`/atom.xml` cases.

## Rate limits

None imposed by RSS itself; we cap fan-out at concurrency 6 in `fetchRSSForCompetitors` to be polite. At 5–10 competitors this is irrelevant.

## Probe

```
pnpm tsx scripts/test-source-rss.ts               # fetch + dedupe check
pnpm tsx scripts/test-source-rss.ts --autodetect  # also run autodetect for each seeded homepage
```

## Verified against live feeds (2026-05-14)

| Competitor | Seeded `rss_url`                       | Reality                                                                                 |
| ---------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| Vercel     | `https://vercel.com/atom`              | ✅ Atom feed, 1154 items                                                                |
| PostHog    | `https://posthog.com/rss.xml`          | ✅ RSS feed, 247 items                                                                  |
| Resend     | `https://resend.com/changelog/rss.xml` | ❌ 404 — autodetect finds `https://resend.com/blog/index.xml`                           |
| Amplitude  | (none)                                 | ✅ autodetect finds `https://amplitude.com/feed`                                        |
| Linear     | `https://linear.app/changelog/rss.xml` | ❌ 404 — no RSS at common paths, no `<link rel>` declaration. Relies on PH + Firecrawl. |
| Notion     | `https://www.notion.so/blog/rss.xml`   | ❌ 404 — same situation. Relies on PH + Firecrawl.                                      |
| Attio      | `https://attio.com/changelog/rss.xml`  | ❌ 404 — same. Relies on PH + Firecrawl.                                                |

Dedupe verified: two consecutive runs across the two working feeds produced identical `sourceId` sets (stable=2, drifted=0). Seed fixes for the wrong URLs belong to task #8.
