import { and, desc, eq, gte, ne } from 'drizzle-orm'
import {
  competitors as competitorsTable,
  digestItems,
  digests,
  itemScores,
  rawItems,
  users as usersTable,
} from '~/db/schema'
import type { NewDigestItem } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'
import {
  type SynthesisInputItem,
  synthesizeDigest,
  type SynthesizedItem,
} from '~/lib/synthesize'

// Daily synthesis job.
//
// pg-boss fires this at 05:30 UTC, 30 minutes after scoring (#9). For each
// active user, take their top-scored non-noise items from the last 24h,
// cap at MAX_ITEMS_PER_DIGEST, and feed them to Sonnet as a single batch.
// Sonnet returns one editorial { headline, snippet, impactNote } tuple per
// input item, which we persist as digest_items pointing at a single
// digests row.
//
// Empty-digest policy (SCOPE.md §9): if zero items qualify for a user, we
// still persist a digests row with item_count=0 so the send job (#17) can
// emit the "nothing notable today" template instead of going silent.
//
// Idempotency: one digest per (user, UTC day). Re-runs in the same window
// delete the previous day's digest_items for this digest and overwrite. The
// Sonnet call happens outside the write step so a retry against the same
// candidates produces a clean replacement.

export const SYNTHESIZE_QUEUE = 'synthesize-run'
export const SYNTHESIZE_CRON = '30 5 * * *' // 05:30 UTC daily, per SCOPE.md §6

const LOOKBACK_HOURS = 24
const MAX_ITEMS_PER_DIGEST = 5

export interface UserSynthesisMetrics {
  userId: string
  candidates: number
  synthesized: number
  empty: boolean
  errored: boolean
}

export interface SynthesisMetrics {
  users: number
  durationMs: number
  totalCandidates: number
  totalSynthesized: number
  emptyDigests: number
  erroredUsers: number
  perUser: UserSynthesisMetrics[]
}

export interface SynthesisOptions {
  lookbackHours?: number
  maxItemsPerDigest?: number
  now?: Date
}

export async function runSynthesis(options: SynthesisOptions = {}): Promise<SynthesisMetrics> {
  const started = Date.now()
  const db = getDb()
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS
  const maxItems = options.maxItemsPerDigest ?? MAX_ITEMS_PER_DIGEST
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000)
  const dayStart = startOfUtcDay(now)

  const activeUsers = await db
    .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .where(eq(usersTable.status, 'active'))

  logger.info(
    {
      users: activeUsers.length,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      dayStart: dayStart.toISOString(),
    },
    'synthesize: starting run',
  )

  const perUser: UserSynthesisMetrics[] = []

  for (const user of activeUsers) {
    try {
      const metrics = await runForUser(db, user.id, user.name, cutoff, dayStart, maxItems)
      perUser.push(metrics)
      logger.info({ ...metrics, email: user.email }, 'synthesize: user complete')
    } catch (err) {
      logger.error(
        { err, userId: user.id, email: user.email },
        'synthesize: user failed — skipping, will retry on next run',
      )
      perUser.push({
        userId: user.id,
        candidates: 0,
        synthesized: 0,
        empty: false,
        errored: true,
      })
    }
  }

  const aggregate: SynthesisMetrics = {
    users: activeUsers.length,
    durationMs: Date.now() - started,
    totalCandidates: sum(perUser, (m) => m.candidates),
    totalSynthesized: sum(perUser, (m) => m.synthesized),
    emptyDigests: perUser.filter((m) => m.empty).length,
    erroredUsers: perUser.filter((m) => m.errored).length,
    perUser,
  }

  logger.info(aggregate, 'synthesize: run complete')
  emitPosthog(aggregate)
  return aggregate
}

