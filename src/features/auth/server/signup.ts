import { createServerFn } from "@tanstack/react-start";
import { eq, sql } from "drizzle-orm";
import { enqueueFteRun } from "~/agents/fte/job";
import { users as usersTable, waitlist as waitlistTable } from "~/db/schema";
import { signupServerSchema } from "~/features/auth/schema";
import { issueAutoSignInUrl } from "~/features/auth/server/session";
import { verifyInviteToken } from "~/features/auth/server/invite-token";
import { getBoss } from "~/shared/server/boss";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";

// HMAC verification runs server-side because INVITE_TOKEN_SECRET must never
// reach the client. On a valid token the loader also fetches the matching
// waitlist row to seed the FTE intake form with `position` + `companyUrl` the
// user already typed on the landing waitlist (task #37). Defaults are
// returned to the client; the form lets the user revise them.
export type InviteVerification = {
  email: string | null;
  defaults: { position: string; companyUrl: string } | null;
};

export const verifyInvite = createServerFn({ method: "GET" })
  .inputValidator((data: { token?: string }) => data)
  .handler(async ({ data }): Promise<InviteVerification> => {
    if (!data.token) return { email: null, defaults: null };
    const payload = verifyInviteToken(data.token);
    if (!payload) return { email: null, defaults: null };

    const db = getDb();
    const [row] = await db
      .select({ position: waitlistTable.position, companyUrl: waitlistTable.companyUrl })
      .from(waitlistTable)
      .where(eq(waitlistTable.id, payload.id))
      .limit(1);

    return {
      email: payload.email,
      defaults: {
        position: row?.position ?? "",
        companyUrl: row?.companyUrl ?? "",
      },
    };
  });

export type SubmitError =
  | "invalid_invite"
  | "already_confirmed"
  | "user_insert_failed"
  | "session_failed";

export type SubmitResult =
  | { ok: true; email: string; signInUrl: string }
  | { ok: false; error: SubmitError };

// Server fn: re-verifies the invite token, upserts the user with the AI-
// profile seed fields the user typed, enqueues the FTE agent, then mints a
// one-shot magic-link verify URL the client navigates to (auto-sign-in). The
// user row MUST exist before the verify URL is hit because magic-link runs
// with `disableSignUp: true` (private beta).
export const submitSignup = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => signupServerSchema.parse(data))
  .handler(async ({ data }): Promise<SubmitResult> => {
    const payload = verifyInviteToken(data.inviteToken);
    if (!payload) return { ok: false, error: "invalid_invite" };

    const email = payload.email.toLowerCase();
    const db = getDb();

    // Refuse replay on a confirmed account: once the user has stamped
    // profile_confirmed_at, the invite has served its purpose and any
    // further /signup hit on that email is a leaked-URL replay that would
    // otherwise clobber the active profile + mint a new session for the
    // submitter. Re-running before confirmation is still allowed (legitimate
    // case: user wants to retry an expired magic link).
    const [existing] = await db
      .select({ profileConfirmedAt: usersTable.profileConfirmedAt })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (existing?.profileConfirmedAt) {
      return { ok: false, error: "already_confirmed" };
    }

    // Re-running /signup with the same invite should re-seed profile inputs
    // and re-kick the agent — useful when the magic link expires or the
    // user wants to retry. Only overwrite status when the user hasn't yet
    // confirmed a profile (we don't want to demote an active user back to
    // onboarding by accident).
    const [user] = await db
      .insert(usersTable)
      .values({
        email,
        status: "onboarding",
        companyUrl: data.companyUrl,
        position: data.position,
        ultimateGoal: data.ultimateGoal,
        tz: data.tz ?? null,
      })
      .onConflictDoUpdate({
        target: usersTable.email,
        set: {
          status: sql`case when ${usersTable.profileConfirmedAt} is null then 'onboarding'::user_status else ${usersTable.status} end`,
          companyUrl: data.companyUrl,
          position: data.position,
          ultimateGoal: data.ultimateGoal,
          // Only overwrite tz when the client actually provided one — a
          // browser that fails the Intl call shouldn't clobber a tz the
          // user (or a prior signup) already set.
          ...(data.tz ? { tz: data.tz } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: usersTable.id, email: usersTable.email });

    if (!user) return { ok: false, error: "user_insert_failed" };

    // Best-effort enqueue. `singletonKey: userId` makes a double-submit a
    // no-op; if the FTE worker is down the row is still queued and will
    // pick up when it comes back.
    const boss = await getBoss();
    const enqueueRes = await enqueueFteRun(boss, user.id, {
      signup: {
        email: user.email,
        companyUrl: data.companyUrl,
        position: data.position,
        ultimateGoal: data.ultimateGoal,
      },
    });
    logger.info(
      { userId: user.id, runId: enqueueRes.runId, enqueued: enqueueRes.enqueued },
      "signup: fte enqueued",
    );

    captureServerEvent(user.id, "signup_started", {
      email: user.email,
      company_url: data.companyUrl,
      position: data.position,
      fte_enqueued: enqueueRes.enqueued,
      run_id: enqueueRes.runId,
    });

    // Mint a one-shot verify URL — the client navigates to it to consume the
    // pre-seeded verification row, which lands the Better Auth session cookie
    // on the response. /app routes admin → /admin, unconfirmed → onboarding.
    let signInUrl: string;
    try {
      signInUrl = await issueAutoSignInUrl(user.email, "/app");
    } catch (err) {
      logger.error({ err, userId: user.id }, "signup: auto-sign-in url failed");
      return { ok: false, error: "session_failed" };
    }

    return { ok: true, email: user.email, signInUrl };
  });
