import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { digestItems, feedback } from '~/db/schema'
import { getDb } from '~/lib/db'
import { verifyFeedbackToken } from '~/lib/feedback-token'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'

const paramsSchema = z.object({
  digestItemId: z.string().uuid(),
  rating: z.enum(['up', 'down']),
})

function badRequest(reason: string): Response {
  return new Response(reason, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export const Route = createFileRoute('/r/$digestItemId/$rating')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const parsed = paramsSchema.safeParse(params)
        if (!parsed.success) return badRequest('invalid feedback link')
        const { digestItemId, rating } = parsed.data

        const url = new URL(request.url)
        const token = url.searchParams.get('t')
        if (!token) return badRequest('missing signature')
        if (!verifyFeedbackToken(digestItemId, rating, token)) {
          logger.warn({ digestItemId, rating }, 'feedback: signature mismatch')
          return badRequest('invalid signature')
        }

        const db = getDb()
        const [item] = await db
          .select({ userId: digestItems.userId })
          .from(digestItems)
          .where(eq(digestItems.id, digestItemId))
          .limit(1)
        if (!item) {
          return new Response('not found', { status: 404 })
        }

        await db
          .insert(feedback)
          .values({ digestItemId, userId: item.userId, rating })
          .onConflictDoUpdate({
            target: [feedback.userId, feedback.digestItemId],
            set: {
              rating: sql`excluded.rating`,
              createdAt: sql`now()`,
            },
          })

        captureServerEvent(item.userId, 'digest_feedback', {
          digest_item_id: digestItemId,
          rating,
        })

        logger.info({ digestItemId, userId: item.userId, rating }, 'feedback recorded')

        return new Response(null, {
          status: 302,
          headers: { Location: `/r/thanks?rating=${rating}` },
        })
      },
    },
  },
})
