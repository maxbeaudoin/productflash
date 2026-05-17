import type PgBoss from 'pg-boss'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { digests, users as usersTable } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'
import { SEND_QUEUE, type SendJobData } from './send'

// Per-TZ send dispatcher (#17).
//
// Runs hourly at :00 UTC. For each active user with an unsent digest,
// computes their *local* time using `users.tz` (IANA name like
// `America/New_York`). Enqueues a send job when:
//   - local hour matches DEFAULT_SEND_HOUR (~7am), AND
//   - local day-of-week is Mon-Fri (weekends are intentionally quiet —
//     Monday's digest carries the weekend lookback via synthesize, see
//     #17 product rule).
//
// Per-digest `singletonKey` on the SEND_QUEUE enqueue keeps a missed
// hour + replay (e.g. worker restart at 06:58, recovers at 07:02) from
// double-queueing the same digest. The send handler itself bails when
// `digests.sent_at IS NOT NULL` as a second safety net.
//
// Users with `users.tz` unset default to UTC — picks up the same 7am
// dispatch hour, which is a sensible neutral until they confirm their
// profile (the FTE flow doesn't currently populate `tz`; browser-locale
// capture is a follow-up).

export const SEND_DISPATCH_QUEUE = 'send-dispatch'
export const SEND_DISPATCH_CRON = '0 * * * *' // every hour at :00 UTC

const DEFAULT_SEND_HOUR = 7
const FALLBACK_TZ = 'UTC'

export interface SendDispatchOptions {
  // Override the now() for tests / manual invocations.
  now?: Date
  // Override the target hour (0–23). Lets `pnpm send:dispatch --hour 13`
  // flush at an arbitrary time without waiting for the scheduled bucket.
  targetHour?: number
  // When true, skip the Mon-Fri filter — used by manual dispatch to flush
  // a forgotten weekend digest. The synthesize side still gates production
  // of weekend digests, so this is mostly an escape hatch.
  includeWeekends?: boolean
  // When true, don't actually enqueue — just log what would be enqueued.
  dryRun?: boolean
}

export interface SendDispatchMetrics {
  candidates: number
  enqueued: number
  skippedHour: number
  skippedWeekend: number
  skippedBadTz: number
  durationMs: number
}

export async function runSendDispatch(
  boss: PgBoss | null,
  options: SendDispatchOptions = {},
): Promise<SendDispatchMetrics> {
  const started = Date.now()
  const db = getDb()
  const now = options.now ?? new Date()
  const targetHour = options.targetHour ?? DEFAULT_SEND_HOUR
  const includeWeekends = options.includeWeekends ?? false
  const dryRun = options.dryRun ?? false

  // Pull one unsent digest per active user — newest first. If a user has
  // multiple unsent (rare: a crashed send) the freshest one is what they
  // should be reading; older unsents become orphans that the manual
  // `pnpm send:run` flush can mop up.
  const rows = await db
    .select({
      digestId: digests.id,
      userId: digests.userId,
      email: usersTable.email,
      tz: usersTable.tz,
      createdAt: digests.createdAt,
    })
    .from(digests)
    .innerJoin(usersTable, eq(usersTable.id, digests.userId))
    .where(
      and(
        isNull(digests.sentAt),
        eq(usersTable.status, 'active'),
      ),
    )
    .orderBy(sql`${digests.createdAt} desc`)

  let enqueued = 0
  let skippedHour = 0
  let skippedWeekend = 0
  let skippedBadTz = 0
  const seenUsers = new Set<string>()

  for (const row of rows) {
    // Only the newest unsent digest per user is considered for dispatch.
    if (seenUsers.has(row.userId)) continue
    seenUsers.add(row.userId)

    const tz = row.tz ?? FALLBACK_TZ
    let local: { hour: number; weekday: number }
    try {
      local = computeLocal(now, tz)
    } catch (err) {
      logger.warn(
        { userId: row.userId, tz, err },
        'send-dispatch: unrecognized timezone — skipping',
      )
      skippedBadTz++
      continue
    }

    if (local.hour !== targetHour) {
      skippedHour++
      continue
    }
    if (!includeWeekends && (local.weekday === 6 || local.weekday === 0)) {
      // Sat=6, Sun=0 — keep weekends quiet by default.
      skippedWeekend++
      continue
    }

    if (dryRun) {
      logger.info(
        { digestId: row.digestId, userId: row.userId, email: row.email, tz, localHour: local.hour },
        'send-dispatch: would enqueue (dry-run)',
      )
      enqueued++
      continue
    }

    if (!boss) {
      throw new Error('send-dispatch: boss client required when dryRun=false')
    }

    // singletonKey: digestId so a hot-loop retry of the dispatcher (or an
    // unexpected double-firing of the cron) doesn't enqueue the same
    // digest twice. The send handler also bails on sent_at, so two layers.
    const payload: SendJobData = { digestId: row.digestId }
    const jobId = await boss.send(SEND_QUEUE, payload, {
      singletonKey: row.digestId,
    })
    if (jobId) {
      enqueued++
      logger.info(
        { digestId: row.digestId, userId: row.userId, email: row.email, tz, jobId },
        'send-dispatch: enqueued',
      )
    } else {
      // pg-boss returns null when a singleton with the same key already
      // exists in the queue — already enqueued for this digest, fine.
      logger.info(
        { digestId: row.digestId, userId: row.userId },
        'send-dispatch: already queued (singleton collision)',
      )
    }
  }

  const metrics: SendDispatchMetrics = {
    candidates: seenUsers.size,
    enqueued,
    skippedHour,
    skippedWeekend,
    skippedBadTz,
    durationMs: Date.now() - started,
  }

  logger.info(metrics, 'send-dispatch: run complete')
  captureServerEvent('worker', 'send_dispatch_run', {
    candidates: metrics.candidates,
    enqueued: metrics.enqueued,
    skipped_hour: metrics.skippedHour,
    skipped_weekend: metrics.skippedWeekend,
    skipped_bad_tz: metrics.skippedBadTz,
    duration_ms: metrics.durationMs,
  })
  return metrics
}

// Intl.DateTimeFormat is the cleanest way to project a UTC instant into
// an IANA zone without pulling in date-fns-tz. Returns hour as 0–23 and
// weekday as 0=Sunday … 6=Saturday (matches Date.prototype.getDay).
export function computeLocal(now: Date, tz: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(now)
  const hourPart = parts.find((p) => p.type === 'hour')?.value
  const weekdayPart = parts.find((p) => p.type === 'weekday')?.value
  if (!hourPart || !weekdayPart) {
    throw new Error(`could not extract hour/weekday for tz ${tz}`)
  }
  // 'en-US' with hour12: false renders midnight as "24" rather than "00"
  // in some node versions — normalize.
  const hour = Number(hourPart) % 24
  const weekday = WEEKDAY_INDEX[weekdayPart]
  if (weekday === undefined) {
    throw new Error(`unexpected weekday short name: ${weekdayPart}`)
  }
  return { hour, weekday }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}
