import { useState } from "react";
import type { CompetitorView } from "~/lib/server/competitor-fns";

// Single competitor row. Homepage URL and RSS feed are clickable so the
// user can sanity-check what the agent (or they) added — opens in a new
// tab to avoid hijacking the page they were just on.
export function CompetitorRow({
  competitor,
  onRemove,
}: {
  competitor: CompetitorView;
  onRemove: () => void | Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  return (
    <li className="group flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">{competitor.name}</div>
        <a
          href={competitor.homepageUrl}
          target="_blank"
          rel="noreferrer"
          className="truncate font-mono text-[11px] text-[#666] hover:text-accent"
        >
          {competitor.homepageUrl}
        </a>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {competitor.rssUrl ? (
          <a
            href={competitor.rssUrl}
            target="_blank"
            rel="noreferrer"
            title={competitor.rssUrl}
            className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent hover:bg-accent/25"
          >
            rss
          </a>
        ) : null}
        <button
          type="button"
          onClick={async () => {
            setRemoving(true);
            try {
              await onRemove();
            } finally {
              setRemoving(false);
            }
          }}
          disabled={removing}
          aria-label={`Remove ${competitor.name}`}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-lg leading-none text-[#666] transition-colors hover:border-coral/40 hover:bg-coral/10 hover:text-coral disabled:opacity-40"
        >
          ×
        </button>
      </div>
    </li>
  );
}
