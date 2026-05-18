export type FilterChipOption<V extends string> = {
  value: V;
  label: string;
  count?: number;
};

export function FilterChipRow<V extends string>({
  ariaLabel,
  options,
  active,
  onChange,
}: {
  ariaLabel: string;
  options: FilterChipOption<V>[];
  active: V;
  onChange: (value: V) => void;
}) {
  return (
    <nav className="flex flex-wrap gap-2" aria-label={ariaLabel}>
      {options.map((o) => {
        const isActive = o.value === active;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={isActive}
            className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-xs uppercase tracking-[0.1em] transition-colors ${
              isActive
                ? "border-ink bg-ink text-paper"
                : "border-ink-line bg-paper-warm text-text-muted hover:border-ink hover:text-text"
            }`}
          >
            {o.label}
            {o.count !== undefined ? (
              <span
                className={`font-mono text-[10px] ${isActive ? "text-paper/70" : "text-text-muted"}`}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
