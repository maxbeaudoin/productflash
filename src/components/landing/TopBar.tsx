import { Link } from '@tanstack/react-router'
import { TOPBAR } from '~/data/landing'
import { BrandMark } from './BrandMark'

export function TopBar() {
  return (
    <div className="sticky top-0 z-50 flex items-center justify-between border-b border-ink-line bg-ink px-12 py-[14px] text-white max-md:px-6">
      <div className="flex items-center gap-[10px] font-extrabold tracking-[-0.01em]">
        <BrandMark />
        <span>{TOPBAR.brand}</span>
      </div>
      <Link
        to={TOPBAR.login.href}
        className="rounded-pill border border-[#2a2a38] px-3 py-[6px] text-xs uppercase tracking-[0.1em] text-[#a8a8b8] transition-colors duration-150 hover:border-accent hover:text-white"
      >
        {TOPBAR.login.label}
      </Link>
    </div>
  )
}
