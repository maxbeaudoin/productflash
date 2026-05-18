import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addCompetitor,
  type CompetitorView,
  removeCompetitor,
} from "~/features/competitors/server/fns";
import { CompetitorsList } from "~/features/competitors/ui/competitors-list";
import { onboardingProfileFormSchema } from "~/features/profile/schema";
import { ProfileEditor, type ProfileEditorValues } from "~/features/profile/ui/profile-editor";
import { ProfileFields } from "~/features/profile/ui/profile-fields";
import {
  competitors as competitorsTable,
  fteEvents,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import { enqueueFastPath } from "~/jobs/fast-path";
import { requireSession } from "~/shared/server/auth-server";
import { getBoss } from "~/shared/server/boss";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";

// /app/onboarding (#29). First stop after the magic-link click.
//
// Renders the FTE agent's reasoning as first-class "thinking step" cards —
// one per planner_text event, live-streamed via text deltas. Tool activity
// is summarized into ambient counters at the top; the raw event log is the
// admin app's job (#16), not something end users should see.
//
// When the agent finishes (or finished before the page loaded), the profile
// preview reveals: read-only profile fields + an inline competitor list
// where the user can remove or add entries before confirming. "Looks good"
// stamps profile_confirmed_at + flips status to 'active' and triggers the
// on-demand fast-path ingest → score → synthesize chain (#30) so the first
// digest lands within minutes instead of waiting for the 05:30 UTC cron.

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type FteEventRow = {
  id: string;
  runId: string;
  kind: string;
  payload: { [key: string]: JsonValue };
  ts: string;
};

type ProfileView = {
  position: string | null;
  companyName: string | null;
  companyUrl: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
  profileConfirmedAt: string | null;
};

type OnboardingLoaderData = {
  runId: string | null;
  events: FteEventRow[];
  profile: ProfileView;
  competitors: CompetitorView[];
};

const loadOnboarding = createServerFn({ method: "GET" }).handler(
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

// editProfile lives in-route here (and not in lib/server) because it has
// onboarding-specific semantics that the settings variant doesn't share:
// (a) `companyUrl` is NOT user-editable mid-onboarding (the agent already
// pinned it from the signup form), and (b) we do NOT wipe itemScores —
// no scores exist yet (the fast-path runs after confirmProfile below).
const editProfile = createServerFn({ method: "POST" })
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

const confirmProfile = createServerFn({ method: "POST" }).handler(async () => {
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

export const Route = createFileRoute("/app/onboarding")({
  loader: () => loadOnboarding(),
  component: OnboardingPage,
});

function OnboardingPage() {
  const loaded = Route.useLoaderData();
  const router = useRouter();

  const [events, setEvents] = useState<FteEventRow[]>(loaded.events);
  const [streamingText, setStreamingText] = useState("");
  const [streamingActive, setStreamingActive] = useState(false);
  // `pendingThoughts` bridges the gap between (a) a text block completing on
  // the wire — Anthropic SDK fires `contentBlock` *at the END* of each block —
  // and (b) the durable `planner_text` event landing in fte_events, which only
  // happens after `stream.finalMessage()` resolves for the whole iteration.
  // Without this queue, the streamed text vanishes the instant the block ends
  // and reappears (with markdown) once the durable event finally arrives —
  // the disappear/reappear flicker dogfood iter 2 flagged on 2026-05-16.
  const [pendingThoughts, setPendingThoughts] = useState<string[]>([]);
  // Mirror the streamed text in a ref so the block-end snapshot reads the
  // latest value without nesting setState updaters. The earlier
  // setStreamingText(prev => { setPendingThoughts(...); return ''; }) pattern
  // double-pushed under concurrent rendering (dogfood iter 3 — cards counted
  // up to ~#13 then collapsed to ~6 once save_profile cleared pending).
  const streamingTextRef = useRef("");
  const [profile, setProfile] = useState<ProfileView>(loaded.profile);
  const [competitors, setCompetitors] = useState<CompetitorView[]>(loaded.competitors);
  const [editingProfile, setEditingProfile] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [addingCompetitor, setAddingCompetitor] = useState(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const profileSectionRef = useRef<HTMLElement | null>(null);
  // Capture whether the run was already finished at page-load. If yes, the
  // user is just revisiting an already-onboarded view — auto-scrolling to the
  // profile would hijack their scroll position. We only auto-jump on the
  // *transition* from running → finished.
  const wasFinishedOnMountRef = useRef<boolean | null>(null);
  const scrolledToProfileRef = useRef(false);

  const runId = useMemo(() => {
    return events[0]?.runId ?? loaded.runId;
  }, [events, loaded.runId]);

  const finished = useMemo(() => events.some((e) => e.kind === "run_finished"), [events]);

  // After save_profile fires (or the run wraps up), the agent might still
  // emit a recap text block — we suppress both the durable card (via the
  // cutoff below) AND the live composing card so nothing flashes up only
  // to vanish.
  const wrappingUp = useMemo(
    () =>
      events.some(
        (e) =>
          (e.kind === "tool_use" && e.payload.name === "save_profile") || e.kind === "run_finished",
      ),
    [events],
  );

  // The agent is briefed to stop after save_profile, but Sonnet sometimes
  // still emits a recap (with a markdown table and emoji headers) — that
  // duplicates the profile card below and feels like a verbatim log. Cut
  // off planner_text events that arrived after save_profile fired.
  const thoughts = useMemo(() => {
    const cutoffTs = findSaveProfileTs(events);
    return events
      .filter((e) => e.kind === "planner_text")
      .filter((e) => cutoffTs === null || Date.parse(e.ts) <= cutoffTs)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        text: typeof e.payload.text === "string" ? e.payload.text : "",
      }))
      .filter((t) => t.text.trim().length > 0);
  }, [events]);

  // Ephemeral "what's happening right now" line — derived from the latest
  // tool_use / server_tool_use event. Replaces the previous status as the
  // agent moves forward; cards above it stay as the historical narrative.
  const liveStatus = useMemo(() => computeLiveStatus(events), [events]);

  const stats = useMemo(() => buildStats(events), [events]);

  useEffect(() => {
    const source = new EventSource("/api/onboarding/stream");

    source.addEventListener("event", (raw) => {
      try {
        const row = JSON.parse((raw as MessageEvent).data) as FteEventRow;
        setEvents((prev) => {
          if (prev.some((e) => e.id === row.id)) return prev;
          return [...prev, row];
        });
        if (row.kind === "planner_text") {
          // The durable counterpart of the oldest pending snapshot just landed.
          // FIFO-pop so the pending card hands off to the durable one (which
          // renders parsed markdown). If the pending queue is empty (e.g. the
          // run replay path on initial load), this is a no-op.
          setPendingThoughts((q) => (q.length > 0 ? q.slice(1) : q));
        }
      } catch {
        // Bad payload — ignore.
      }
    });

    source.addEventListener("delta", (raw) => {
      try {
        const d = JSON.parse((raw as MessageEvent).data) as {
          kind: "text_delta" | "tool_input_delta" | "block_start";
          delta: string;
          blockKind?: string;
        };
        if (d.kind === "block_start") {
          // `contentBlock` in the Anthropic SDK fires when a block COMPLETES,
          // not when it starts. `block_start: blockKind=text` means "the text
          // block we were streaming just finished." Read the captured text
          // from the ref (always current), push to pending, clear both ref
          // and state. Two setState calls run sequentially in the event-loop
          // callback — no nesting, no double-push under concurrent rendering.
          if (d.blockKind === "text") {
            const captured = streamingTextRef.current;
            streamingTextRef.current = "";
            setStreamingText("");
            setStreamingActive(false);
            if (captured.trim().length > 0) {
              setPendingThoughts((q) => [...q, captured]);
            }
          } else {
            // Non-text block completed (tool_use / server_tool_use). Streamed
            // text state is unaffected — text deltas don't arrive during
            // these. Just turn the caret off in case it was still on.
            setStreamingActive(false);
          }
        } else if (d.kind === "text_delta") {
          streamingTextRef.current += d.delta;
          setStreamingActive(true);
          setStreamingText(streamingTextRef.current);
        }
      } catch {
        // Bad payload — ignore.
      }
    });

    source.onerror = () => {
      // Browser auto-reconnects. Nothing to do.
    };

    return () => source.close();
  }, []);

  useEffect(() => {
    if (!finished) return;
    void router.invalidate();
  }, [finished, router]);

  // Snapshot the finished state on first render so we can distinguish
  // "run just completed in this session" from "revisiting a finished run".
  // Only the former gets the auto-jump to the profile preview.
  useEffect(() => {
    if (wasFinishedOnMountRef.current === null) {
      wasFinishedOnMountRef.current = finished;
    }
  }, [finished]);

  useEffect(() => {
    setProfile(loaded.profile);
    setCompetitors(loaded.competitors);
  }, [loaded.profile, loaded.competitors]);

  async function onConfirm() {
    setConfirming(true);
    try {
      await confirmProfile();
      await router.navigate({ to: "/app/digests" });
    } catch {
      setConfirming(false);
    }
  }

  async function onSaveEdit(next: ProfileEditorValues) {
    await editProfile({
      data: {
        position: next.position,
        companyName: next.companyName,
        ultimateGoal: next.ultimateGoal,
        focusAreas: next.focusAreas,
      },
    });
    setProfile((prev) => ({
      ...prev,
      position: next.position,
      companyName: next.companyName,
      ultimateGoal: next.ultimateGoal,
      focusAreas: next.focusAreas,
    }));
    setEditingProfile(false);
  }

  async function onAddCompetitor(input: { name: string; homepageUrl: string }) {
    const res = await addCompetitor({ data: input });
    setCompetitors((prev) =>
      prev.some((c) => c.id === res.competitor.id)
        ? prev
        : [...prev, res.competitor].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAddingCompetitor(false);
  }

  async function onRemoveCompetitor(competitor: CompetitorView) {
    const previous = competitors;
    setCompetitors((prev) => prev.filter((c) => c.id !== competitor.id));
    try {
      await removeCompetitor({ data: { competitorId: competitor.id } });
    } catch {
      setCompetitors(previous);
      await router.invalidate();
    }
  }

  const profileReady =
    finished &&
    !!profile.position &&
    !!profile.ultimateGoal &&
    (profile.focusAreas?.length ?? 0) > 0;

  // On the running → finished transition, once the profile preview is
  // mounted, smooth-scroll the page so the top of the card sits ~24px below
  // the viewport top. Guarded by `wasFinishedOnMountRef` so a page reload
  // onto an already-finished run doesn't yank the user's scroll position.
  //
  // Implementation note: dogfood iter 3 second pass landed `scrollIntoView`
  // with `block: 'start'`, but on completion the page ended up at the
  // BOTTOM of the profile preview — `scrollIntoView` was firing before the
  // newly-mounted section's layout had settled, so the measured top was
  // stale. Switching to a double-rAF (which guarantees one full paint has
  // happened) + `window.scrollTo` with explicit `getBoundingClientRect`
  // math gives a deterministic landing position regardless of late-mounting
  // children inside the section.
  useEffect(() => {
    if (!profileReady) return;
    if (scrolledToProfileRef.current) return;
    if (wasFinishedOnMountRef.current !== false) return;
    const node = profileSectionRef.current;
    if (!node) return;
    scrolledToProfileRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const targetY = window.scrollY + rect.top - 24;
        window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
      });
    });
  }, [profileReady]);

  return (
    <main className="mx-auto max-w-[920px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 inline-flex items-center gap-[10px] text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          <span
            aria-hidden
            className={`h-[6px] w-[6px] rounded-full ${finished ? "bg-accent" : "animate-pulse bg-coral"}`}
            style={{ boxShadow: "0 0 12px var(--color-accent)" }}
          />
          {finished ? "Onboarding complete" : "Onboarding in progress"}
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          {finished ? "Your AI analyst is ready." : "Your AI analyst is thinking…"}
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          {finished
            ? "Below is the map and profile it built. Tweak anything that looks off, then confirm to land your first digest."
            : "Mapping your competitive space in real time — usually a minute or two. Feel free to keep this open and watch."}
        </p>
        <ProgressChips stats={stats} running={!finished} />
      </header>

      <ThinkingStream
        thoughts={thoughts}
        pendingThoughts={wrappingUp ? [] : pendingThoughts}
        streamingText={streamingText}
        streamingActive={streamingActive && !wrappingUp}
        liveStatus={liveStatus}
        running={!finished}
        hasRun={Boolean(runId) || events.length > 0}
        streamEndRef={streamEndRef}
      />

      {profileReady ? (
        <section ref={profileSectionRef} className="mt-10">
          {editingProfile ? (
            <ProfileEditor
              initial={profile}
              variant="onboarding"
              onCancel={() => setEditingProfile(false)}
              onSave={onSaveEdit}
            />
          ) : (
            <ProfilePreviewCard
              profile={profile}
              competitors={competitors}
              onEditProfile={() => setEditingProfile(true)}
              onConfirm={onConfirm}
              confirming={confirming}
              addingCompetitor={addingCompetitor}
              onShowAdd={() => setAddingCompetitor(true)}
              onHideAdd={() => setAddingCompetitor(false)}
              onAddCompetitor={onAddCompetitor}
              onRemoveCompetitor={onRemoveCompetitor}
            />
          )}
        </section>
      ) : null}
    </main>
  );
}

