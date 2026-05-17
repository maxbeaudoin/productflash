import type { Persona } from "~/data/landing";

export function PersonaCard({ persona }: { persona: Persona }) {
  return (
    <div className="rounded-card border border-[#e9e8e1] bg-white px-7 py-9">
      <div className="mb-4 font-mono text-xs text-text-muted">// {persona.index}</div>
      <h4 className="mb-3 text-[22px] font-bold tracking-[-0.01em]">{persona.title}</h4>
      <p className="text-[15px] text-text-muted">{persona.body}</p>
    </div>
  );
}
