import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminAudit, users, waitlist } from "~/db/schema";
import type { WaitlistRow, WaitlistState } from "~/features/waitlist/shared/types";
import { requireAdminSession } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";
import { env } from "~/shared/server/env";
import { signInviteToken } from "~/features/auth/server/invite-token";
import { logger } from "~/shared/server/logger";

export const listWaitlist = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdminSession();
  const db = getDb();
  const rows = await db
    .select({
      id: waitlist.id,
      email: waitlist.email,
      name: waitlist.name,
      position: waitlist.position,
      companyUrl: waitlist.companyUrl,
      source: waitlist.source,
      invitedAt: waitlist.invitedAt,
      createdAt: waitlist.createdAt,
      userId: users.id,
      userStatus: users.status,
      emailVerified: users.emailVerified,
      profileConfirmedAt: users.profileConfirmedAt,
      userUpdatedAt: users.updatedAt,
    })
    .from(waitlist)
    .leftJoin(users, eq(users.email, waitlist.email))
    .orderBy(desc(waitlist.createdAt));

  return {
    rows: rows.map<WaitlistRow>((r) => {
      const accepted = Boolean(
        r.userId && (r.emailVerified || (r.userStatus && r.userStatus !== "pending")),
      );
      const state: WaitlistState = accepted ? "accepted" : r.invitedAt ? "invited" : "waitlist";
      const acceptedAt = accepted ? (r.profileConfirmedAt ?? r.userUpdatedAt) : null;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        position: r.position,
        companyUrl: r.companyUrl,
        source: r.source,
        invitedAt: r.invitedAt ? r.invitedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        state,
        userId: r.userId,
        acceptedAt: acceptedAt ? acceptedAt.toISOString() : null,
      };
    }),
  };
});

// Signs a fresh token and stamps `invited_at`. Re-issuing on a row that
// already has `invited_at` produces a new token (helpful when the user
// lost the link) — we do NOT bump `invited_at` in that case so the
// timestamp keeps the original outreach moment.
export const issueInvite = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ id: z.string().uuid() }).parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const db = getDb();
    const found = await db.select().from(waitlist).where(eq(waitlist.id, data.id)).limit(1);
    const row = found[0];
    if (!row) {
      throw new Error("waitlist row not found");
    }
    const token = signInviteToken({ id: row.id, email: row.email });

    // Pre-create the users row. Better Auth's magic-link plugin runs with
    // `disableSignUp: true` (no self-serve signup in private beta), so the
    // user must exist before they verify the link. Insert is idempotent on
    // email — re-issuing on an already-invited row is a no-op here.
    await db
      .insert(users)
      .values({ email: row.email, status: "pending" })
      .onConflictDoNothing({ target: users.email });

    // Resolve the user row so the audit entry attaches to the per-user
    // detail surface (PF-60). The insert above is idempotent — on conflict
    // it returns nothing, so a follow-up select is the simplest path.
    const [userRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, row.email))
      .limit(1);

    const reissue = row.invitedAt !== null;
    let invitedAt = row.invitedAt;
    if (!invitedAt) {
      const now = new Date();
      await db.update(waitlist).set({ invitedAt: now }).where(eq(waitlist.id, row.id));
      invitedAt = now;
    }

    const url = `${env.BETTER_AUTH_URL}/signup?invite=${token}`;
    logger.info({ admin: session.user.email, target: row.email, reissue }, "invite_issued");
    if (userRow) {
      // Inlined audit insert — a shared helper that imports `getDb` /
      // schema leaks pg into the client bundle (see comment in
      // routes/admin/users/$userId.tsx for the full reasoning).
      try {
        await db.insert(adminAudit).values({
          actorId: session.user.id,
          targetKind: "user",
          targetId: userRow.id,
          action: "invite_issued",
          payload: { email: row.email, reissue, waitlistId: row.id },
        });
      } catch (err) {
        logger.error({ err, target: userRow.id }, "admin_audit_write_failed");
      }
    }
    return { url, invitedAt: invitedAt.toISOString() };
  });
