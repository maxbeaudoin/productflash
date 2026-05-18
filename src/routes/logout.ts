import { createFileRoute } from "@tanstack/react-router";
import { auth } from "~/shared/server/auth";

// POST-only sign-out. A GET handler would let any cross-site `<img>` /
// `<iframe>` silently log the user out — top-level GETs ship cookies even
// with SameSite=lax. Form-submit POST is harmless because browsers don't
// cross-site auto-submit forms, and our cookies plugin handles the clears.
export const Route = createFileRoute("/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const response = await auth.api.signOut({
          headers: request.headers,
          asResponse: true,
        });
        const headers = new Headers(response.headers);
        headers.set("Location", "/");
        return new Response(null, { status: 302, headers });
      },
    },
  },
});
