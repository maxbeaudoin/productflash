import { Link } from '@tanstack/react-router'
import { BrandMark } from '~/components/landing/BrandMark'

type Props = {
  email: string
}

export function AppHeader({ email }: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-ink-line bg-ink text-white">
      <div className="mx-auto flex max-w-[1100px] items-center justify-between px-6 py-[14px]">
        <Link
          to="/app/digests"
          className="flex items-center gap-[10px] font-extrabold tracking-[-0.01em] text-white"
        >
          <BrandMark />
          <span>Product Flash</span>
        </Link>
        <div className="flex items-center gap-3 text-xs text-[#a8a8b8]">
          <Link
            to="/app/profile"
            className="rounded-pill border border-[#2a2a38] px-3 py-[6px] uppercase tracking-[0.1em] text-[#a8a8b8] transition-colors hover:border-accent hover:text-white"
            activeProps={{ className: 'border-accent text-white' }}
          >
            Profile
          </Link>
          <span className="hidden font-mono text-[#8a8a98] sm:inline">{email}</span>
          {/* POST-form sign-out — see src/routes/logout.ts for the why. */}
          <form method="post" action="/logout" className="inline-flex">
            <button
              type="submit"
              className="rounded-pill border border-[#2a2a38] px-3 py-[6px] uppercase tracking-[0.1em] text-[#a8a8b8] transition-colors hover:border-coral hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  )
}
