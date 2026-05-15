import { AUDIENCE } from '~/data/landing'
import { PersonaCard } from './PersonaCard'

export function AudienceSection() {
  return (
    <section className="border-t border-[#e5e4dd] bg-paper-warm px-12 py-24 max-md:px-6 max-md:py-16">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-text-muted">
          {AUDIENCE.label}
        </div>
        <h2 className="mb-6 max-w-[820px] text-[clamp(32px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em]">
          {AUDIENCE.title}
        </h2>

        <div className="mt-8 grid grid-cols-3 gap-6 max-md:grid-cols-1">
          {AUDIENCE.personas.map((persona) => (
            <PersonaCard key={persona.index} persona={persona} />
          ))}
        </div>
      </div>
    </section>
  )
}
