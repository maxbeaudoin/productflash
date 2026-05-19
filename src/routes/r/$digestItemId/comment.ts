import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  FEEDBACK_COMMENT_MAX_LENGTH,
  handleFeedbackComment,
} from "~/shared/server/feedback-comment";

// Thin plumbing around `handleFeedbackComment`. Mirrors the
// `/r/$digestItemId/$rating` shape so the comment surface lives next to the
// rating surface in the route tree.

const paramsSchema = z.object({
  digestItemId: z.string().uuid(),
});

const bodySchema = z.object({
  comment: z.string().min(1).max(FEEDBACK_COMMENT_MAX_LENGTH),
  token: z.string().min(1),
});

export const Route = createFileRoute("/r/$digestItemId/comment")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const parsedParams = paramsSchema.safeParse(params);
        if (!parsedParams.success) {
          return new Response("invalid comment link", {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        let parsedBody;
        try {
          parsedBody = bodySchema.safeParse(await request.json());
        } catch {
          return new Response("invalid body", {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        if (!parsedBody.success) {
          return new Response("invalid body", {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return handleFeedbackComment(
          parsedParams.data.digestItemId,
          parsedBody.data.comment,
          parsedBody.data.token,
        );
      },
    },
  },
});