// ---- thinking stream --------------------------------------------------

type Stats = {
  pagesRead: number;
  webSearches: number;
  competitorsAdded: number;
  elapsedMs: number | null;
};

function findSaveProfileTs(events: FteEventRow[]): number | null {
  for (const e of events) {
    if (e.kind === "tool_use" && e.payload.name === "save_profile") {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) ? t : null;
    }
  }
  return null;
}

function buildStats(events: FteEventRow[]): Stats {
  let pagesRead = 0;
  let webSearches = 0;
  let competitorsAdded = 0;
  let startTs: number | null = null;
  let lastTs: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) {
      if (startTs === null) startTs = t;
      lastTs = t;
    }
    if (e.kind === "tool_result") {
      const name = typeof e.payload.name === "string" ? e.payload.name : "";
      if (name === "fetch_url" && !e.payload.error) pagesRead++;
      if (name === "add_competitor" && !e.payload.error) competitorsAdded++;
    } else if (e.kind === "server_tool_use") {
      webSearches++;
    }
  }
  return {
    pagesRead,
    webSearches,
    competitorsAdded,
    elapsedMs: startTs !== null && lastTs !== null ? lastTs - startTs : null,
  };
}

function ProgressChips({ stats, running }: { stats: Stats; running: boolean }) {
  const items: Array<{ label: string; value: string | null }> = [
    { label: "pages read", value: stats.pagesRead ? String(stats.pagesRead) : null },
    {
      label: "web searches",
      value: stats.webSearches ? String(stats.webSearches) : null,
    },
    {
      label: "competitors",
      value: stats.competitorsAdded ? String(stats.competitorsAdded) : null,
    },
    {
      label: "elapsed",
      value: stats.elapsedMs ? formatElapsed(stats.elapsedMs) : null,
    },
  ];
  const visible = items.filter((i) => i.value);
  if (visible.length === 0) return null;
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      {visible.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-[8px] rounded-pill border border-[#2a2a38] bg-ink-soft/60 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a8a8b8]"
        >
          <span className="font-mono text-xs tracking-normal text-accent">{item.value}</span>
          {item.label}
        </span>
      ))}
      {running ? (
        <span className="inline-flex items-center gap-[8px] rounded-pill bg-coral/15 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.12em] text-coral">
          <span aria-hidden className="h-[6px] w-[6px] animate-pulse rounded-full bg-coral" />
          live
        </span>
      ) : null}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function ThinkingStream({
  thoughts,
  pendingThoughts,
  streamingText,
  streamingActive,
  liveStatus,
  running,
  hasRun,
  streamEndRef,
}: {
  thoughts: Array<{ id: string; ts: string; text: string }>;
  pendingThoughts: string[];
  streamingText: string;
  streamingActive: boolean;
  liveStatus: string | null;
  running: boolean;
  hasRun: boolean;
  streamEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Auto-scroll the bottom anchor into view as content lands. Dogfood iter 3
  // (round 2) asked for visibly animated scrolling — the iter-3-round-1 fix
  // used `behavior: 'auto'` for text-delta updates to avoid mid-tween
  // interruptions, but the resulting snap-snap-snap motion read as "not very
  // animated". Browsers handle a smooth-scroll being re-issued mid-animation
  // by gracefully redirecting toward the new target, so we just use smooth
  // for everything and let the browser chase the moving end-of-stream. The
  // 600px proximity gate still freezes the follow when the user scrolls up
  // to re-read; rAF defers the scroll until layout has settled.
  useEffect(() => {
    if (!running) return;
    const node = streamEndRef.current;
    if (!node) return;
    const distanceFromBottom =
      document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
    if (distanceFromBottom > 600) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }, [
    running,
    streamingText,
    streamingActive,
    thoughts.length,
    pendingThoughts.length,
    streamEndRef,
  ]);

  if (!hasRun) {
    return (
      <div className="rounded-card-lg border border-dashed border-[#2a2a38] bg-ink-soft px-7 py-12 text-center">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
          Warming up
        </div>
        <p className="text-[15px] text-[#a8a8b8]">
          Your analyst will start any moment now. If nothing happens within a minute, refresh the
          page.
        </p>
      </div>
    );
  }

  const showLive = running && streamingActive;
  const pendingStart = thoughts.length + 1;
  const liveIndex = thoughts.length + pendingThoughts.length + 1;

  return (
    <div>
      <ol className="grid gap-4">
        {thoughts.map((thought, idx) => (
          <DurableThought key={thought.id} index={idx + 1} text={thought.text} />
        ))}
        {pendingThoughts.map((text, idx) => (
          // Pending: the streamed text we already saw on the wire, frozen
          // here until its durable planner_text event lands. Same parsed
          // markdown body as a durable card — the swap to durable is a no-op
          // visual change. Key includes the text length so React doesn't
          // confuse the slot when the next pending pushes in.
          <PendingThought
            key={`pending-${pendingStart + idx}-${text.length}`}
            index={pendingStart + idx}
            text={text}
          />
        ))}
        {showLive ? <LiveThought key="live" index={liveIndex} text={streamingText} /> : null}
      </ol>
      {/* Status sits at the BOTTOM (dogfood iter 3) so the auto-scroll target
          and the "what's happening" indicator are the same element — the
          status is always in view by virtue of the page following the stream
          downward. */}
      <BottomStatusLine status={liveStatus} running={running} />
      <div ref={streamEndRef} aria-hidden className="h-px" />
    </div>
  );
}

// Live + durable cards share identical chrome. The only differences:
// LiveThought renders plain text with a trailing caret; DurableThought
// renders parsed markdown without a caret. When a planner_text durable
// event lands, React swaps the keyed live node out and the new durable
// node in at the same position — same border, same shadow, same badge,
// so the transition reads as "cursor goes away, formatting kicks in".
function ThoughtCard({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <li
      className="relative grid grid-cols-[auto_1fr] gap-5 rounded-card-lg border border-[#2a2a38] bg-ink-soft px-7 py-6"
      style={{ boxShadow: "0 20px 40px -20px rgba(0,0,0,0.5)" }}
    >
      <div className="flex flex-col items-center">
        <div className="flex h-8 w-8 items-center justify-center rounded-full border border-[#2a2a38] bg-ink font-mono text-[12px] font-bold text-[#8a8a98]">
          {index.toString().padStart(2, "0")}
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function DurableThought({ index, text }: { index: number; text: string }) {
  return (
    <ThoughtCard index={index}>
      <ThoughtBody text={text} />
    </ThoughtCard>
  );
}

function LiveThought({ index, text }: { index: number; text: string }) {
  return (
    <ThoughtCard index={index}>
      <PlainStreamingBody text={text} />
    </ThoughtCard>
  );
}

// Bridge card: streamed text we've already shown the user, awaiting the
// durable planner_text event so it can be replaced by the canonical version.
// Renders with the SAME parsed-markdown body as a durable card — the text is
// complete at this point (the block ended on the wire), so there's no risk of
// half-typed `**bold` flickering. This way the durable arrival is a no-op
// visual swap rather than a delayed plain-text → markdown reformat (the
// markdown lag dogfood iter 3 flagged).
function PendingThought({ index, text }: { index: number; text: string }) {
  return (
    <ThoughtCard index={index}>
      <ThoughtBody text={text} />
    </ThoughtCard>
  );
}

// Light prose renderer for durable planner_text. Splits on blank-line
// paragraph breaks and lifts `**bold**` runs to <strong>. Live streaming
// uses PlainStreamingBody so half-typed `**bold` doesn't flicker as
// markup parsing kicks in and out.
function ThoughtBody({ text }: { text: string }) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) {
    return <p className="text-[15px] text-[#a8a8b8]">…</p>;
  }
  return (
    <div className="grid gap-3 text-[15px] leading-[1.65] text-white">
      {paragraphs.map((para, i) => (
        <p key={i} className="whitespace-pre-wrap">
          {renderInline(para)}
        </p>
      ))}
    </div>
  );
}

function PlainStreamingBody({ text }: { text: string }) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) {
    return (
      <p className="text-[15px] leading-[1.65] text-white">
        <Caret />
      </p>
    );
  }
  return (
    <div className="grid gap-3 text-[15px] leading-[1.65] text-white">
      {paragraphs.map((para, i) => {
        const isLast = i === paragraphs.length - 1;
        return (
          <p key={i} className="whitespace-pre-wrap">
            {para}
            {isLast ? <Caret /> : null}
          </p>
        );
      })}
    </div>
  );
}

