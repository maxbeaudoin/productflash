import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addCompetitor,
  type CompetitorView,
  removeCompetitor,
} from "~/features/competitors/server/fns";
import { confirmProfile, editProfile, loadOnboarding } from "~/features/onboarding/server/fns";
import type { FteEventRow, ProfileView } from "~/features/onboarding/shared/fte-event";
import { computeLiveStatus } from "~/features/onboarding/shared/live-status";
import { buildStats, findSaveProfileTs } from "~/features/onboarding/shared/stats";
import { ProfilePreviewCard } from "~/features/onboarding/ui/profile-preview-card";
import { ProgressChips } from "~/features/onboarding/ui/progress-chips";
import { ThinkingStream } from "~/features/onboarding/ui/thinking-stream";
import { ProfileEditor, type ProfileEditorValues } from "~/features/profile/ui/profile-editor";

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
            ? "Below is the map and profile it built. Tweak anything that looks off, then confirm to land your first brief."
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
