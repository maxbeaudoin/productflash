import { PROOF } from "~/features/landing/content";

export function ProofSection() {
  return (
    <section className="bg-paper px-12 py-24 max-md:px-6 max-md:py-16">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-text-muted">
          {PROOF.label}
        </div>
        <div className="grid grid-cols-2 items-start gap-16 max-md:grid-cols-1 max-md:gap-8">
          <div>
            <h3 className="mb-4 text-[28px] font-bold tracking-[-0.02em]">{PROOF.title}</h3>
            {PROOF.paragraphs.map((p) => (
              <p key={p} className="mb-4 text-base text-text-muted">
                {p}
              </p>
            ))}
          </div>
          <div className="rounded-card bg-ink p-9 font-mono text-sm leading-[1.8] text-white">
            {PROOF.items.map((item) =>
              item.status === "live" ? (
                <div key={item.text}>
                  <span className="mr-3 text-accent">✓</span>
                  {item.text}
                </div>
              ) : (
                <div key={item.text} className="text-[#555]">
                  ○ {item.text}
                </div>
              ),
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
