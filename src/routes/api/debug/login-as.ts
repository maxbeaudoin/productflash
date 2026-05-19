import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { users } from "~/db/schema";
import { issueAutoSignInUrl } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";
import { env } from "~/shared/server/env";

export const Route = createFileRoute("/api/debug/login-as")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (env.NODE_ENV === "production") {
          return new Response(null, { status: 404 });
        }
        const userId = new URL(request.url).searchParams.get("userId");
        if (userId) {
          const [user] = await getDb()
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!user) return new Response("user not found", { status: 404 });
          const verifyUrl = await issueAutoSignInUrl(user.email, "/app");
          return new Response(null, { status: 302, headers: { Location: verifyUrl } });
        }
        const rows = await getDb()
          .select({ id: users.id, email: users.email, role: users.role })
          .from(users)
          .orderBy(users.email);
        const base = new URL(request.url).origin;
        return Response.json(
          rows.map((u) => ({ ...u, signInUrl: `${base}/api/debug/login-as?userId=${u.id}` })),
        );
      },
    },
  },
});
