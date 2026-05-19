import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { useState } from "react";
import { z } from "zod";
import { enqueueFteRun } from "~/agents/fte/job";
import { Button } from "~/components/ui/button";
import { DigestItemCard, type DigestItemView } from "~/features/digest/ui/DigestItemCard";
import {
  adminAudit,
  competitors as competitorsTable,
  digestItems,
  digests,
  feedback,
  fteEvents,
  llmUsage,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import type { AdminAuditPayload, AdminAuditRow } from "~/features/admin-audit/shared/types";
import { AdminAuditList } from "~/features/admin-audit/ui/AdminAuditList";
import { enqueueDailyRegen } from "~/features/digest/server/jobs/daily-regen";
import { enqueueFastPath } from "~/features/digest/server/jobs/fast-path";
import { requireAdminSession } from "~/features/auth/server/session";
import { getBoss } from "~/shared/server/boss";
import { getDb } from "~/shared/server/db";
import { deriveDigestPeriod } from "~/features/digest/shared/digest-period";
import { formatUsd } from "~/shared/iso/llm-cost-format";
import { logger } from "~/shared/server/logger";

// /admin/users/:id (#16). Operator console for one user. Three jobs:
//   1. Surface the AI-generated profile + competitor map so we can spot
//      hallucinations or thin coverage at a glance.
//   2. Render the user's recent digests inline using the same components
//      /app/digests/:id uses — keeps "what the user sees" trustworthy
//      without needing to log in as them.
//   3. Replay the FTE agent's reasoning timeline and expose the two
//      re-run actions (FTE agent, fast-path digest) for hands-on QA.

const RECENT_DIGEST_LIMIT = 3;

type ProfileView = {
  id: string;
  email: string;
  status: string;
  role: string;
  name: string | null;
  tz: string | null;
  position: string | null;
  companyName: string | null;
  companyUrl: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
  createdAt: string;
  profileConfirmedAt: string | null;
};

type CompetitorView = {
  id: string;
  name: string;
  homepageUrl: string;
  rssUrl: string | null;
};

type DigestView = {
  id: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  itemCount: number;
  items: DigestItemView[];
  // Sum of llm_usage rows tied to this digest (synthesis only — classify
  // is per-(user, raw_item) and not always digest-attributable).
  costMicroUsd: number;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type FteEventRow = {
  id: string;
  runId: string;
  kind: string;
  payload: { [key: string]: JsonValue };
  ts: string;
};

// (digest_item.id) → user's rating on that item. Items absent from the map
// have no rating. Powers PF-57's inline 👍/👎 pill on the admin preview.
type RatingByItemId = Record<string, "up" | "down">;

// PF-58. A user who stops rating is the earliest churn signal we have, so
// expose the aggregate here. Computed cohort-wide (not just the visible
// digests) so the "days since last rating" number is honest even when older
// digests scrolled out of the RECENT_DIGEST_LIMIT window.
type FeedbackHealth = {
  total: number;
  up: number;
  down: number;
  lastRatedAt: string | null;
};

// PoC churn cutoff. Past this, a beta user has effectively stopped reacting
// to digests and the row should glow coral on the admin user-detail surface.
const FEEDBACK_STALE_DAYS = 7;

type DetailLoaderData = {
  profile: ProfileView;
  competitors: CompetitorView[];
  digests: DigestView[];
  ratingByItemId: RatingByItemId;
  feedbackHealth: FeedbackHealth;
  fteRunId: string | null;
  fteEvents: FteEventRow[];
  // Cost of the latest FTE run (sum of llm_usage rows where kind='fte' and
  // run_id = fteRunId). Null when there are no runs yet.
  fteRunCostMicroUsd: number | null;
  lifetimeCostMicroUsd: number;
  auditRows: AdminAuditRow[];
};

const loadUserDetail = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ data }): Promise<DetailLoaderData> => {
    await requireAdminSession();
    const db = getDb();

    const [user] = await db.select().from(users).where(eq(users.id, data.userId)).limit(1);
    if (!user) throw notFound();

    const competitorRows = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(userCompetitors)
      .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
      .where(eq(userCompetitors.userId, user.id))
      .orderBy(asc(competitorsTable.name));

    const digestRows = await db
      .select({
        id: digests.id,
        createdAt: digests.createdAt,
        periodStart: digests.periodStart,
        periodEnd: digests.periodEnd,
        itemCount: digests.itemCount,
      })
      .from(digests)
      .where(eq(digests.userId, user.id))
      .orderBy(desc(digests.createdAt))
      .limit(RECENT_DIGEST_LIMIT);

    const digestIds = digestRows.map((d) => d.id);
    const itemRows = digestIds.length
      ? await db
          .select({
            id: digestItems.id,
            digestId: digestItems.digestId,
            category: digestItems.category,
            headline: digestItems.headline,
            snippet: digestItems.snippet,
            impactNote: digestItems.impactNote,
            score: digestItems.score,
            occurredAt: digestItems.occurredAt,
            sourceUrl: rawItems.url,
          })
          .from(digestItems)
          .innerJoin(rawItems, eq(digestItems.rawItemId, rawItems.id))
          .where(eq(digestItems.userId, user.id))
          .orderBy(desc(digestItems.score), asc(digestItems.createdAt))
      : [];

    const itemsByDigest = new Map<string, DigestItemView[]>();
    for (const row of itemRows) {
      const list = itemsByDigest.get(row.digestId) ?? [];
      list.push({
        id: row.id,
        category: row.category as DigestTag,
        headline: row.headline,
        snippet: row.snippet,
        impactNote: row.impactNote,
        sourceUrl: row.sourceUrl,
        occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
      });
      itemsByDigest.set(row.digestId, list);
    }

    // PF-57. Map (digest_item.id) → user's rating. Scoped to this user so we
    // never bleed another tenant's feedback into the admin preview. Items
    // missing from the map have no rating; the wrapper renders a neutral
    // "no rating" pill in that case.
    const renderedItemIds = itemRows.map((r) => r.id);
    const feedbackRows = renderedItemIds.length
      ? await db
          .select({ digestItemId: feedback.digestItemId, rating: feedback.rating })
          .from(feedback)
          .where(
            and(
              eq(feedback.userId, user.id),
              inArray(feedback.digestItemId, renderedItemIds as [string, ...string[]]),
            ),
          )
      : [];
    const ratingByItemId: RatingByItemId = {};
    for (const r of feedbackRows) {
      ratingByItemId[r.digestItemId] = r.rating;
    }

    // PF-58. Single aggregate over every rating this user has left — counts
    // and last-rated timestamp. count() filter avoids a second query for the
    // up/down split.
    const [healthAgg] = await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        up: sql<number>`COUNT(*) FILTER (WHERE ${feedback.rating} = 'up')::int`,
        down: sql<number>`COUNT(*) FILTER (WHERE ${feedback.rating} = 'down')::int`,
        lastRatedAt: sql<Date | null>`MAX(${feedback.createdAt})`,
      })
      .from(feedback)
      .where(eq(feedback.userId, user.id));
    const feedbackHealth: FeedbackHealth = {
      total: healthAgg?.total ?? 0,
      up: healthAgg?.up ?? 0,
      down: healthAgg?.down ?? 0,
      lastRatedAt: healthAgg?.lastRatedAt ? new Date(healthAgg.lastRatedAt).toISOString() : null,
    };

    const [latestRun] = await db
      .select({ runId: fteEvents.runId, ts: fteEvents.ts })
      .from(fteEvents)
      .where(eq(fteEvents.userId, user.id))
      .orderBy(desc(fteEvents.ts))
      .limit(1);
    const runId = latestRun?.runId ?? null;

    // Per-digest synthesis cost. classify spend is per (user, raw_item) and
    // doesn't always end up tied to one digest, so the per-digest number is
    // intentionally synthesis-only — the lifetime number below absorbs the
    // rest.
    const digestCostRows = digestIds.length
      ? await db
          .select({
            digestId: llmUsage.digestId,
            costMicroUsd: sql<number>`COALESCE(SUM(${llmUsage.costMicroUsd}), 0)::int`,
          })
          .from(llmUsage)
          .where(
            and(
              eq(llmUsage.userId, user.id),
              eq(llmUsage.kind, "synthesize"),
              inArray(llmUsage.digestId, digestIds as [string, ...string[]]),
            ),
          )
          .groupBy(llmUsage.digestId)
      : [];
    const digestCostById = new Map<string, number>();
    for (const row of digestCostRows) {
      if (row.digestId) digestCostById.set(row.digestId, row.costMicroUsd);
    }

    const fteRunCostMicroUsd = runId
      ? ((
          await db
            .select({
              cost: sql<number>`COALESCE(SUM(${llmUsage.costMicroUsd}), 0)::int`,
            })
            .from(llmUsage)
            .where(
              and(
                eq(llmUsage.userId, user.id),
                eq(llmUsage.kind, "fte"),
                eq(llmUsage.runId, runId),
              ),
            )
        )[0]?.cost ?? 0)
      : null;

    const lifetimeCostMicroUsd =
      (
        await db
          .select({
            cost: sql<number>`COALESCE(SUM(${llmUsage.costMicroUsd}), 0)::int`,
          })
          .from(llmUsage)
          .where(eq(llmUsage.userId, user.id))
      )[0]?.cost ?? 0;

    const eventRows: FteEventRow[] = runId
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
            .where(and(eq(fteEvents.userId, user.id), eq(fteEvents.runId, runId)))
            .orderBy(asc(fteEvents.ts))
        ).map((row) => ({
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          payload: (row.payload ?? {}) as { [key: string]: JsonValue },
          ts: row.ts.toISOString(),
        }))
      : [];

    // PF-60. Recent admin activity scoped to this user. Inlined (not in a
    // shared helper) on purpose — a plain-function export from a file with
    // server-only imports leaks pg into the client bundle because
    // TanStack Start's Vite plugin only strips bodies it knows are
    // server-only (createServerFn handlers, route loaders).
    const PER_TARGET_LIMIT = 50;
    const auditRaw = await db
      .select({
        id: adminAudit.id,
        actorId: adminAudit.actorId,
        actorEmail: users.email,
        targetKind: adminAudit.targetKind,
        targetId: adminAudit.targetId,
        action: adminAudit.action,
        payload: adminAudit.payload,
        createdAt: adminAudit.createdAt,
      })
      .from(adminAudit)
      .leftJoin(users, eq(users.id, adminAudit.actorId))
      .where(and(eq(adminAudit.targetKind, "user"), eq(adminAudit.targetId, user.id)))
      .orderBy(desc(adminAudit.createdAt))
      .limit(PER_TARGET_LIMIT);
    const auditRows: AdminAuditRow[] = auditRaw.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorEmail: r.actorEmail,
      targetKind: r.targetKind,
      targetId: r.targetId,
      // Every row targets this same user — the per-user surface hides the
      // target column, so a label resolution round-trip would be wasted.
      targetLabel: user.email,
      action: r.action,
      payload: (r.payload ?? {}) as AdminAuditPayload,
      createdAt: r.createdAt.toISOString(),
    }));

    return {
      profile: {
        id: user.id,
        email: user.email,
        status: user.status,
        role: user.role,
        name: user.name,
        tz: user.tz,
        position: user.position,
        companyName: user.companyName,
        companyUrl: user.companyUrl,
        ultimateGoal: user.ultimateGoal,
        focusAreas: user.focusAreas,
        createdAt: user.createdAt.toISOString(),
        profileConfirmedAt: user.profileConfirmedAt ? user.profileConfirmedAt.toISOString() : null,
      },
      competitors: competitorRows,
      digests: digestRows.map<DigestView>((d) => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        periodStart: d.periodStart ? d.periodStart.toISOString() : null,
        periodEnd: d.periodEnd ? d.periodEnd.toISOString() : null,
        itemCount: d.itemCount,
        items: itemsByDigest.get(d.id) ?? [],
        costMicroUsd: digestCostById.get(d.id) ?? 0,
      })),
      ratingByItemId,
      feedbackHealth,
      fteRunId: runId,
      fteEvents: eventRows,
      fteRunCostMicroUsd,
      lifetimeCostMicroUsd,
      auditRows,
    };
  });

