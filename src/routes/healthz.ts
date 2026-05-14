import { createFileRoute } from '@tanstack/react-router'
import { pingDb } from '~/lib/db'
import { logger } from '~/lib/logger'

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { latencyMs } = await pingDb()
          return Response.json({
            ok: true,
            db: { ok: true, latencyMs },
            uptimeSeconds: Math.round(process.uptime()),
          })
        } catch (err) {
          logger.error({ err }, '/healthz db ping failed')
          return Response.json(
            {
              ok: false,
              db: { ok: false, error: err instanceof Error ? err.message : String(err) },
              uptimeSeconds: Math.round(process.uptime()),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
