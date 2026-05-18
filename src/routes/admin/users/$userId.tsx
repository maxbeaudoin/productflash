import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { useState } from "react";
import { z } from "zod";
import { enqueueFteRun } from "~/agents/fte/job";
import { Button } from "~/components/ui/button";
import { DigestItemCard, type DigestItemView } from "~/features/digest/ui/DigestItemCard";
import {
  competitors as competitorsTable,
  digestItems,
  digests,
  fteEvents,
  llmUsage,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import { enqueueFastPath } from "~/features/digest/server/jobs/fast-path";
import { requireAdminSession } from "~/shared/server/auth-server";
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

type DetailLoaderData = {
  profile: ProfileView;
  competitors: CompetitorView[];
  digests: DigestView[];
  fteRunId: string | null;
  fteEvents: FteEventRow[];
  // Cost of the latest FTE run (sum of llm_usage rows where kind='fte' and
  // run_id = fteRunId). Null when there are no runs yet.
  fteRunCostMicroUsd: number | null;
  lifetimeCostMicroUsd: number;
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
      fteRunId: runId,
      fteEvents: eventRows,
      fteRunCostMicroUsd,
      lifetimeCostMicroUsd,
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
    return { runId, enqueued };
  });

const triggerFastPath = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => userIdInput.parse(data))
  .handler(async ({ data }) => {
    const session = await requireAdminSession();
    const boss = await getBoss();
    const { enqueued } = await enqueueFastPath(boss, data.userId);
    logger.info(
      { admin: session.user.email, target: data.userId, enqueued },
      "admin: fast-path re-run enqueued",
    );
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
  const [fastState, setFastState] = useState<"idle" | "running" | "error">("idle");
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

  async function onReRunFastPath() {
    setFastState("running");
    setActionNote(null);
    try {
      const res = await triggerFastPath({ data: { userId: data.profile.id } });
      setActionNote(
        res.enqueued
          ? "Fast-path digest enqueued. Refresh in ~2–3 min to see the new digest."
          : "Fast-path already in flight for this user — no new job enqueued.",
      );
      setFastState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue fast-path");
      setFastState("error");
    }
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/admin/users"
          className="mb-6 inline-flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-text-muted hover:text-text"
        >
          <span aria-hidden>←</span> All users
        </Link>

        <ProfileCard profile={data.profile} lifetimeCostMicroUsd={data.lifetimeCostMicroUsd} />

        <ActionsRow
          fteState={fteState}
          fastState={fastState}
          actionNote={actionNote}
          onReRunFte={onReRunFte}
          onReRunFastPath={onReRunFastPath}
        />

        <CompetitorsBlock competitors={data.competitors} />

        <DigestsBlock digests={data.digests} />

        <FteTimelineBlock
          runId={data.fteRunId}
          events={data.fteEvents}
          costMicroUsd={data.fteRunCostMicroUsd}
        />
      </div>
    </main>
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
  fastState,
  actionNote,
  onReRunFte,
  onReRunFastPath,
}: {
  fteState: "idle" | "running" | "error";
  fastState: "idle" | "running" | "error";
  actionNote: string | null;
  onReRunFte: () => void;
  onReRunFastPath: () => void;
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
          onClick={onReRunFastPath}
          disabled={fastState === "running"}
        >
          {fastState === "running" ? "Enqueuing…" : "Re-trigger digest"}
        </Button>
        <p className="text-xs text-text-muted">
          Both queues are singleton-per-user — a duplicate click while a job is in flight is a
          no-op.
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

function DigestsBlock({ digests }: { digests: DigestView[] }) {
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
          No digests yet. Re-trigger the fast-path above to generate one.
        </p>
      ) : (
        <div className="grid gap-6">
          {digests.map((d) => (
            <DigestPreviewCard key={d.id} digest={d} />
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
function DigestPreviewCard({ digest }: { digest: DigestView }) {
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
            <DigestItemCard key={item.id} item={item} isLast={idx === digest.items.length - 1} />
          ))
        )}
      </div>
    </div>
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
