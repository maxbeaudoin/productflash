import type { Feature } from "~/features/landing/content";

export function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <div className="rounded-card border border-[#ececec] bg-white p-8 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-ink">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-[12px] bg-ink font-mono text-xl font-bold text-accent">
        {feature.index}
      </div>
      <h3 className="mb-2 text-xl font-bold tracking-[-0.01em]">{feature.title}</h3>
      <p className="text-[15px] text-text-muted">{feature.body}</p>
    </div>
  );
}
