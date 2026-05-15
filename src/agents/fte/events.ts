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

export const FTE_EVENTS_CHANNEL = 'fte_events'

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
