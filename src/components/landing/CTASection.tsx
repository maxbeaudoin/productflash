import { CTA } from '~/data/landing'

const CTA_GRADIENT =
  'radial-gradient(circle at 50% 0%, rgba(255,255,255,0.4), transparent 60%)'

export function CTASection() {
  return (
    <section className="relative overflow-hidden bg-accent px-12 py-[120px] text-center text-ink max-md:px-6 max-md:py-20">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: CTA_GRADIENT }}
      />
      <div className="relative mx-auto max-w-[720px]">
        <div className="mb-6 text-[11px] font-bold uppercase tracking-[0.2em]">
          {CTA.label}
        </div>
        <h2 className="mb-6 text-[clamp(40px,5.5vw,72px)] font-extrabold leading-[1.02] tracking-[-0.03em]">
          {CTA.title}
        </h2>
        <p className="mb-10 text-lg text-ink/75">{CTA.body}</p>

        <div className="flex flex-wrap justify-center gap-4">
          <a
            href={CTA.primary.href}
            className="group inline-flex items-center gap-[10px] rounded-pill bg-ink px-8 py-[18px] text-base font-semibold text-white transition-transform duration-150 hover:-translate-y-px"
          >
            {CTA.primary.label}
            <span
              aria-hidden
              className="transition-transform duration-150 group-hover:translate-x-[3px]"
            >
              →
            </span>
          </a>
          <a
            href={CTA.secondary.href}
            className="inline-flex items-center gap-[10px] rounded-pill border-[1.5px] border-ink bg-transparent px-8 py-[18px] text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px"
          >
            {CTA.secondary.label}
          </a>
        </div>

        <div className="mt-8 font-mono text-[13px] text-ink/60">
          {CTA.fineprint}
        </div>
      </div>
    </section>
  )
}