const userIdInput = z.object({ userId: z.string().uuid() });

const triggerFte = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => userIdInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const db = getDb();
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        companyUrl: users.companyUrl,
        position: users.position,
        ultimateGoal: users.ultimateGoal,
      })
      .from(users)
      .where(eq(users.id, data.userId))
      .limit(1);
    if (!user) throw new Error("user_not_found");

    const boss = await getBoss();
    const { runId, enqueued } = await enqueueFteRun(boss, user.id, {
      signup: {
        email: user.email,
        companyUrl: user.companyUrl,
        position: user.position,
        ultimateGoal: user.ultimateGoal,
      },
    });
    logger.info(
      { admin: session.user.email, target: user.email, runId, enqueued },
      "admin: fte re-run enqueued",
    );
    try {
      await db.insert(adminAudit).values({
        actorId: session.user.id,
        targetKind: "user",
        targetId: user.id,
        action: "fte_rerun_enqueued",
        payload: { runId, enqueued },
      });
    } catch (err) {
      logger.error({ err, target: user.id }, "admin_audit_write_failed");
    }
    return { runId, enqueued };
  });

const triggerFastPath = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => userIdInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const db = getDb();
    const boss = await getBoss();
    const { enqueued } = await enqueueFastPath(boss, data.userId);
    logger.info(
      { admin: session.user.email, target: data.userId, enqueued },
      "admin: fast-path re-run enqueued",
    );
    try {
      await db.insert(adminAudit).values({
        actorId: session.user.id,
        targetKind: "user",
        targetId: data.userId,
        action: "fast_path_enqueued",
        payload: { enqueued },
      });
    } catch (err) {
      logger.error({ err, target: data.userId }, "admin_audit_write_failed");
    }
    return { enqueued };
  });

