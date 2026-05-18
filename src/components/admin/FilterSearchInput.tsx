export function FilterSearchInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-text-muted">
      <span className="uppercase tracking-[0.1em] text-[10px]">{label}</span>
      <input
        type="search"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v.length ? v : undefined);
        }}
        placeholder={placeholder}
        className="rounded-pill border border-ink-line bg-paper px-3 py-1 text-xs text-text placeholder:text-text-muted hover:border-ink focus:border-ink focus:outline-none"
      />
    </label>
  );
}
