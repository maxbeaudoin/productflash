import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/shared/server/auth";

// Better Auth's single handler — owns every /api/auth/* sub-route
// (sign-in, sign-out, magic-link verify, admin endpoints). The splat
// segment ($) is required by Better Auth's URL conventions.
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
