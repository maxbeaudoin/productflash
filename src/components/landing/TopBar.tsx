import { TOPBAR } from '~/data/landing'
import { BrandMark } from './BrandMark'

export function TopBar() {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-between border-b border-ink-line bg-ink px-12 py-[14px] text-white max-md:px-6">
      <div className="flex items-center gap-[10px] font-extrabold tracking-[-0.01em]">
        <BrandMark />
        <span>{TOPBAR.brand}</span>
      </div>
      <div className="text-xs uppercase tracking-[0.08em] text-[#888]">
        {TOPBAR.meta}
      </div>
    </div>
  )
}
