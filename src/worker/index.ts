import PgBoss from 'pg-boss'
import { requireEnv } from '~/lib/env'
import { logger } from '~/lib/logger'

// Long-running pg-boss host. Real jobs (ingest/score/synthesize/send) wire in
// from tasks #7, #9, #10, #17. For now this just proves the worker boots and
// pg-boss can talk to Postgres.

async function main() {
  const boss = new PgBoss({ connectionString: requireEnv('DATABASE_URL') })

  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'))

  await boss.start()
  logger.info('pg-boss worker started')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await boss.stop({ graceful: true, wait: true })
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
