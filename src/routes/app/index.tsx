import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { users as usersTable } from "~/db/schema";
import { requireSession } from "~/lib/auth-server";
import { getDb } from "~/lib/db";

// /app is the magic-link callbackURL. Admins go straight to the admin app;
// unconfirmed users get onboarding; everyone else lands on /app/digests.

type Landing = "/admin" | "/app/digests" | "/app/onboarding";

const resolveLanding = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ to: Landing }> => {
    const session = await requireSession();
    if (session.user.role === "admin") {
      return { to: "/admin" };
    }
    const db = getDb();
    const [row] = await db
      .select({ profileConfirmedAt: usersTable.profileConfirmedAt })
      .from(usersTable)
      .where(eq(usersTable.id, session.user.id))
      .limit(1);
    return { to: row?.profileConfirmedAt ? "/app/digests" : "/app/onboarding" };
  },
);

export const Route = createFileRoute("/app/")({
  beforeLoad: async () => {
    const { to } = await resolveLanding();
    throw redirect({ to });
  },
});
