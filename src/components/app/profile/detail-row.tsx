export function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        {label}
      </div>
      <div className={`text-[15px] text-white ${mono ? "font-mono text-sm" : ""}`}>
        {value && value.length > 0 ? value : <span className="text-[#666]">—</span>}
      </div>
    </div>
  );
}
