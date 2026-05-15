import { PROBLEM } from '~/data/landing'
import { StatCard } from './StatCard'

export function ProblemSection() {
  return (
    <section className="border-b border-[#e5e4dd] bg-paper-warm px-12 py-24 max-md:px-6 max-md:py-16">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-text-muted">
          {PROBLEM.label}
        </div>
        <h2 className="mb-6 max-w-[820px] text-[clamp(32px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
          {PROBLEM.title}
        </h2>
        <p className="mb-14 max-w-[680px] text-lg text-text-muted">
          {PROBLEM.lede}
        </p>

        <div className="mt-14 grid grid-cols-3 gap-6 max-md:grid-cols-1">
          {PROBLEM.stats.map((stat) => (
            <StatCard key={stat.leadStrong} stat={stat} />
          ))}
        </div>
      </div>
    </section>
  )
}
