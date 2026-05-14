import { requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import type { CompetitorRef, NormalizedItem } from './types'

// Firehose source adapter.
//
// Firehose is a rule-based SSE stream, not a request/response API. Setup
// happens via scripts/firehose-bootstrap-tap.ts (one-off) and
// scripts/firehose-sync-rules.ts (whenever competitors change). Daily
// ingestion is just stream consumption:
//
//   GET /v1/stream?since=24h&timeout=60&limit=2000
//
// Each event we receive includes a `query_id` that ties it back to the
// rule that matched. Rules carry `tag = competitor.id`, so on adapter
// start we GET /v1/rules once to build a query_id → competitor.id map and
// then dispatch each stream event to the matching competitor's
// NormalizedItem[].
//
// API verified 2026-05-14 via WebFetch of https://firehose.com/api-docs.
// See docs/firehose.md for the schema details.
//
// Buffer caveat: rules only match events going forward from rule-creation
// time. A brand-new rule (or a sleepy competitor) returns zero — that's
// not a bug. The probe and orchestrator both treat zero as "fine, log it"
// rather than an error.

const FIREHOSE_BASE = 'https://api.firehose.com/v1'
const DEFAULT_SINCE = '24h'
const DEFAULT_TIMEOUT_SEC = 60
const DEFAULT_LIMIT = 2000
const DEFAULT_BODY_CAP_BYTES = 2048

export interface FirehoseFetchOptions {
  /** Replay window passed to the stream — e.g. '24h', '1h', '15m'. */
  sinceWindow?: string
  /** Stream timeout in seconds (1–300). Server closes the stream at this point. */
  timeoutSec?: number
  /** Server closes the stream after N matched events. 1–10000. */
  limit?: number
  /** Truncate document.markdown to this many bytes before storing. */
  bodyByteCap?: number
  fetchImpl?: typeof fetch
}

interface FirehoseRule {
  id: string
  value: string
  tag?: string | null
}

interface ListRulesResponse {
  data: FirehoseRule[]
}

interface StreamDocument {
  url?: string
  title?: string
  publish_time?: string
  markdown?: string | null
}

interface StreamUpdateEvent {
  tap_id?: string
  query_id?: string
  matched_at?: string
  document?: StreamDocument
}

interface StreamErrorEvent {
  message?: string
}

export async function fetchFirehoseForCompetitors(
  competitors: CompetitorRef[],
  options: FirehoseFetchOptions = {},
): Promise<Map<string, NormalizedItem[]>> {
  const result = new Map<string, NormalizedItem[]>()
  for (const c of competitors) result.set(c.id, [])
  if (competitors.length === 0) return result

  const token = requireEnv('FIREHOSE_TAP_TOKEN')
  const fetchImpl = options.fetchImpl ?? fetch
  const sinceWindow = options.sinceWindow ?? DEFAULT_SINCE
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  const limit = options.limit ?? DEFAULT_LIMIT
  const bodyCap = options.bodyByteCap ?? DEFAULT_BODY_CAP_BYTES

  const competitorIds = new Set(competitors.map((c) => c.id))

  let queryToCompetitor: Map<string, string>
  try {
    queryToCompetitor = await loadQueryMap(fetchImpl, token, competitorIds)
  } catch (err) {
    logger.warn({ err }, 'firehose: failed to load rules, returning empty result')
    return result
  }

  if (queryToCompetitor.size === 0) {
    logger.warn(
      { competitors: competitors.length },
      'firehose: no tagged rules match the requested competitors — did you run scripts/firehose-sync-rules.ts?',
    )
    return result
  }

  const perCompetitorSeen = new Map<string, Set<string>>()
  for (const id of queryToCompetitor.values()) perCompetitorSeen.set(id, new Set())

  const started = Date.now()
  let total = 0
  try {
    for await (const event of streamEvents(fetchImpl, token, {
      sinceWindow,
      timeoutSec,
      limit,
    })) {
      if (event.kind === 'error') {
        logger.warn({ message: event.message }, 'firehose: stream error event, closing')
        break
      }
      const competitorId = queryToCompetitor.get(event.queryId)
      if (!competitorId) continue

      const item = toNormalizedItem(event.document, bodyCap)
      if (!item) continue

      const seen = perCompetitorSeen.get(competitorId)!
      if (seen.has(item.sourceId)) continue
      seen.add(item.sourceId)
      result.get(competitorId)!.push(item)
      total++
    }
  } catch (err) {
    logger.warn({ err }, 'firehose: stream consumption failed, returning partial result')
  }

  const perCompetitor: Record<string, number> = {}
  for (const c of competitors) perCompetitor[c.id] = result.get(c.id)!.length

  logger.info(
    {
      source: 'firehose',
      competitors: competitors.length,
      items: total,
      perCompetitor,
      durationMs: Date.now() - started,
      sinceWindow,
      limit,
    },
    'firehose: stream done',
  )

  return result
}

export async function fetchFirehose(
  competitor: CompetitorRef,
  options: FirehoseFetchOptions = {},
): Promise<NormalizedItem[]> {
  const map = await fetchFirehoseForCompetitors([competitor], options)
  return map.get(competitor.id) ?? []
}

async function loadQueryMap(
  fetchImpl: typeof fetch,
  token: string,
  competitorIds: Set<string>,
): Promise<Map<string, string>> {
  const res = await fetchImpl(`${FIREHOSE_BASE}/rules`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`GET /rules ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  const json = (await res.json()) as ListRulesResponse
  const out = new Map<string, string>()
  for (const r of json.data ?? []) {
    if (typeof r.tag !== 'string') continue
    if (!competitorIds.has(r.tag)) continue
    out.set(r.id, r.tag)
  }
  return out
}

// --- SSE consumption ----------------------------------------------------

type ParsedEvent =
  | { kind: 'update'; queryId: string; document: StreamDocument }
  | { kind: 'error'; message: string }

interface StreamParams {
  sinceWindow: string
  timeoutSec: number
  limit: number
}

async function* streamEvents(
  fetchImpl: typeof fetch,
  token: string,
  params: StreamParams,
): AsyncGenerator<ParsedEvent> {
  const url = new URL(`${FIREHOSE_BASE}/stream`)
  url.searchParams.set('since', params.sinceWindow)
  url.searchParams.set('timeout', String(params.timeoutSec))
  url.searchParams.set('limit', String(params.limit))

  // Client-side safety net: if the server forgets to close the stream we
  // tear it down 20% past the server timeout. Mirrors RSS adapter's pattern.
  const controller = new AbortController()
  const guardMs = Math.ceil(params.timeoutSec * 1000 * 1.2)
  const guardTimer = setTimeout(() => controller.abort(), guardMs)

  let res: Response
  try {
    res = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(guardTimer)
    throw err
  }

  if (!res.ok) {
    clearTimeout(guardTimer)
    const body = await res.text().catch(() => '')
    throw new Error(`GET /stream ${res.status}: ${body.slice(0, 300)}`)
  }
  if (!res.body) {
    clearTimeout(guardTimer)
    throw new Error('GET /stream: response has no body')
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        if (buffer.length > 0) {
          const tail = parseFrame(buffer)
          if (tail) yield tail
        }
        return
      }
      buffer += decoder.decode(value, { stream: true })
      // SSE frames are delimited by a blank line (\n\n). The spec also
      // accepts \r\n\r\n — normalize first.
      buffer = buffer.replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
      }
    }
  } finally {
    clearTimeout(guardTimer)
    try {
      await reader.cancel()
    } catch {
      // ignore
    }
  }
}

function parseFrame(frame: string): ParsedEvent | null {
  let eventName = 'message'
  let dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.length === 0) continue
    if (line.startsWith(':')) continue // SSE comment
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const rawValue = colon === -1 ? '' : line.slice(colon + 1)
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
    // id / retry: ignored — daily batch run doesn't need resume.
  }
  if (dataLines.length === 0) return null

  const dataStr = dataLines.join('\n')
  let payload: unknown
  try {
    payload = JSON.parse(dataStr)
  } catch {
    logger.debug({ dataStr: dataStr.slice(0, 200) }, 'firehose: skipping unparseable data frame')
    return null
  }

  if (eventName === 'error') {
    const e = payload as StreamErrorEvent
    return { kind: 'error', message: e?.message ?? 'unknown error event' }
  }

  const u = payload as StreamUpdateEvent
  if (!u.query_id || !u.document) return null
  return { kind: 'update', queryId: u.query_id, document: u.document }
}

function toNormalizedItem(doc: StreamDocument, bodyCap: number): NormalizedItem | null {
  const url = doc.url?.trim()
  if (!url) return null
  const title = doc.title?.trim() || '(untitled)'
  const body = truncate(doc.markdown ?? null, bodyCap)
  const publishedAt = parseDate(doc.publish_time)

  return {
    source: 'firehose',
    sourceId: url,
    url,
    title,
    body,
    publishedAt,
  }
}

function truncate(s: string | null, cap: number): string | null {
  if (s == null) return null
  if (s.length <= cap) return s
  return s.slice(0, cap)
}

function parseDate(input: string | undefined): Date | null {
  if (!input) return null
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}
