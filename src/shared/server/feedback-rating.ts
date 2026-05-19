import { eq, sql } from "drizzle-orm";
import { digestItems, feedback } from "~/db/schema";
import { getDb } from "./db";
import { verifyFeedbackToken } from "./feedback-token";
import { logger } from "./logger";
import { captureServerEvent } from "./posthog";

// Core feedback-rating logic, extracted from the route file so it can be
// integration-tested without booting TanStack Start's file-based routing.
// The route handler at `src/routes/r/$digestItemId/$rating.ts` is now a
// thin plumbing layer around this function.

export type FeedbackRating = "up" | "down";

function badRequest(reason: string): Response {
  return new Response(reason, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function handleFeedbackRating(
  digestItemId: string,
  rating: FeedbackRating,
  token: string | null,
): Promise<Response> {
  if (!token) return badRequest("missing signature");
  if (!verifyFeedbackToken(digestItemId, rating, token)) {
    logger.warn({ digestItemId, rating }, "feedback: signature mismatch");
    return badRequest("invalid signature");
  }

  const db = getDb();
  const [item] = await db
    .select({ userId: digestItems.userId })
    .from(digestItems)
    .where(eq(digestItems.id, digestItemId))
    .limit(1);
  if (!item) {
    return new Response("not found", { status: 404 });
  }

  // When a user flips 👎 → 👍 we drop any "what was wrong?" comment they had
  // left, so the admin feed doesn't show a complaint attached to a like. We
  // detect the flip with `excluded.rating = 'up' AND feedback.rating = 'down'`
  // — `feedback.*` refers to the existing row, `excluded.*` to the new one.
  await db
    .insert(feedback)
    .values({ digestItemId, userId: item.userId, rating })
    .onConflictDoUpdate({
      target: [feedback.userId, feedback.digestItemId],
      set: {
        rating: sql`excluded.rating`,
        createdAt: sql`now()`,
        comment: sql`case when excluded.rating = 'up' and ${feedback.rating} = 'down' then null else ${feedback.comment} end`,
        commentedAt: sql`case when excluded.rating = 'up' and ${feedback.rating} = 'down' then null else ${feedback.commentedAt} end`,
      },
    });

  captureServerEvent(item.userId, "digest_feedback", {
    digest_item_id: digestItemId,
    rating,
  });

  logger.info({ digestItemId, userId: item.userId, rating }, "feedback recorded");

  // On 👎 we forward the digestItemId + token so the thanks page can host
  // the optional "what was wrong?" comment form (#PF-62) without re-signing.
  // 👍 has no follow-up so we skip the extra query params.
  const location =
    rating === "down"
      ? `/r/thanks?rating=down&digestItemId=${digestItemId}&t=${encodeURIComponent(token)}`
      : `/r/thanks?rating=${rating}`;
  return new Response(null, {
    status: 302,
    headers: { Location: location },
  });
}
