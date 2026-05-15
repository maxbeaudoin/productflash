import { sql } from 'drizzle-orm'
import { fteEvents } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'

// FTE event log writer.
//
// Persists every step the agent takes (planner text, tool_use, tool_result,
// server-side web_search call, lifecycle markers) so the /app/onboarding
// frontend (#29) can replay or tail the run. Each write also emits a
// `pg_notify('fte_events', '<user_id>:<run_id>:<id>')` so tailing clients can
// pick up new rows without polling. The frontend can still fall back to
// polling — NOTIFY is best-effort delivery.

export type FteEventKind =
  | 'run_started'
  | 'planner_text'
  | 'planner_thinking'
  | 'tool_use'
  | 'tool_result'
  | 'tool_error'
  | 'server_tool_use'
  | 'server_tool_result'
  | 'iteration'
  | 'run_finished'
  | 'error'

export interface FteEventPayload {
  [key: string]: unknown
}

export interface FteEventInput {
  userId: string
  runId: string
  kind: FteEventKind
  payload?: FteEventPayload
}

// Durable, block-level events — one row in fte_events per emit. The frontend
// (#29) reads this for replay-on-reconnect and full-history admin views.
export const FTE_EVENTS_CHANNEL = 'fte_events'

// Transient, sub-block deltas — pg_notify-only, never persisted. The frontend
// renders these into the currently-streaming line; when the matching durable
// block-level event lands on FTE_EVENTS_CHANNEL, the line is committed and the
// delta buffer flushed. Reconnecting clients miss in-flight deltas but get
// the final block from FTE_EVENTS_CHANNEL — degraded gracefully, no data loss.
//
// IMPORTANT: LISTEN/NOTIFY does not survive PgBouncer in transaction-pooling
// mode (Neon's `-pooler` endpoint). The SSE handler in #29 must open its
// LISTEN connection against a direct (non-pooler) Neon URL — see the
// `DATABASE_URL_DIRECT` env knob added alongside this work. The worker can
// keep using the pooled URL for INSERT + pg_notify (those are single
// statements that survive the pooler fine).
export const FTE_EVENTS_DELTA_CHANNEL = 'fte_events_delta'

export type FteDeltaKind = 'text_delta' | 'tool_input_delta' | 'block_start'

export interface FteDeltaInput {
  userId: string
  runId: string
  kind: FteDeltaKind
  // `delta` is the new chunk (a few chars for text, a JSON fragment for tool
  // input). Frontend appends to the current buffer; on `block_start` it
  // flushes and begins a new buffer with the given hint.
  delta: string
  // Optional hint for block_start: 'text' | 'tool_use' | 'server_tool_use'.
  blockKind?: string
}

// Compact JSON shape — pg_notify payload caps at 8KB. Field names kept short
// to keep room for the actual delta text.
interface DeltaPayload {
  u: string
  r: string
  k: FteDeltaKind
  d: string
  b?: string
}

export async function emitFteDelta(input: FteDeltaInput): Promise<void> {
  const db = getDb()
  const payload: DeltaPayload = {
    u: input.userId,
    r: input.runId,
    k: input.kind,
    d: input.delta,
  }
  if (input.blockKind) payload.b = input.blockKind

  try {
    await db.execute(
      sql`select pg_notify(${FTE_EVENTS_DELTA_CHANNEL}, ${JSON.stringify(payload)})`,
    )
  } catch (err) {
    // Deltas are best-effort — a NOTIFY failure shouldn't break the agent.
    logger.warn({ err, userId: input.userId, runId: input.runId }, 'fte: delta notify failed')
  }
}

export async function writeFteEvent(input: FteEventInput): Promise<void> {
  const db = getDb()
  const payload = input.payload ?? {}

  try {
    const [row] = await db
      .insert(fteEvents)
      .values({
        userId: input.userId,
        runId: input.runId,
        kind: input.kind,
        payload,
      })
      .returning({ id: fteEvents.id })

    if (row) {
      await db.execute(
        sql`select pg_notify(${FTE_EVENTS_CHANNEL}, ${`${input.userId}:${input.runId}:${row.id}`})`,
      )
    }
  } catch (err) {
    logger.warn(
      { err, userId: input.userId, runId: input.runId, kind: input.kind },
      'fte: failed to write event',
    )
  }
}
