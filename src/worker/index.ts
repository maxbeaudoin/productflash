import PgBoss from 'pg-boss'
import { INGEST_CRON, INGEST_QUEUE, runIngestion } from '~/jobs/ingest'
import { requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'
import { shutdownPosthog } from '~/lib/posthog'

// Long-running pg-boss host. Hosts the daily ingestion cron + worker today;
// score/synthesize/send queues from #9, #10, #17 register here too as they
// land.

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

  await boss.schedule(INGEST_QUEUE, INGEST_CRON, {}, { tz: 'UTC' })

  await boss.work(INGEST_QUEUE, async ([job]) => {
    if (!job) return
    logger.info({ jobId: job.id }, 'ingest: job started')
    const metrics = await runIngestion()
    return metrics
  })

  logger.info({ queue: INGEST_QUEUE, cron: INGEST_CRON }, 'ingest: queue + schedule registered')

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
