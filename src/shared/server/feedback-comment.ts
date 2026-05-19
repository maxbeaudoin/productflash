import { and, eq, sql } from "drizzle-orm";
import { digestItems, feedback } from "~/db/schema";
import { getDb } from "./db";
import { verifyFeedbackToken } from "./feedback-token";
import { logger } from "./logger";
import { captureServerEvent } from "./posthog";

// Optional "what was wrong?" follow-up on a 👎 rating (#PF-62). The rating
// itself is recorded via `feedback-rating.ts`; this handler only attaches
// (or replaces) the free-text comment on the existing feedback row.
//
// Authorization reuses the same HMAC token that authorized the down-rating
// — if the user holds a valid down-token, they're the same actor who already
// rated, so no second secret is needed.

// Single-line follow-up; cap chosen to keep things terse without blocking
// short paragraphs. Anything longer is almost certainly a bug or paste.
export const FEEDBACK_COMMENT_MAX_LENGTH = 500;

function badRequest(reason: string): Response {
  return new Response(reason, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function handleFeedbackComment(
  digestItemId: string,
  comment: string,
  token: string | null,
): Promise<Response> {
  if (!token) return badRequest("missing signature");
  if (!verifyFeedbackToken(digestItemId, "down", token)) {
    logger.warn({ digestItemId }, "feedback-comment: signature mismatch");
    return badRequest("invalid signature");
  }

  const trimmed = comment.trim();
  if (trimmed.length === 0) return badRequest("comment is empty");
  if (trimmed.length > FEEDBACK_COMMENT_MAX_LENGTH) return badRequest("comment too long");

  const db = getDb();
  const [item] = await db
    .select({ userId: digestItems.userId })
    .from(digestItems)
    .where(eq(digestItems.id, digestItemId))
    .limit(1);
  if (!item) {
    return new Response("not found", { status: 404 });
  }

  const result = await db
    .update(feedback)
    .set({ comment: trimmed, commentedAt: sql`now()` })
    .where(
      and(
        eq(feedback.digestItemId, digestItemId),
        eq(feedback.userId, item.userId),
        eq(feedback.rating, "down"),
      ),
    )
    .returning({ id: feedback.id });

  if (result.length === 0) {
    // No down-rated row to attach the comment to. Either the user never
    // rated, or they flipped back to 👍 between rating and commenting.
    return badRequest("no down-rating to comment on");
  }

  captureServerEvent(item.userId, "digest_feedback_comment", {
    digest_item_id: digestItemId,
    comment_length: trimmed.length,
  });

  logger.info(
    { digestItemId, userId: item.userId, length: trimmed.length },
    "feedback comment recorded",
  );

  return new Response(null, { status: 204 });
}
