import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import {
  itemScores,
  rawItems,
  userCompetitors,
  users as usersTable,
} from '~/db/schema'
import type { NewItemScore } from '~/db/schema'
import { classifyItem, type Classification, type ReaderProfile } from '~/lib/classify'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'

// Daily scoring job.
//
// pg-boss fires this at 05:00 UTC, one hour after ingestion (#7). For each
// active user, we pull the last-24h raw_items belonging to their competitors,
// classify each item with Haiku, and upsert into item_scores.
//
// Per-user batching: synthesis (#10) needs scores partitioned by user, since
// the same item can be relevant differently to two users with different
// portfolios. Even though we'd save tokens by classifying once globally, we
// can defer that optimization — at 5–10 beta users the duplicate-classify
// cost is still <$1/day.
//
// Concurrency: a small Promise pool keeps simultaneous Anthropic calls
// bounded. Haiku's rate limits are generous but a 5-user × 50-item run would
// otherwise launch 250 parallel requests.

export const SCORE_QUEUE = 'score-run'
export const SCORE_CRON = '0 5 * * *' // 05:00 UTC daily, per SCOPE.md §6

const LOOKBACK_HOURS = 24
const MAX_ITEMS_PER_USER = 50
const CLASSIFY_CONCURRENCY = 6

export interface UserScoreMetrics {
  userId: string
  candidates: number
  classified: number
  skipped: number
  errored: number
}

export interface ScoreMetrics {
  users: number
  durationMs: number
  totalCandidates: number
  totalClassified: number
  totalSkipped: number
  totalErrored: number
  perUser: UserScoreMetrics[]
}

export interface ScoreOptions {
  lookbackHours?: number
  maxItemsPerUser?: number
  concurrency?: number
  now?: Date
}

// On-demand variant used by the debug preview (#25) and the time-to-first
// digest fast path (#30). Bypasses the `status='active'` filter so an
// onboarding user's items can be scored before they're flipped to active.
export async function runScoringForUser(
  userId: string,
  options: ScoreOptions = {},
): Promise<UserScoreMetrics> {
  const db = getDb()
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS
  const maxItemsPerUser = options.maxItemsPerUser ?? MAX_ITEMS_PER_USER
  const concurrency = options.concurrency ?? CLASSIFY_CONCURRENCY
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000)
  const metrics = await runForUser(db, userId, cutoff, maxItemsPerUser, concurrency)
  logger.info(metrics, 'score: on-demand user run complete')
  return metrics
}

export async function runScoring(options: ScoreOptions = {}): Promise<ScoreMetrics> {
  const started = Date.now()
  const db = getDb()
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS
  const maxItemsPerUser = options.maxItemsPerUser ?? MAX_ITEMS_PER_USER
  const concurrency = options.concurrency ?? CLASSIFY_CONCURRENCY
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000)

  const activeUsers = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.status, 'active'))

  logger.info(
    { users: activeUsers.length, lookbackHours, cutoff: cutoff.toISOString() },
    'score: starting run',
  )

  const perUser: UserScoreMetrics[] = []

  for (const user of activeUsers) {
    const metrics = await runForUser(db, user.id, cutoff, maxItemsPerUser, concurrency)
    perUser.push(metrics)
    logger.info({ ...metrics, email: user.email }, 'score: user complete')
  }

  const aggregate: ScoreMetrics = {
    users: activeUsers.length,
    durationMs: Date.now() - started,
    totalCandidates: sum(perUser, (m) => m.candidates),
    totalClassified: sum(perUser, (m) => m.classified),
    totalSkipped: sum(perUser, (m) => m.skipped),
    totalErrored: sum(perUser, (m) => m.errored),
    perUser,
  }

  logger.info(aggregate, 'score: run complete')
  emitPosthog(aggregate)
  return aggregate
}

