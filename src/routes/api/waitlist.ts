import { createFileRoute } from "@tanstack/react-router";
import { handleWaitlistJoin } from "~/features/waitlist/server/join";

export const Route = createFileRoute("/api/waitlist")({
  server: {
    handlers: {
      POST: async ({ request }) => handleWaitlistJoin(request),
    },
  },
});