// PF-91. Sibling to triggerFastPath: re-runs score + synthesize with daily
// params (24h / 5 items / cap-2). Skips ingest — re-pulling RSS for a 24h
// window is a no-op since fast-path already populated raw_items. The
// digest upsert keys on (user, today UTC), so today's digest gets
// overwritten in place (id + createdAt survive); if no row exists for
// today yet, one is created.
const triggerDailyRegen = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => userIdInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const db = getDb();
    const boss = await getBoss();
    const { enqueued } = await enqueueDailyRegen(boss, data.userId);
    logger.info(
      { admin: session.user.email, target: data.userId, enqueued },
      "admin: daily-regen enqueued",
    );
    try {
      await db.insert(adminAudit).values({
        actorId: session.user.id,
        targetKind: "user",
        targetId: data.userId,
        action: "daily_regen_enqueued",
        payload: { enqueued },
      });
    } catch (err) {
      logger.error({ err, target: data.userId }, "admin_audit_write_failed");
    }
    return { enqueued };
  });

export const Route = createFileRoute("/admin/users/$userId")({
  loader: ({ params }) => loadUserDetail({ data: { userId: params.userId } }),
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [fteState, setFteState] = useState<"idle" | "running" | "error">("idle");
  const [catchupState, setCatchupState] = useState<"idle" | "running" | "error">("idle");
  const [dailyState, setDailyState] = useState<"idle" | "running" | "error">("idle");
  const [actionNote, setActionNote] = useState<string | null>(null);

  async function onReRunFte() {
    setFteState("running");
    setActionNote(null);
    try {
      const res = await triggerFte({ data: { userId: data.profile.id } });
      setActionNote(
        res.enqueued
          ? `FTE run enqueued (${res.runId.slice(0, 8)}…). Refresh in ~30s for first events.`
          : "FTE run already in flight for this user — no new job enqueued.",
      );
      setFteState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue FTE");
      setFteState("error");
    }
  }

  async function onReGenCatchup() {
    setCatchupState("running");
    setActionNote(null);
    try {
      const res = await triggerFastPath({ data: { userId: data.profile.id } });
      setActionNote(
        res.enqueued
          ? "Catch-up re-gen enqueued (ingest → score → synthesize, 90d window, 10 items). Refresh in ~2–3 min."
          : "Catch-up re-gen already in flight for this user — no new job enqueued.",
      );
      setCatchupState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue catch-up re-gen");
      setCatchupState("error");
    }
  }

  async function onReGenDaily() {
    setDailyState("running");
    setActionNote(null);
    try {
      const res = await triggerDailyRegen({ data: { userId: data.profile.id } });
      setActionNote(
        res.enqueued
          ? "Daily re-gen enqueued (score → synthesize, 24h window, 5 items). Refresh in ~30–60s. Overwrites today's digest in place."
          : "Daily re-gen already in flight for this user — no new job enqueued.",
      );
      setDailyState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue daily re-gen");
      setDailyState("error");
    }
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/admin/users"
          search={{ status: "all", role: "all" }}
          className="mb-6 inline-flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-text-muted hover:text-text"
        >
          <span aria-hidden>←</span> All users
        </Link>

        <ProfileCard profile={data.profile} lifetimeCostMicroUsd={data.lifetimeCostMicroUsd} />

        <ActionsRow
          fteState={fteState}
          catchupState={catchupState}
          dailyState={dailyState}
          actionNote={actionNote}
          onReRunFte={onReRunFte}
          onReGenCatchup={onReGenCatchup}
          onReGenDaily={onReGenDaily}
        />

        <FeedbackHealthBlock health={data.feedbackHealth} />

        <CompetitorsBlock competitors={data.competitors} />

        <DigestsBlock digests={data.digests} ratingByItemId={data.ratingByItemId} />

        <FteTimelineBlock
          runId={data.fteRunId}
          events={data.fteEvents}
          costMicroUsd={data.fteRunCostMicroUsd}
        />

        <AuditBlock rows={data.auditRows} />
      </div>
    </main>
  );
}

function AuditBlock({ rows }: { rows: AdminAuditRow[] }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Recent admin activity</h2>
        <span className="font-mono text-xs text-text-muted">
          {rows.length} {rows.length === 1 ? "event" : "events"}
        </span>
      </div>
      <AdminAuditList
        rows={rows}
        hideTarget
        emptyMessage="No admin actions on this user yet. Re-running the FTE or re-genning a digest above will log here."
      />
    </section>
  );
}

