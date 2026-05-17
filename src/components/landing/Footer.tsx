import { FOOTER, TOPBAR } from "~/data/landing";
import { BrandMark } from "./BrandMark";

export function Footer() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 bg-ink px-12 py-10 text-[13px] text-[#888] max-md:px-6 max-md:py-8">
      <div className="flex items-center gap-[10px] font-extrabold tracking-[-0.01em] text-white">
        <BrandMark />
        <span>{TOPBAR.brand}</span>
      </div>
      <div>{FOOTER.copy}</div>
    </footer>
  );
}
