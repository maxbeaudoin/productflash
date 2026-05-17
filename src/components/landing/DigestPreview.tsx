import { DIGEST_PREVIEW } from "~/data/landing";
import { DigestItem } from "./DigestItem";

export function DigestPreview() {
  return (
    <section className="bg-ink px-12 py-24 text-white max-md:px-6 max-md:py-16">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          {DIGEST_PREVIEW.label}
        </div>
        <h2 className="mb-6 max-w-[820px] text-[clamp(32px,4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.03em] text-white">
          {DIGEST_PREVIEW.title}
        </h2>
        <p className="mb-14 max-w-[680px] text-lg text-[#a8a8b8]">{DIGEST_PREVIEW.lede}</p>

        <div
          className="mt-8 overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
          style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
        >
          <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
            <div className="text-[13px] text-[#888]">
              From <strong className="font-semibold text-white">{DIGEST_PREVIEW.fromName}</strong>{" "}
              &lt;{DIGEST_PREVIEW.fromAddress}&gt;
            </div>
            <div className="font-mono text-xs text-[#666]">{DIGEST_PREVIEW.date}</div>
          </div>

          <div className="px-7 py-9">
            <div className="mb-6 text-sm text-[#888]">{DIGEST_PREVIEW.greeting}</div>
            {DIGEST_PREVIEW.items.map((item, idx) => (
              <DigestItem
                key={item.headline}
                item={item}
                isLast={idx === DIGEST_PREVIEW.items.length - 1}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