async function runForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  userName: string,
  cutoff: Date,
  dayStart: Date,
  maxItems: number,
): Promise<UserSynthesisMetrics> {
  const candidates = await db
    .select({
      rawItemId: rawItems.id,
      competitorName: competitorsTable.name,
      source: rawItems.source,
      url: rawItems.url,
      title: rawItems.title,
      body: rawItems.body,
      publishedAt: rawItems.publishedAt,
      category: itemScores.category,
      score: itemScores.score,
      why: itemScores.why,
    })
    .from(itemScores)
    .innerJoin(rawItems, eq(rawItems.id, itemScores.rawItemId))
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(
      and(
        eq(itemScores.userId, userId),
        ne(itemScores.category, 'noise'),
        gte(rawItems.ingestedAt, cutoff),
      ),
    )
    .orderBy(desc(itemScores.score))
    .limit(maxItems)

  if (candidates.length === 0) {
    await upsertDigest(db, userId, dayStart, [])
    return { userId, candidates: 0, synthesized: 0, empty: true, errored: false }
  }

  const synthesisInput: SynthesisInputItem[] = candidates.map((c) => ({
    rawItemId: c.rawItemId,
    competitorName: c.competitorName,
    source: c.source,
    url: c.url,
    title: c.title,
    body: c.body,
    publishedAt: c.publishedAt,
    category: c.category as SynthesisInputItem['category'],
    score: c.score,
    why: c.why,
  }))

  const synthesized = await synthesizeDigest({ userName, items: synthesisInput })

  if (synthesized.length === 0) {
    // Sonnet returned an empty array despite non-empty input — treat as
    // synthesis failure and persist empty digest so send job stays unblocked.
    logger.warn({ userId, candidates: candidates.length }, 'synthesize: empty output for non-empty input')
    await upsertDigest(db, userId, dayStart, [])
    return { userId, candidates: candidates.length, synthesized: 0, empty: true, errored: true }
  }

  const byId = new Map(candidates.map((c) => [c.rawItemId, c]))
  const itemRows = synthesized
    .map((s) => buildDigestItemRow(userId, s, byId))
    .filter((row): row is NewDigestItem => row !== null)

  await upsertDigest(db, userId, dayStart, itemRows)

  return {
    userId,
    candidates: candidates.length,
    synthesized: itemRows.length,
    empty: false,
    errored: false,
  }
}

function buildDigestItemRow(
  userId: string,
  s: SynthesizedItem,
  byId: Map<string, { category: string; score: number }>,
): Omit<NewDigestItem, 'digestId'> | null {
  const meta = byId.get(s.rawItemId)
  if (!meta) {
    logger.warn(
      { rawItemId: s.rawItemId },
      'synthesize: synthesized item references unknown rawItemId — dropping',
    )
    return null
  }
  return {
    userId,
    rawItemId: s.rawItemId,
    category: meta.category as NewDigestItem['category'],
    headline: s.headline,
    snippet: s.snippet,
    impactNote: s.impactNote,
    score: meta.score,
  } as Omit<NewDigestItem, 'digestId'>
}

async function upsertDigest(
  db: ReturnType<typeof getDb>,
  userId: string,
  dayStart: Date,
  itemRows: Array<Omit<NewDigestItem, 'digestId'>>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.userId, userId), gte(digests.createdAt, dayStart)))
      .limit(1)

    let digestId: string
    if (existing.length > 0) {
      digestId = existing[0].id
      await tx.delete(digestItems).where(eq(digestItems.digestId, digestId))
      await tx
        .update(digests)
        .set({ itemCount: itemRows.length })
        .where(eq(digests.id, digestId))
    } else {
      const inserted = await tx
        .insert(digests)
        .values({ userId, itemCount: itemRows.length })
        .returning({ id: digests.id })
      digestId = inserted[0].id
    }

    if (itemRows.length > 0) {
      await tx.insert(digestItems).values(itemRows.map((row) => ({ ...row, digestId })))
    }
  })
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

function sum<T>(arr: T[], pick: (t: T) => number): number {
  return arr.reduce((acc, x) => acc + pick(x), 0)
}

function emitPosthog(m: SynthesisMetrics): void {
  captureServerEvent('worker', 'synthesize_run', {
    users: m.users,
    duration_ms: m.durationMs,
    total_candidates: m.totalCandidates,
    total_synthesized: m.totalSynthesized,
    empty_digests: m.emptyDigests,
    errored_users: m.erroredUsers,
  })
}