function Caret() {
  return (
    <span
      aria-hidden
      className="ml-[2px] inline-block h-[1em] w-[2px] -translate-y-[2px] animate-pulse rounded-sm bg-accent align-middle"
    />
  );
}

function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// ---- live status line ------------------------------------------------

// Status pill rendered at the BOTTOM of the stream. Aligned to the left so it
// sits flush with the cards above it (centered felt floaty). Matching top/
// bottom margins (`my-5`) give the scroll anchor below the same breathing
// room as the gap above — the pill never butts against the last card or the
// page bottom.
function BottomStatusLine({ status, running }: { status: string | null; running: boolean }) {
  if (!running) return null;
  return (
    <div className="my-5 flex justify-start">
      <div
        className="inline-flex items-center gap-[10px] rounded-pill border border-[#2a2a38] bg-ink-soft/90 px-4 py-[8px] text-[13px] text-[#cfcfd6]"
        style={{ boxShadow: "0 8px 24px -12px rgba(0,0,0,0.6)" }}
      >
        <span
          aria-hidden
          className="h-[6px] w-[6px] animate-pulse rounded-full bg-accent"
          style={{ boxShadow: "0 0 12px var(--color-accent)" }}
        />
        <span>{status ?? "Thinking…"}</span>
      </div>
    </div>
  );
}

