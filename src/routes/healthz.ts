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
          // Server-side has the full err for paging; the response stays
          // generic so a probing client can't harvest connection-string
          // fragments or schema hints from the DB driver's message.
          logger.error({ err }, '/healthz db ping failed')
          return Response.json(
            {
              ok: false,
              db: { ok: false },
              uptimeSeconds: Math.round(process.uptime()),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
