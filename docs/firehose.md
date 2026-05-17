# Firehose

**Used by:** `src/sources/firehose.ts` (task #6) · scheduled via worker ingestion (task #7)
**Canonical docs:** https://firehose.com/api-docs (HTML)
**Base URL:** `https://api.firehose.com/v1`

## TL;DR

Firehose is **not** a request/response API like Product Hunt or Firecrawl. It's a rule-based SSE stream:

1. Create a **tap** (one-off, with management key) → returns a tap token.
2. Create up to **25 rules per organization** on the tap (with tap token). Each rule is a Lucene query plus an optional `tag` string.
3. Drain the SSE stream — each matching page in Firehose's pipeline produces an event tagged with the `query_id` of the rule that matched.

In this codebase: one tap, one rule per competitor with `tag = competitor.id`. The daily orchestrator (task #7) drains the last 24h of events and dispatches per-tag.

## Auth — two keys

| Key        | Env var                   | Prefix | What can it do                         | Used by                                                     |
| ---------- | ------------------------- | ------ | -------------------------------------- | ----------------------------------------------------------- |
| Management | `FIREHOSE_MANAGEMENT_KEY` | `fhm_` | Create/delete taps                     | `scripts/firehose-bootstrap-tap.ts` only                    |
| Tap token  | `FIREHOSE_TAP_TOKEN`      | `fh_`  | Manage rules + read stream on this tap | `scripts/firehose-sync-rules.ts`, `src/sources/firehose.ts` |

The tap is identified by the tap token itself — no separate `tap_id` is needed on rule or stream calls. Both keys are sent as `Authorization: Bearer <key>`.

## Endpoints (verified 2026-05-14)

### `POST /v1/taps` — create tap

```json
// Request
{ "name": "productflash" }

// Response 201
{
  "data": { "id": "<uuid>", "name": "...", "token_prefix": "fh_abc", "created_at": "..." },
  "token": "fh_<full-token>"
}
```

The full `token` is shown **once**; Firehose stores only a hashed version. Lose it → recreate the tap.

### `GET /v1/rules` — list rules

```json
{
  "data": [
    { "id": "<id>", "value": "<lucene>", "tag": "<string|null>" }
  ],
  "meta": { "count": N }
}
```

Rules with `nsfw` / `quality` flags can also be returned but we don't currently rely on them.

### `POST /v1/rules` — create rule

```json
// Request
{ "value": "<lucene>", "tag": "<string, optional, ≤255 chars>", "nsfw": false, "quality": true }

// Response 201
{ "data": { "id": "<id>", "value": "...", "tag": "..." } }
```

### `PUT /v1/rules/:id` — update rule (partial)

Same body shape; supports partial updates. Use to change `value` or `tag` in place.

### `DELETE /v1/rules/:id` — delete rule

Returns `204 No Content`.

### `GET /v1/stream` — SSE event stream

Query params:

| Param     | Type   | Default | Notes                                                        |
| --------- | ------ | ------- | ------------------------------------------------------------ |
| `since`   | string | —       | Relative window: `5m`, `1h`, `24h`. Replays buffered events. |
| `timeout` | int    | 300     | Connection duration in seconds (1–300).                      |
| `limit`   | int    | —       | Server closes the stream after N matched events (1–10000).   |
| `offset`  | int    | —       | Exact Kafka offset to resume from (we don't use).            |

Headers: `Authorization: Bearer fh_...`, `Accept: text/event-stream`.

Server resumption via `Last-Event-ID` header is supported but not used — daily batch with `since=24h` overlap is simpler, and the DB's `(source, source_id)` unique constraint dedupes anyway.

### Event shape

```json
// event: update (the default)
{
  "tap_id": "<tap uuid>",
  "query_id": "<rule id>",
  "matched_at": "<ISO-8601>",
  "document": {
    "url": "https://...",
    "title": "...",
    "publish_time": "<ISO-8601 local datetime>",
    "markdown": "...",
    "page_category": ["..."],
    "page_types": ["..."],
    "language": "en",
    "diff": { "chunks": [{ "typ": "ins|del", "text": "..." }] }
  }
}

// event: error
{ "message": "..." }
```

`document.diff` is present when Firehose detected a content change between crawls — useful for spotting silent marketing-page updates. We don't surface it specifically in v1; the full `markdown` plus the `matched_at` is enough for Haiku to classify downstream.

## Rate limits + quota

| Endpoint      | Limit                   |
| ------------- | ----------------------- |
| `/v1/rules`   | 60 req/min              |
| `/v1/stream`  | 30 connections/min      |
| Per-org rules | **25 total** (hard cap) |

429 over the limit. No explicit "quota remaining" header documented. We log per-run counts via Pino (`source: 'firehose', items, perCompetitor, durationMs`) — sufficient for the PoC's volume (1 run/day × 5–10 competitors). Revisit if we ever push the daily orchestrator above multiple-runs-per-hour.

## Adapter behavior

`src/sources/firehose.ts`:

- Loads `GET /v1/rules` once at start; builds `Map<query_id, competitor_id>` filtered to the input competitor set. Untagged rules and rules tagged with strings that aren't competitor.ids are ignored — manual rules in the Firehose UI don't poison results.
- Opens `GET /v1/stream?since=24h&timeout=60&limit=2000`.
- Manually parses SSE frames (blank-line delimited, `event:` and `data:` fields). No `eventsource` package.
- `error` event → log warn, close stream gracefully, return partial result.
- Maps `document` → `NormalizedItem`:
  - `source: 'firehose'`
  - `sourceId: document.url` (canonical URL — naturally dedupes if multiple rules match the same page)
  - `body`: `document.markdown` truncated at 2KB (configurable; full content isn't needed for classification)
  - `publishedAt`: parsed from `document.publish_time`; null on parse failure

## Buffer gotcha — fresh rules return zero

Rules only match events **from creation time forward**. A brand-new rule has an empty 24h buffer. This is not a bug — both the orchestrator and the probe (`scripts/test-source-firehose.ts`) treat zero events as a warning, not a failure, on the basis of stream-connect success.

Re-probe a few hours after a competitor is added (or any rule sync) to confirm matches start arriving.

## Lucene query template (v1)

For each competitor:

```
(title:"<name>" OR domain:<domain>) AND language:en
```

- `<name>` is `competitor.name` as a phrase query (escape `\` and `"`).
- `<domain>` is the registrable domain extracted from `competitor.homepageUrl` (strip `www.`).
- `language:en` keeps signal-to-noise reasonable in v1 — revisit once we have real data.

Tuning per competitor (e.g., excluding common false-positive matches for ambiguous names like "Linear") is intentionally deferred until task #8 surfaces signal-to-noise problems.

## Scripts

| Script                      | Purpose                                                                         | Frequency                      |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `firehose-bootstrap-tap.ts` | Create the tap, print tap token                                                 | Once per environment           |
| `firehose-sync-rules.ts`    | Reconcile rules vs. competitors table (dry-run by default; `--apply` to mutate) | After every competitors change |
| `test-source-firehose.ts`   | E2E probe; `--twice` for dedupe check across runs                               | Ad-hoc                         |