function computeLiveStatus(events: FteEventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "tool_use" || e.kind === "server_tool_use") {
      return humanizeToolUse(e);
    }
  }
  return events.length > 0 ? "Getting started…" : null;
}

function humanizeToolUse(e: FteEventRow): string {
  const name = typeof e.payload.name === "string" ? e.payload.name : "";
  const rawInput = e.payload.input;
  const input: Record<string, JsonValue> =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, JsonValue>)
      : {};
  switch (name) {
    case "fetch_url": {
      const url = typeof input.url === "string" ? input.url : "";
      const host = prettyHost(url);
      return host ? `Reading ${host}` : "Reading a page";
    }
    case "discover_rss": {
      const url = typeof input.homepage_url === "string" ? input.homepage_url : "";
      const host = prettyHost(url);
      return host ? `Looking for RSS on ${host}` : "Looking for an RSS feed";
    }
    case "add_competitor": {
      const n = typeof input.name === "string" ? input.name : "";
      return n ? `Adding ${n}` : "Adding a competitor";
    }
    case "save_profile":
      return "Saving your profile";
    case "web_search": {
      const q = typeof input.query === "string" ? input.query : "";
      return q ? `Searching “${q}”` : "Searching the web";
    }
    default:
      return name ? `Running ${name}` : "Thinking…";
  }
}

