import type { Stat } from "~/features/landing/content";

export function StatCard({ stat }: { stat: Stat }) {
  return (
    <div className="rounded-card border border-[#e9e8e1] bg-white p-8">
      <div
        className="mb-3 bg-clip-text text-[56px] font-extrabold leading-none tracking-[-0.04em] text-transparent"
        style={{
          backgroundImage: "linear-gradient(135deg, var(--color-ink) 0%, #3a3a4a 100%)",
        }}
      >
        {stat.num}
        <span className="ml-1 text-2xl font-semibold text-text-muted">{stat.unit}</span>
      </div>
      <div className="text-sm leading-[1.5] text-text-muted">
        <strong className="font-semibold text-text">{stat.leadStrong}</strong> {stat.body}
      </div>
    </div>
  );
}
