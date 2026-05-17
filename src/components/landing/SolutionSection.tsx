import { SOLUTION } from "~/data/landing";
import { FeatureCard } from "./FeatureCard";

export function SolutionSection() {
  return (
    <section className="bg-paper px-12 py-24 max-md:px-6 max-md:py-16">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-text-muted">
          {SOLUTION.label}
        </div>
        <h2 className="mb-6 max-w-[820px] text-[clamp(32px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
          {SOLUTION.title}
        </h2>
        <p className="mb-14 max-w-[680px] text-lg text-text-muted">{SOLUTION.lede}</p>

        <div className="mt-6 grid grid-cols-2 gap-6 max-md:grid-cols-1">
          {SOLUTION.features.map((feature) => (
            <FeatureCard key={feature.index} feature={feature} />
          ))}
        </div>
      </div>
    </section>
  );
}
