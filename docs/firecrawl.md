# Firecrawl

**Used by:** `src/sources/firecrawl.ts` (task #4) · scheduled via worker ingestion (task #7)
**Status:** placeholder — adapter not yet implemented

## Canonical docs

- API reference: <https://docs.firecrawl.dev/api-reference/introduction>

## Auth

`FIRECRAWL_API_KEY` env var. (Procured — already in `.env`.)

## What goes here once #4 lands

- Which Firecrawl endpoint we use for pricing-page scraping (`/scrape` vs `/crawl`)
- Output format we ask for (markdown / structured) and how we hash/diff it
- Storage: where the latest snapshot lives (DB column? blob?) and the unified-diff emission format
- Skip behavior: competitors without `pricing_url`
- Quota model + observed cost per scrape
