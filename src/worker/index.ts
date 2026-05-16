import PgBoss from 'pg-boss'
import { type FteJobData, FTE_QUEUE, handleFteJob } from '~/agents/fte/job'
import {
  type FastPathJobData,
  FAST_PATH_QUEUE,
  handleFastPathJob,
} from '~/jobs/fast-path'
import { INGEST_CRON, INGEST_QUEUE, runIngestion } from '~/jobs/ingest'
import { runScoring, SCORE_CRON, SCORE_QUEUE } from '~/jobs/score'
import { runSynthesis, SYNTHESIZE_CRON, SYNTHESIZE_QUEUE } from '~/jobs/synthesize'
import { env, requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import { shutdownPosthog } from '~/lib/posthog'

// Long-running pg-boss host. Hosts the daily ingest → score → synthesize
// crons and workers today; the send queue from #17 registers here too as it
// lands.
//
// Cron schedules are gated by INGEST_SCHEDULE_ENABLED (covers the whole
// pipeline — same toggle since each stage depends on the previous) so
// deploys don't auto-burn API quota before we're ready to dogfood. Queues +
// workers are always registered so manual triggers (boss.send /
// pnpm ingest:run / pnpm score:run / pnpm synthesize:run) work.

async function main() {
  const boss = new PgBoss({ connectionString: requireEnv('DATABASE_URL') })

  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'))

  await boss.start()
  logger.info('pg-boss worker started')

  await boss.createQueue(INGEST_QUEUE, {
    name: INGEST_QUEUE,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  })
  await boss.createQueue(SCORE_QUEUE, {
    name: SCORE_QUEUE,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  })
  await boss.createQueue(SYNTHESIZE_QUEUE, {
    name: SYNTHESIZE_QUEUE,
    retryLimit: 2,
    retryDelay: 300,
    retryBackoff: true,
  })
  // FTE agent runs are user-triggered (signup or admin re-trigger), so no
  // cron. Per-user concurrency is enforced via `singletonKey: userId` at
  // send-time (see src/agents/fte/job.ts); the queue policy stays standard
  // so two different users can run in parallel. `teamSize` on the work()
  // registration below is what lets multiple users actually execute at
  // once — without it, pg-boss defaults to a single concurrent job per
  // queue and new signups would wait in line.
  await boss.createQueue(FTE_QUEUE, {
    name: FTE_QUEUE,
    retryLimit: 1,
    retryDelay: 60,
  })
  // Fast-path is user-triggered like FTE (one job per profile-confirm). Per-
  // user concurrency is enforced via `singletonKey: userId` at send-time
  // (see src/jobs/fast-path.ts); different users still run in parallel via
  // the worker's batchSize below.
  await boss.createQueue(FAST_PATH_QUEUE, {
    name: FAST_PATH_QUEUE,
    retryLimit: 1,
    retryDelay: 60,
  })

  if (env.INGEST_SCHEDULE_ENABLED) {
    await boss.schedule(INGEST_QUEUE, INGEST_CRON, {}, { tz: 'UTC' })
    await boss.schedule(SCORE_QUEUE, SCORE_CRON, {}, { tz: 'UTC' })
    await boss.schedule(SYNTHESIZE_QUEUE, SYNTHESIZE_CRON, {}, { tz: 'UTC' })
    logger.info({ queue: INGEST_QUEUE, cron: INGEST_CRON }, 'ingest: cron schedule armed')
    logger.info({ queue: SCORE_QUEUE, cron: SCORE_CRON }, 'score: cron schedule armed')
    logger.info(
      { queue: SYNTHESIZE_QUEUE, cron: SYNTHESIZE_CRON },
      'synthesize: cron schedule armed',
    )
  } else {
    await boss.unschedule(INGEST_QUEUE).catch(() => {
      // No prior schedule registered — nothing to remove. Safe to ignore.
    })
    await boss.unschedule(SCORE_QUEUE).catch(() => {})
    await boss.unschedule(SYNTHESIZE_QUEUE).catch(() => {})
    logger.warn(
      { queues: [INGEST_QUEUE, SCORE_QUEUE, SYNTHESIZE_QUEUE] },
      'pipeline: crons disabled (INGEST_SCHEDULE_ENABLED unset) — manual triggers only',
    )
  }

  await boss.work(INGEST_QUEUE, async ([job]) => {
    if (!job) return
    logger.info({ jobId: job.id }, 'ingest: job started')
    const metrics = await runIngestion()
    return metrics
  })

  await boss.work(SCORE_QUEUE, async ([job]) => {
    if (!job) return
    logger.info({ jobId: job.id }, 'score: job started')
    const metrics = await runScoring()
    return metrics
  })

  await boss.work(SYNTHESIZE_QUEUE, async ([job]) => {
    if (!job) return
    logger.info({ jobId: job.id }, 'synthesize: job started')
    const metrics = await runSynthesis()
    return metrics
  })

  // batchSize=5 → each poll cycle pulls up to 5 FTE jobs; we run them
  // concurrently inside the handler so different users don't wait in line.
  // pg-boss 10 dropped `teamSize`; concurrency now lives in the handler.
  // singletonKey: userId on the send side still prevents the same user from
  // double-occupying a slot.
  await boss.work<FteJobData>(
    FTE_QUEUE,
    { batchSize: 5 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          logger.info(
            { jobId: job.id, userId: job.data.userId, runId: job.data.runId },
            'fte: job started',
          )
          await handleFteJob(job)
        }),
      )
    },
  )

  await boss.work<FastPathJobData>(
    FAST_PATH_QUEUE,
    { batchSize: 5 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          logger.info(
            { jobId: job.id, userId: job.data.userId },
            'fast-path: job started',
          )
          await handleFastPathJob(job)
        }),
      )
    },
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await boss.stop({ graceful: true, wait: true })
    await shutdownPosthog()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
