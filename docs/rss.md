# RSS

**Used by:** `src/sources/rss.ts` (task #5) · scheduled via worker ingestion (task #7)
**Status:** placeholder — adapter not yet implemented

## Canonical docs

- RSS 2.0 spec: <https://www.rssboard.org/rss-specification>
- Atom 1.0 spec: <https://datatracker.ietf.org/doc/html/rfc4287>

## What goes here once #5 lands

- Choice of parser (e.g., `feedparser`, `fast-xml-parser`, etc.) and why
- Quirks per platform: which competitor blogs use Atom vs RSS, missing `pubDate` handling, GUID vs link for dedupe
- Autodetect heuristic — which `/feed`, `/rss`, `/changelog.rss`, `/blog/feed` paths actually resolve for our seeded competitors
- Encoding gotchas, HTML in `<description>`, namespacing
