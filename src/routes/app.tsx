import { Outlet, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { AppHeader } from "~/components/app/AppHeader";
import { requireSession } from "~/shared/server/auth-server";
import { identifyPostHog } from "~/shared/client/posthog-client";

// Server fn wrapper so `beforeLoad` can call a server-only helper
// during SSR + client navigations. The handler throws a TanStack
// `redirect` when no session is present — TanStack catches it and
// routes to /login before this layout renders.
const ensureAuthed = createServerFn({ method: "GET" }).handler(async () => {
  const session = await requireSession();
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
  };
});

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const user = await ensureAuthed();
    return { user };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext();
  useEffect(() => {
    // Link the anonymous landing-page session (if any) to this user so the
    // funnel from waitlist → signup → first digest is one identity. Safe to
    // call repeatedly; PostHog dedupes on distinct_id.
    identifyPostHog(user.id, { email: user.email });
  }, [user.id, user.email]);
  return (
    <div className="min-h-screen bg-ink text-white antialiased">
      <AppHeader email={user.email} />
      <Outlet />
    </div>
  );
}
