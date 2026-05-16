import { and, desc, eq, gte } from 'drizzle-orm'
import type PgBoss from 'pg-boss'
import { digests as digestsTable } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'
import { runIngestionForUser } from './ingest'
import { runScoringForUser } from './score'
import { runSynthesisForUser } from './synthesize'

// Time-to-first-digest fast path (#30).
//
// When a user confirms their FTE-generated profile, we want their first
// digest to land within ~3–5 minutes instead of waiting for the next 05:30
// UTC cron. This job runs the same ingest → score → synthesize chain the
// crons use, but scoped to one user. Each stage is idempotent (the cron
// path can still overwrite later that day) so a fast-path run before the
// cron is safe.
//
// Singleton per user: a double-click on "Looks good" or a re-run from the
// admin app is a no-op while the previous one is still in flight.

export const FAST_PATH_QUEUE = 'fast-path-run'

export interface FastPathJobData {
  userId: string
}

export interface FastPathMetrics {
  userId: string
  durationMs: number
  ingest: { fetched: number; inserted: number }
  score: { candidates: number; classified: number }
  synthesize: { candidates: number; synthesized: number; empty: boolean }
  digestId: string | null
}

export async function enqueueFastPath(
  boss: PgBoss,
  userId: string,
): Promise<{ enqueued: boolean }> {
  const data: FastPathJobData = { userId }
  const jobId = await boss.send(FAST_PATH_QUEUE, data, { singletonKey: userId })
  return { enqueued: jobId !== null }
}

export async function handleFastPathJob(
  job: PgBoss.Job<FastPathJobData>,
): Promise<FastPathMetrics> {
  const { userId } = job.data
  const started = Date.now()
  logger.info({ jobId: job.id, userId }, 'fast-path: run started')

  const ingest = await runIngestionForUser(userId)
  const score = await runScoringForUser(userId)
  const synthesize = await runSynthesisForUser(userId)

  // synthesize always upserts at most one digest per (user, UTC day). Re-read
  // its id for metrics so the worker logs make the chain traceable end-to-end.
  // The frontend at /app/digests picks it up via short-interval polling — no
  // LISTEN/NOTIFY plumbing needed at this scale.
  const digestId = await latestDigestIdForUser(userId)

  const metrics: FastPathMetrics = {
    userId,
    durationMs: Date.now() - started,
    ingest: { fetched: ingest.totalFetched, inserted: ingest.totalInserted },
    score: { candidates: score.candidates, classified: score.classified },
    synthesize: {
      candidates: synthesize.candidates,
      synthesized: synthesize.synthesized,
      empty: synthesize.empty,
    },
    digestId,
  }

  logger.info(metrics, 'fast-path: run complete')
  captureServerEvent(userId, 'fast_path_run', {
    duration_ms: metrics.durationMs,
    ingest_fetched: metrics.ingest.fetched,
    ingest_inserted: metrics.ingest.inserted,
    score_candidates: metrics.score.candidates,
    score_classified: metrics.score.classified,
    synthesize_candidates: metrics.synthesize.candidates,
    synthesize_synthesized: metrics.synthesize.synthesized,
    synthesize_empty: metrics.synthesize.empty,
    digest_id: metrics.digestId,
  })
  return metrics
}

async function latestDigestIdForUser(userId: string): Promise<string | null> {
  const db = getDb()
  const dayStart = startOfUtcDay(new Date())
  const [row] = await db
    .select({ id: digestsTable.id })
    .from(digestsTable)
    .where(and(eq(digestsTable.userId, userId), gte(digestsTable.createdAt, dayStart)))
    .orderBy(desc(digestsTable.createdAt))
    .limit(1)
  return row?.id ?? null
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