async function runForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  cutoff: Date,
  maxItems: number,
  concurrency: number,
): Promise<UserScoreMetrics> {
  const reader = await fetchReaderProfile(db, userId)

  const competitorIds = await db
    .select({ competitorId: userCompetitors.competitorId })
    .from(userCompetitors)
    .where(eq(userCompetitors.userId, userId))

  const ids = competitorIds.map((r) => r.competitorId)
  if (ids.length === 0) {
    return { userId, candidates: 0, classified: 0, skipped: 0, errored: 0 }
  }

  // Pull last-24h items for this user's competitors, skip any already scored
  // for this user (idempotent re-runs in the same window).
  const candidates = await db
    .select({
      rawItemId: rawItems.id,
      competitorId: rawItems.competitorId,
      source: rawItems.source,
      title: rawItems.title,
      body: rawItems.body,
      publishedAt: rawItems.publishedAt,
      ingestedAt: rawItems.ingestedAt,
      competitorName: sql<string>`(select name from competitors where id = ${rawItems.competitorId})`,
      alreadyScored: sql<boolean>`exists(
        select 1 from ${itemScores}
        where ${itemScores.userId} = ${userId}
          and ${itemScores.rawItemId} = ${rawItems.id}
      )`,
    })
    .from(rawItems)
    .where(and(inArray(rawItems.competitorId, ids), gte(rawItems.ingestedAt, cutoff)))
    .orderBy(desc(rawItems.ingestedAt))
    .limit(maxItems)

  const pending = candidates.filter((c) => !c.alreadyScored)
  const skipped = candidates.length - pending.length

  if (pending.length === 0) {
    return { userId, candidates: candidates.length, classified: 0, skipped, errored: 0 }
  }

  const results: Array<{ row: NewItemScore | null; ok: boolean }> = await runWithConcurrency(
    pending,
    concurrency,
    async (item) => {
      try {
        const result: Classification = await classifyItem({
          competitorName: item.competitorName ?? 'unknown competitor',
          source: item.source,
          title: item.title,
          body: item.body,
          publishedAt: item.publishedAt,
          reader,
        })
        const row: NewItemScore = {
          userId,
          rawItemId: item.rawItemId,
          category: result.category,
          score: result.score,
          why: result.why,
        }
        return { row, ok: true }
      } catch (err) {
        logger.warn(
          { err, userId, rawItemId: item.rawItemId, title: item.title.slice(0, 80) },
          'score: classify failed for item',
        )
        return { row: null, ok: false }
      }
    },
  )

  const rows = results.flatMap((r) => (r.row ? [r.row] : []))
  const errored = results.length - rows.length

  if (rows.length > 0) {
    await db
      .insert(itemScores)
      .values(rows)
      .onConflictDoUpdate({
        target: [itemScores.userId, itemScores.rawItemId],
        set: {
          category: sql`excluded.category`,
          score: sql`excluded.score`,
          why: sql`excluded.why`,
          scoredAt: sql`now()`,
        },
      })
  }

  return {
    userId,
    candidates: candidates.length,
    classified: rows.length,
    skipped,
    errored,
  }
}

async function fetchReaderProfile(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<ReaderProfile | null> {
  const [row] = await db
    .select({
      position: usersTable.position,
      companyName: usersTable.companyName,
      ultimateGoal: usersTable.ultimateGoal,
      focusAreas: usersTable.focusAreas,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1)
  if (!row) return null
  return {
    position: row.position ?? null,
    companyName: row.companyName ?? null,
    ultimateGoal: row.ultimateGoal ?? null,
    focusAreas: row.focusAreas ?? null,
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

function sum<T>(arr: T[], pick: (t: T) => number): number {
  return arr.reduce((acc, x) => acc + pick(x), 0)
}

function emitPosthog(m: ScoreMetrics): void {
  captureServerEvent('worker', 'score_run', {
    users: m.users,
    duration_ms: m.durationMs,
    total_candidates: m.totalCandidates,
    total_classified: m.totalClassified,
    total_skipped: m.totalSkipped,
    total_errored: m.totalErrored,
  })
}
