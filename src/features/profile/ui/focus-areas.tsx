export function FocusAreas({ areas }: { areas: string[] | null }) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        Focus areas
      </div>
      <div className="flex flex-wrap gap-2">
        {(areas ?? []).map((area) => (
          <span
            key={area}
            className="rounded-pill bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent"
          >
            {area}
          </span>
        ))}
        {(areas ?? []).length === 0 ? <span className="text-[15px] text-[#666]">—</span> : null}
      </div>
    </div>
  );
}

export function FocusAreasLabel() {
  return (
    <span className="inline-flex items-center gap-2">
      Focus areas
      <span className="rounded-pill bg-accent/10 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
        comma separated
      </span>
    </span>
  );
}
