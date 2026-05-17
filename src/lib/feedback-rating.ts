import { eq, sql } from 'drizzle-orm'
import { digestItems, feedback } from '~/db/schema'
import { getDb } from './db'
import { verifyFeedbackToken } from './feedback-token'
import { logger } from './logger'
import { captureServerEvent } from './posthog'

// Core feedback-rating logic, extracted from the route file so it can be
// integration-tested without booting TanStack Start's file-based routing.
// The route handler at `src/routes/r/$digestItemId/$rating.ts` is now a
// thin plumbing layer around this function.

export type FeedbackRating = 'up' | 'down'

function badRequest(reason: string): Response {
  return new Response(reason, {
    status: 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export async function handleFeedbackRating(
  digestItemId: string,
  rating: FeedbackRating,
  token: string | null,
): Promise<Response> {
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
}
