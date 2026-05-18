import type React from "react";
import { useEffect } from "react";
import { renderInline, splitParagraphs } from "../shared/markdown";

export function ThinkingStream({
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
