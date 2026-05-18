import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import {
  competitors as competitorsTable,
  fteEvents,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import type { CompetitorView } from "~/features/competitors/server/fns";
import { onboardingProfileFormSchema } from "~/features/profile/schema";
import { enqueueFastPath } from "~/features/digest/server/jobs/fast-path";
import { requireSession } from "~/features/auth/server/session";
import { getBoss } from "~/shared/server/boss";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import type { FteEventRow, JsonValue, ProfileView } from "../shared/fte-event";

export type OnboardingLoaderData = {
  runId: string | null;
  events: FteEventRow[];
  profile: ProfileView;
  competitors: CompetitorView[];
};

export const loadOnboarding = createServerFn({ method: "GET" }).handler(
  async (): Promise<OnboardingLoaderData> => {
    const session = await requireSession();
    const db = getDb();
    const userId = session.user.id;

    const [latest] = await db
      .select({ runId: fteEvents.runId })
      .from(fteEvents)
      .where(eq(fteEvents.userId, userId))
      .orderBy(desc(fteEvents.ts))
      .limit(1);

    const runId = latest?.runId ?? null;

    const events: FteEventRow[] = runId
      ? (
          await db
            .select({
              id: fteEvents.id,
              runId: fteEvents.runId,
              kind: fteEvents.kind,
              payload: fteEvents.payload,
              ts: fteEvents.ts,
            })
            .from(fteEvents)
            .where(and(eq(fteEvents.userId, userId), eq(fteEvents.runId, runId)))
            .orderBy(asc(fteEvents.ts))
        ).map((row) => ({
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          payload: (row.payload ?? {}) as { [key: string]: JsonValue },
          ts: row.ts.toISOString(),
        }))
      : [];

    const [user] = await db
      .select({
        position: usersTable.position,
        companyName: usersTable.companyName,
        companyUrl: usersTable.companyUrl,
        ultimateGoal: usersTable.ultimateGoal,
        focusAreas: usersTable.focusAreas,
        profileConfirmedAt: usersTable.profileConfirmedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const competitors = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(userCompetitors)
      .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
      .where(eq(userCompetitors.userId, userId))
      .orderBy(asc(competitorsTable.name));

    return {
      runId,
      events,
      profile: {
        position: user?.position ?? null,
        companyName: user?.companyName ?? null,
        companyUrl: user?.companyUrl ?? null,
        ultimateGoal: user?.ultimateGoal ?? null,
        focusAreas: user?.focusAreas ?? null,
        profileConfirmedAt: user?.profileConfirmedAt?.toISOString() ?? null,
      },
      competitors,
    };
  },
);

// editProfile lives here (and not in a shared profile module) because it has
// onboarding-specific semantics that the settings variant doesn't share:
// (a) `companyUrl` is NOT user-editable mid-onboarding (the agent already
// pinned it from the signup form), and (b) we do NOT wipe itemScores —
// no scores exist yet (the fast-path runs after confirmProfile below).
export const editProfile = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => onboardingProfileFormSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const db = getDb();
    await db
      .update(usersTable)
      .set({
        position: data.position,
        companyName: data.companyName,
        ultimateGoal: data.ultimateGoal,
        focusAreas: data.focusAreas,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, session.user.id));
    return { ok: true as const };
  });

export const confirmProfile = createServerFn({ method: "POST" }).handler(async () => {
  const session = await requireSession();
  const db = getDb();
  // Idempotent: only stamp the first time. The agent may have already
  // promoted status to 'active' (save_profile + ≥1 competitor) — we still
  // promote on user consent if it hadn't.
  const updated = await db
    .update(usersTable)
    .set({
      profileConfirmedAt: new Date(),
      status: "active",
      updatedAt: new Date(),
    })
    .where(and(eq(usersTable.id, session.user.id), isNull(usersTable.profileConfirmedAt)))
    .returning({ id: usersTable.id });

  // Only emit the funnel event on the FIRST confirmation. The WHERE clause
  // above makes this idempotent — a repeat click on "Looks good" updates
  // zero rows, so PostHog should also stay silent.
  const wasFirstConfirm = updated.length > 0;
  if (wasFirstConfirm) {
    const competitorCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userCompetitors)
      .where(eq(userCompetitors.userId, session.user.id))
      .then((rows) => rows[0]?.count ?? 0);
    captureServerEvent(session.user.id, "profile_confirmed", {
      competitor_count: competitorCount,
    });
  }

  // Fast path (#30): dispatch ingest → score → synthesize for this user only
  // so the first digest lands at /app/digests within a few minutes instead
  // of waiting for the 05:30 UTC cron. Singleton on userId — double-clicking
  // "Looks good" is a no-op while the first run is in flight.
  try {
    const boss = await getBoss();
    const { enqueued } = await enqueueFastPath(boss, session.user.id);
    logger.info(
      { userId: session.user.id, enqueued },
      "onboarding: fast-path enqueued on profile confirm",
    );
  } catch (err) {
    // Don't block the user's flow on a queue hiccup — the daily cron at
    // 05:30 UTC is the safety net. We log and move on.
    logger.warn(
      { err, userId: session.user.id },
      "onboarding: failed to enqueue fast-path — falling back to cron",
    );
  }

  return { ok: true as const };
});
