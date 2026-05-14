# Firehose

**Used by:** `src/sources/firehose.ts` (task #6) · scheduled via worker ingestion (task #7)
**Status:** placeholder — adapter not yet implemented

## Canonical docs

- API reference: <https://firehose.com/api-docs>

## Auth

`FIREHOSE_API_KEY` env var. (Procured — already in `.env`.)

## What goes here once #6 lands

- Real endpoint URLs + auth header format (verified by probe)
- Query shape: per-competitor (name + homepage domain) — confirm the actual filter args
- Response schema, normalization mapping → `raw_items`
- Quota model: how it's measured (requests, items, characters?), our daily budget per competitor
- Failure modes: rate-limit response shape, retry guidance
