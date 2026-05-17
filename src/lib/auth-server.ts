import { redirect } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import { randomBytes } from "node:crypto";
import { verifications } from "~/db/schema";
import { auth } from "./auth";
import { getDb } from "./db";

export type AppSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

// Fetch the current session if one exists. Returns null when unauthenticated.
// Safe to call from server functions and route `beforeLoad` handlers.
export async function getSession(): Promise<AppSession | null> {
  const request = getRequest();
  return await auth.api.getSession({ headers: request.headers });
}

// Gate /app/* routes — throws a TanStack `redirect` to /login when there is
// no session. Use inside a parent route `beforeLoad`. Children inherit the
// guarantee that a session exists.
export async function requireSession(): Promise<AppSession> {
  const session = await getSession();
  if (!session) {
    throw redirect({ to: "/login", search: { reason: "unauthenticated" } });
  }
  return session;
}

// Gate /admin/* routes — first requires a session, then checks the admin
// role granted by Better Auth's admin plugin.
export async function requireAdminSession(): Promise<AppSession> {
  const session = await requireSession();
  if (session.user.role !== "admin") {
    throw redirect({ to: "/app" });
  }
  return session;
}

// Establish a session without an email round-trip by pre-creating a magic-
// link verification row, then returning the verify URL for the client to
// navigate to. Better Auth's standard verify route consumes the row, creates
// the session, sets the signed `session_token` cookie via `tanstackStartCookies`,
// and follows the callbackURL. Used on /signup (#38) where the invite token's
// HMAC is already proof of ownership — so the magic-link email is redundant
// friction.
//
// Window is intentionally short (15s) — the URL is single-use and is consumed
// by the very next navigation, so a longer window only widens the
// shoulder-surf / log-scrape exposure. Never log the returned URL.
export async function issueAutoSignInUrl(email: string, callbackURL = "/app"): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  await db.insert(verifications).values({
    identifier: token,
    value: JSON.stringify({ email }),
    expiresAt: new Date(Date.now() + 15_000),
  });
  const params = new URLSearchParams({ token, callbackURL });
  return `/api/auth/magic-link/verify?${params.toString()}`;
}
