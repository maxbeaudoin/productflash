import PgBoss from 'pg-boss'
import { INGEST_CRON, INGEST_QUEUE, runIngestion } from '~/jobs/ingest'
import { runScoring, SCORE_CRON, SCORE_QUEUE } from '~/jobs/score'
import { env, requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import { shutdownPosthog } from '~/lib/posthog'

// Long-running pg-boss host. Hosts the daily ingestion + scoring crons and
// workers today; synthesize/send queues from #10, #17 register here too as
// they land.
//
// Cron schedules are gated by INGEST_SCHEDULE_ENABLED (covers the whole
// pipeline — same toggle since score depends on ingest) so deploys don't
// auto-burn API quota before we're ready to dogfood. Queues + workers are
// always registered so manual triggers (boss.send / pnpm ingest:run /
// pnpm score:run) work.

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

  if (env.INGEST_SCHEDULE_ENABLED) {
    await boss.schedule(INGEST_QUEUE, INGEST_CRON, {}, { tz: 'UTC' })
    await boss.schedule(SCORE_QUEUE, SCORE_CRON, {}, { tz: 'UTC' })
    logger.info({ queue: INGEST_QUEUE, cron: INGEST_CRON }, 'ingest: cron schedule armed')
    logger.info({ queue: SCORE_QUEUE, cron: SCORE_CRON }, 'score: cron schedule armed')
  } else {
    await boss.unschedule(INGEST_QUEUE).catch(() => {
      // No prior schedule registered — nothing to remove. Safe to ignore.
    })
    await boss.unschedule(SCORE_QUEUE).catch(() => {})
    logger.warn(
      { queues: [INGEST_QUEUE, SCORE_QUEUE] },
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
