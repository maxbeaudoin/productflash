import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { handleFeedbackRating } from "~/shared/server/feedback-rating";

// Thin plumbing around `handleFeedbackRating` — keeps the route file
// dedicated to URL parsing + framework wiring, so the core feedback
// logic stays unit/integration-testable without booting TanStack Start.

const paramsSchema = z.object({
  digestItemId: z.string().uuid(),
  rating: z.enum(["up", "down"]),
});

export const Route = createFileRoute("/r/$digestItemId/$rating")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const parsed = paramsSchema.safeParse(params);
        if (!parsed.success) {
          return new Response("invalid feedback link", {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        const { digestItemId, rating } = parsed.data;
        const token = new URL(request.url).searchParams.get("t");
        return handleFeedbackRating(digestItemId, rating, token);
      },
    },
  },
});
