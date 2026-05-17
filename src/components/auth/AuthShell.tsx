import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "~/components/landing/BrandMark";

// Shared chrome for /login + /signup. Mirrors the dark hero treatment from
// the landing page (radial-gradient halo, glowing-dot eyebrow pill,
// editorial heading with an accent-gradient word) so auth feels like a
// continuation of the marketing surface, not a generic shadcn dialog.

const HALO_GRADIENT =
  "radial-gradient(circle at 80% 15%, rgba(217,255,58,0.10), transparent 55%), radial-gradient(circle at 15% 90%, rgba(255,91,58,0.06), transparent 55%)";

type Props = {
  eyebrow: string;
  headlineLead: string;
  headlineAccent?: string;
  sub?: string;
  children: ReactNode;
  /** Bottom-left "← Back" or similar text-link slot. */
  footnote?: ReactNode;
};

export function AuthShell({
  eyebrow,
  headlineLead,
  headlineAccent,
  sub,
  children,
  footnote,
}: Props) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-ink px-6 py-12 text-white antialiased md:px-12 md:py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: HALO_GRADIENT }}
      />

      <div className="relative mx-auto flex min-h-[calc(100vh-6rem)] max-w-[520px] flex-col">
        <Link
          to="/"
          className="inline-flex items-center gap-[10px] font-extrabold tracking-[-0.01em] text-white"
        >
          <BrandMark className="h-[22px] w-[22px]" />
          <span>Product Flash</span>
        </Link>

        <div className="mt-auto pt-16">
          <div className="mb-7 inline-flex items-center gap-[10px] rounded-pill border border-[#2a2a38] px-3 py-[6px] text-xs uppercase tracking-[0.1em] text-[#a8a8b8]">
            <span
              aria-hidden
              className="h-[6px] w-[6px] rounded-full bg-accent"
              style={{ boxShadow: "0 0 12px var(--color-accent)" }}
            />
            {eyebrow}
          </div>

          <h1 className="mb-5 text-[clamp(36px,5.5vw,56px)] font-extrabold leading-[1.02] tracking-[-0.03em]">
            {headlineLead}
            {headlineAccent ? (
              <>
                {" "}
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage:
                      "linear-gradient(120deg, var(--color-accent) 0%, var(--color-accent-warm) 100%)",
                  }}
                >
                  {headlineAccent}
                </span>
              </>
            ) : null}
          </h1>

          {sub ? <p className="mb-10 max-w-[440px] text-base text-[#b8b8c8]">{sub}</p> : null}

          {children}
        </div>

        <div className="mt-auto pt-12 text-sm text-[#8a8a98]">{footnote}</div>
      </div>
    </main>
  );
}
