import { HERO } from '~/data/landing'

const HERO_GRADIENT =
  'radial-gradient(circle at 85% 20%, rgba(217,255,58,0.12), transparent 50%), radial-gradient(circle at 10% 90%, rgba(255,91,58,0.08), transparent 50%)'

export function Hero() {
  return (
    <header className="relative overflow-hidden bg-ink px-12 pb-[120px] pt-24 text-white max-md:px-6 max-md:pb-20 max-md:pt-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: HERO_GRADIENT }}
      />
      <div className="relative mx-auto max-w-[1100px]">
        <div className="mb-8 inline-flex items-center gap-[10px] rounded-pill border border-[#2a2a38] px-3 py-[6px] text-xs uppercase tracking-[0.1em] text-[#a8a8b8]">
          <span
            aria-hidden
            className="h-[6px] w-[6px] rounded-full bg-accent"
            style={{ boxShadow: '0 0 12px var(--color-accent)' }}
          />
          {HERO.eyebrow}
        </div>

        <h1 className="mb-7 max-w-[980px] text-[clamp(40px,6vw,84px)] font-extrabold leading-[1.02] tracking-[-0.035em]">
          {HERO.headlineLead}{' '}
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage:
                'linear-gradient(120deg, var(--color-accent) 0%, var(--color-accent-warm) 100%)',
            }}
          >
            {HERO.headlineAccent}
          </span>
        </h1>

        <p className="mb-10 max-w-[680px] text-[clamp(18px,1.6vw,22px)] font-normal text-[#b8b8c8]">
          {HERO.sub}
        </p>

        <a
          href={HERO.cta.href}
          className="group mb-12 inline-flex items-center gap-[10px] rounded-pill bg-accent px-8 py-[18px] text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px"
        >
          {HERO.cta.label}
          <span
            aria-hidden
            className="transition-transform duration-150 group-hover:translate-x-[3px]"
          >
            →
          </span>
        </a>

        <div className="flex flex-wrap gap-12 border-t border-ink-line pt-8 max-md:gap-6">
          {HERO.meta.map((item) => (
            <div key={item.label} className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-[0.12em] text-[#6a6a7a]">
                {item.label}
              </span>
              <span className="text-base font-medium text-white">
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </header>
  )
}