function ProfileCard({
  profile,
  lifetimeCostMicroUsd,
}: {
  profile: ProfileView;
  lifetimeCostMicroUsd: number;
}) {
  return (
    <section className="rounded-2xl border border-ink-line bg-paper-warm p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{profile.email}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <StatusPill status={profile.status} />
            {profile.role === "admin" ? (
              <span className="inline-flex items-center rounded-pill bg-accent-warm/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
                Admin
              </span>
            ) : null}
            <span>Joined {formatDateTime(profile.createdAt)}</span>
            {profile.profileConfirmedAt ? (
              <span>· Confirmed {formatDateTime(profile.profileConfirmedAt)}</span>
            ) : (
              <span>· Profile not yet confirmed</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div
            className="flex items-baseline gap-2"
            title="Lifetime Claude token spend (FTE + classify + synthesize). Firecrawl scrapes are not included."
          >
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-muted">
              lifetime cost
            </span>
            <span className="font-mono text-sm tabular-nums text-text">
              {formatUsd(lifetimeCostMicroUsd)}
            </span>
          </div>
          <code className="font-mono text-xs text-text-muted">{profile.id}</code>
        </div>
      </div>

      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        <Detail label="Name" value={profile.name} />
        <Detail label="Timezone" value={profile.tz} />
        <Detail label="Role" value={profile.position} />
        <Detail
          label="Company"
          value={
            profile.companyName
              ? profile.companyUrl
                ? `${profile.companyName} · ${profile.companyUrl}`
                : profile.companyName
              : profile.companyUrl
          }
        />
      </div>

      <div className="mt-5">
        <Detail label="Ultimate goal" value={profile.ultimateGoal} />
      </div>

      <div className="mt-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          Focus areas
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {profile.focusAreas && profile.focusAreas.length > 0 ? (
            profile.focusAreas.map((area) => (
              <span
                key={area}
                className="rounded-pill bg-accent/30 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-text"
              >
                {area}
              </span>
            ))
          ) : (
            <span className="text-sm text-text-muted">—</span>
          )}
        </div>
      </div>
    </section>
  );
}

function ActionsRow({
  fteState,
  catchupState,
  dailyState,
  actionNote,
  onReRunFte,
  onReGenCatchup,
  onReGenDaily,
}: {
  fteState: "idle" | "running" | "error";
  catchupState: "idle" | "running" | "error";
  dailyState: "idle" | "running" | "error";
  actionNote: string | null;
  onReRunFte: () => void;
  onReGenCatchup: () => void;
  onReGenDaily: () => void;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="default"
          onClick={onReRunFte}
          disabled={fteState === "running"}
        >
          {fteState === "running" ? "Enqueuing…" : "Re-run FTE agent"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onReGenCatchup}
          disabled={catchupState === "running"}
          title="Full pipeline (ingest → score → synthesize) over the last 90 days, 10 items, cap-3 per competitor. Ingest re-pulls feeds so newly-posted items land before scoring."
        >
          {catchupState === "running" ? "Enqueuing…" : "Re-gen catch-up"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onReGenDaily}
          disabled={dailyState === "running"}
          title="Score + synthesize with daily params: 24h window, 5 items, cap-2 per competitor. Skips ingest. Overwrites today's digest in place (id survives)."
        >
          {dailyState === "running" ? "Enqueuing…" : "Re-gen daily"}
        </Button>
        <p className="text-xs text-text-muted">
          All queues are singleton-per-user — a duplicate click while a job is in flight is a no-op.
        </p>
      </div>
      {actionNote ? (
        <p className="mt-3 rounded-md border border-ink-line bg-paper px-3 py-2 font-mono text-xs text-text">
          {actionNote}
        </p>
      ) : null}
    </section>
  );
}

function FeedbackHealthBlock({ health }: { health: FeedbackHealth }) {
  const ratio = health.total > 0 ? `${Math.round((health.up / health.total) * 100)}%` : "—";
  const lastRatedDate = health.lastRatedAt
    ? new Date(health.lastRatedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  const daysSince =
    health.lastRatedAt !== null
      ? Math.floor((Date.now() - new Date(health.lastRatedAt).getTime()) / 86_400_000)
      : null;
  const isStale = daysSince === null || daysSince >= FEEDBACK_STALE_DAYS;
  const daysLabel =
    daysSince === null
      ? "never"
      : daysSince === 0
        ? "today"
        : daysSince === 1
          ? "1 day"
          : `${daysSince} days`;
  return (
    <section className="mt-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-text-muted">
          Feedback health
        </h2>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted"
          title="A user who stops rating is the earliest churn signal we have. Coral = ≥7d since last rating."
        >
          churn signal
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Total ratings" value={String(health.total)} />
        <Stat
          label="👍 / 👎"
          value={health.total > 0 ? `${health.up} / ${health.down}` : "—"}
          sub={health.total > 0 ? `${ratio} 👍` : null}
        />
        <Stat label="Last rated" value={lastRatedDate ?? "—"} />
        <Stat label="Days since" value={daysLabel} tone={isStale ? "stale" : "ok"} />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: "ok" | "stale";
}) {
  const valueTone = tone === "stale" ? "text-coral" : "text-text";
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className={`mt-1 font-mono text-lg tabular-nums ${valueTone}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-text-muted">{sub}</div> : null}
    </div>
  );
}

function CompetitorsBlock({ competitors }: { competitors: CompetitorView[] }) {
  return (
    <section className="mt-6 rounded-2xl border border-ink-line bg-paper-warm p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Competitors</h2>
        <span className="font-mono text-xs text-text-muted">{competitors.length} tracked</span>
      </div>
      {competitors.length === 0 ? (
        <p className="mt-3 text-sm text-text-muted">
          None linked yet. The FTE agent populates this on signup; re-run above if it stalled.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-line overflow-hidden rounded-md border border-ink-line bg-paper">
          {competitors.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-text">{c.name}</div>
                <a
                  href={c.homepageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-mono text-[11px] text-text-muted hover:text-text"
                >
                  {c.homepageUrl}
                </a>
              </div>
              {c.rssUrl ? (
                <a
                  href={c.rssUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-pill bg-accent/30 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-text"
                >
                  rss
                </a>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-muted">
                  no rss
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DigestsBlock({
  digests,
  ratingByItemId,
}: {
  digests: DigestView[];
  ratingByItemId: RatingByItemId;
}) {
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Recent digests</h2>
        <span className="font-mono text-xs text-text-muted">
          last {Math.min(digests.length, RECENT_DIGEST_LIMIT)}
        </span>
      </div>
      {digests.length === 0 ? (
        <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
          No digests yet. Re-gen the catch-up above to generate one.
        </p>
      ) : (
        <div className="grid gap-6">
          {digests.map((d) => (
            <DigestPreviewCard key={d.id} digest={d} ratingByItemId={ratingByItemId} />
          ))}
        </div>
      )}
    </section>
  );
}

// Inline preview of one digest using the same DigestItemCard /app/digests/:id
// uses. We render the dark frame on a light admin background by design — it
// makes the embedded preview visually distinct from admin chrome and
// matches what the user actually sees.
function DigestPreviewCard({
  digest,
  ratingByItemId,
}: {
  digest: DigestView;
  ratingByItemId: RatingByItemId;
}) {
  const period = deriveDigestPeriod({
    periodStart: digest.periodStart,
    periodEnd: digest.periodEnd,
  });
  const created = new Date(digest.createdAt);
  const fallbackDateLabel = created
    .toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
  const fallbackTimeLabel = created.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const headerLabel = period.kind === "catchup" ? "catch-up brief" : "daily brief";
  const headerMetaLabel =
    period.rangeLabel?.toUpperCase() ?? `${fallbackDateLabel} · ${fallbackTimeLabel}`;
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft text-white"
      style={{ boxShadow: "0 20px 40px -20px rgba(0,0,0,0.5)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-6 py-4">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Product Flash</strong> · {headerLabel}
        </div>
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-xs text-[#888]"
            title="Synthesis-only — classify cost rolls up into lifetime cost."
          >
            {formatUsd(digest.costMicroUsd)}
          </span>
          <span className="font-mono text-xs text-[#666]">{headerMetaLabel}</span>
        </div>
      </div>
      <div className="px-6 py-6">
        {digest.items.length === 0 ? (
          <p className="py-4 text-center text-sm text-[#a8a8b8]">
            Empty digest — nothing notable that day.
          </p>
        ) : (
          digest.items.map((item, idx) => (
            <AdminDigestItem
              key={item.id}
              item={item}
              rating={ratingByItemId[item.id] ?? null}
              isLast={idx === digest.items.length - 1}
            />
          ))
        )}
      </div>
    </div>
  );
}

// PF-57. Admin-only thin wrapper over DigestItemCard. Renders a small pill
// in the top-right corner showing the user's 👍 / 👎 / no-rating state.
// Lives here (not next to DigestItemCard) so the user-facing card stays
// neutral — admin context bleeds nothing into /app/digests/:id.
function AdminDigestItem({
  item,
  rating,
  isLast,
}: {
  item: DigestItemView;
  rating: "up" | "down" | null;
  isLast: boolean;
}) {
  return (
    <div className="relative">
      <div className="absolute right-0 top-6 z-10">
        <RatingPill rating={rating} />
      </div>
      <DigestItemCard item={item} isLast={isLast} />
    </div>
  );
}

function RatingPill({ rating }: { rating: "up" | "down" | null }) {
  if (rating === "up") {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-accent/25 px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">
        👍 Liked
      </span>
    );
  }
  if (rating === "down") {
    return (
      <span className="inline-flex items-center gap-1 rounded-pill bg-coral/25 px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.1em] text-coral">
        👎 Disliked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-pill border border-[#3a3a48] bg-transparent px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.1em] text-[#666]">
      no rating
    </span>
  );
}

function FteTimelineBlock({
  runId,
  events,
  costMicroUsd,
}: {
  runId: string | null;
  events: FteEventRow[];
  costMicroUsd: number | null;
}) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold tracking-tight">FTE event timeline</h2>
        {runId ? (
          <span
            className="font-mono text-xs text-text-muted"
            title="Onboarding cost = Sonnet tokens + web_search surcharge for this run. Firecrawl not included."
          >
            run {runId.slice(0, 8)}… · {events.length} events ·{" "}
            <span className="text-text">{formatUsd(costMicroUsd ?? 0)}</span>
          </span>
        ) : (
          <span className="font-mono text-xs text-text-muted">no runs yet</span>
        )}
      </div>
      {events.length === 0 ? (
        <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
          The agent hasn't run for this user yet, or its events have been pruned.
        </p>
      ) : (
        <ol className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm font-mono text-xs">
          {events.map((event) => (
            <FteEventRowItem key={event.id} event={event} />
          ))}
        </ol>
      )}
    </section>
  );
}

function FteEventRowItem({ event }: { event: FteEventRow }) {
  const ts = new Date(event.ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return (
    <li className="grid grid-cols-[80px_140px_1fr] gap-3 px-4 py-2">
      <span className="text-text-muted">{ts}</span>
      <span className={`font-semibold ${kindTone(event.kind)}`}>{event.kind}</span>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-text">
        {summarizePayload(event.kind, event.payload)}
      </pre>
    </li>
  );
}

function kindTone(kind: string): string {
  switch (kind) {
    case "planner_text":
      return "text-text";
    case "tool_use":
    case "server_tool_use":
      return "text-coral";
    case "tool_result":
    case "web_search_tool_result":
      return "text-text-muted";
    case "run_started":
    case "run_finished":
      return "text-text";
    case "error":
      return "text-coral";
    default:
      return "text-text-muted";
  }
}

const MAX_PAYLOAD_PREVIEW = 280;

function summarizePayload(kind: string, payload: { [key: string]: JsonValue }): string {
  if (kind === "planner_text" && typeof payload.text === "string") {
    return truncate(payload.text, MAX_PAYLOAD_PREVIEW);
  }
  if (kind === "tool_use" || kind === "tool_result") {
    const name = typeof payload.name === "string" ? payload.name : "?";
    const input = payload.input ?? payload.output ?? payload.result ?? payload.error ?? null;
    const rest = input != null ? `  ${truncate(JSON.stringify(input), MAX_PAYLOAD_PREVIEW)}` : "";
    return `${name}${rest}`;
  }
  return truncate(JSON.stringify(payload), MAX_PAYLOAD_PREVIEW);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}…`;
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 text-sm text-text">
        {value && value.length > 0 ? value : <span className="text-text-muted">—</span>}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-accent/30 text-text"
      : status === "onboarding"
        ? "bg-coral/20 text-text"
        : status === "paused"
          ? "bg-ink-line text-text-muted"
          : "bg-ink/10 text-text-muted";
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${tone}`}
    >
      {status}
    </span>
  );
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
