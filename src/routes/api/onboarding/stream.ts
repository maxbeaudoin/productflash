import { createFileRoute } from '@tanstack/react-router'
import {
  deltaChannelFor,
  eventsChannelFor,
} from '~/agents/fte/events'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { connectListener } from '~/lib/notify'
import { fteEvents } from '~/db/schema'
import { and, eq } from 'drizzle-orm'

// SSE endpoint that tails fte_events for the current user. The agent writes
// every step into fte_events + fires a per-user NOTIFY; we LISTEN on the
// channel and forward each row out as an SSE message. Deltas (token-by-token
// text + tool input) ride the parallel delta channel — not persisted, just
// streamed live for the typewriter effect.
//
// Channels are per-user (suffix-keyed by userId) so Postgres itself enforces
// isolation — even if the server-side filter has a bug, the LISTEN can't
// receive another user's stream.

type DeltaPayload = {
  u: string
  r: string
  k: 'text_delta' | 'tool_input_delta' | 'block_start'
  d: string
  b?: string
}

function sseLine(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export const Route = createFileRoute('/api/onboarding/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await requireSession()
        const userId = session.user.id
        const eventsChannel = eventsChannelFor(userId)
        const deltaChannel = deltaChannelFor(userId)
        const db = getDb()
        const encoder = new TextEncoder()

        let listener: Awaited<ReturnType<typeof connectListener>> | null = null
        let heartbeatTimer: NodeJS.Timeout | null = null
        let closed = false

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const push = (chunk: string) => {
              if (closed) return
              try {
                controller.enqueue(encoder.encode(chunk))
              } catch {
                // Stream was closed mid-write — nothing to do.
              }
            }

            const close = async () => {
              if (closed) return
              closed = true
              if (heartbeatTimer) clearInterval(heartbeatTimer)
              if (listener) {
                try {
                  await listener.query(`UNLISTEN "${eventsChannel}"`)
                  await listener.query(`UNLISTEN "${deltaChannel}"`)
                } catch (err) {
                  logger.debug({ err, userId }, 'onboarding: unlisten failed')
                }
                try {
                  await listener.end()
                } catch (err) {
                  logger.debug({ err, userId }, 'onboarding: listener end failed')
                }
              }
              try {
                controller.close()
              } catch {
                // Already closed.
              }
            }

            request.signal.addEventListener('abort', () => {
              void close()
            })

            // Opening comment so reverse proxies flush headers immediately.
            push(': stream open\n\n')

            try {
              listener = await connectListener()
            } catch (err) {
              logger.error({ err, userId }, 'onboarding: failed to connect listener')
              push(sseLine('error', { message: 'listener_connect_failed' }))
              await close()
              return
            }

            listener.on('notification', async (msg) => {
              if (closed) return
              if (msg.channel === deltaChannel) {
                try {
                  const parsed = JSON.parse(msg.payload ?? '{}') as DeltaPayload
                  push(
                    sseLine('delta', {
                      runId: parsed.r,
                      kind: parsed.k,
                      delta: parsed.d,
                      blockKind: parsed.b,
                    }),
                  )
                } catch (err) {
                  logger.debug({ err, payload: msg.payload }, 'onboarding: bad delta')
                }
                return
              }
              if (msg.channel === eventsChannel) {
                const payload = msg.payload ?? ''
                const colon = payload.indexOf(':')
                if (colon < 0) return
                const rowId = payload.slice(colon + 1)
                try {
                  const [row] = await db
                    .select()
                    .from(fteEvents)
                    .where(and(eq(fteEvents.userId, userId), eq(fteEvents.id, rowId)))
                    .limit(1)
                  if (!row) return
                  push(
                    sseLine('event', {
                      id: row.id,
                      runId: row.runId,
                      kind: row.kind,
                      payload: row.payload,
                      ts: row.ts.toISOString(),
                    }),
                  )
                } catch (err) {
                  logger.warn({ err, rowId, userId }, 'onboarding: failed to fetch row')
                }
              }
            })

            listener.on('error', (err) => {
              logger.warn({ err, userId }, 'onboarding: listener error')
              push(sseLine('error', { message: 'listener_error' }))
              void close()
            })

            try {
              await listener.query(`LISTEN "${eventsChannel}"`)
              await listener.query(`LISTEN "${deltaChannel}"`)
            } catch (err) {
              logger.error({ err, userId }, 'onboarding: LISTEN failed')
              push(sseLine('error', { message: 'listen_failed' }))
              await close()
              return
            }

            push(sseLine('ready', { userId }))

            // Heartbeat every 20s — keeps proxies from closing the connection
            // during long agent-step gaps (web_search takes 5-10s of silence).
            heartbeatTimer = setInterval(() => {
              push(': hb\n\n')
            }, 20_000)
          },
          cancel() {
            closed = true
            if (heartbeatTimer) clearInterval(heartbeatTimer)
            if (listener) {
              listener.end().catch(() => {})
            }
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
