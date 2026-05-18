import { formatElapsed, type Stats } from "../shared/stats";

export function ProgressChips({ stats, running }: { stats: Stats; running: boolean }) {
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
