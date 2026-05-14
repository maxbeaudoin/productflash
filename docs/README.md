# /docs — vendor API knowledge base

Source-of-truth notes on the external APIs Product Flash integrates with. Read the relevant file **before writing or modifying** the adapter for that source. Each file captures:

- Auth requirements (token format, scopes, where to get one)
- Doc URL (canonical)
- Real schema details — argument names, returned shapes, quirks — that have been verified by hitting the live API, not guessed
- Rate limits + quota model
- Working / non-working query patterns we've discovered
- The matching strategy we use, and why

These notes are not auto-loaded; CLAUDE.md points here so future sessions know to consult them on demand.

| Source | File | Adapter | Used by task |
|---|---|---|---|
| Product Hunt | [product-hunt.md](./product-hunt.md) | `src/sources/ph.ts` | #3, #7 |
| RSS | [rss.md](./rss.md) | `src/sources/rss.ts` | #5, #7 |
| Firehose | [firehose.md](./firehose.md) | `src/sources/firehose.ts` | #6, #7 |
| Firecrawl | [firecrawl.md](./firecrawl.md) | `src/sources/firecrawl.ts` | #4, #7 |

The RSS / Firehose / Firecrawl docs are placeholders until their adapter tasks (#5, #6, #4) land.

## Conventions

- When you learn a new fact about a source by hitting the live API (a working query, a field that's redacted, a rate-limit detail), append it to that source's doc with a date stamp. Don't rely on training-data recall.
- Probe scripts live in `scripts/test-source-<name>.ts` and stay checked in as a permanent debugging aid.
- If a doc says "verified <date>" against a particular field, treat it as authoritative; if it's older than the adapter has changed, re-probe before extending behavior.