function prettyHost(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---- profile preview card --------------------------------------------

function ProfilePreviewCard({
  profile,
  competitors,
  onEditProfile,
  onConfirm,
  confirming,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: {
  profile: ProfileView;
  competitors: CompetitorView[];
  onEditProfile: () => void;
  onConfirm: () => void;
  confirming: boolean;
  addingCompetitor: boolean;
  onShowAdd: () => void;
  onHideAdd: () => void;
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>;
  onRemoveCompetitor: (competitor: CompetitorView) => Promise<void>;
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Profile preview</strong> · review and edit
          before confirming
        </div>
        <div className="font-mono text-xs text-[#666]">
          {competitors.length} competitor{competitors.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <ProfileFields profile={profile} showCompanyUrl={false} />
        <CompetitorsList
          variant="inline"
          competitors={competitors}
          addingCompetitor={addingCompetitor}
          onShowAdd={onShowAdd}
          onHideAdd={onHideAdd}
          onAddCompetitor={onAddCompetitor}
          onRemoveCompetitor={onRemoveCompetitor}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="group inline-flex h-11 items-center justify-center gap-[10px] rounded-pill bg-accent px-7 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
        >
          {confirming ? "Confirming…" : "Looks good"}
          <span
            aria-hidden
            className="transition-transform duration-150 group-hover:translate-x-[3px] group-disabled:hidden"
          >
            →
          </span>
        </button>
        <button
          type="button"
          onClick={onEditProfile}
          className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40"
        >
          Edit profile fields
        </button>
      </div>
    </div>
  );
}
