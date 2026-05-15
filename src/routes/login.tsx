import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell } from '~/components/auth/AuthShell'
import { signIn } from '~/lib/auth-client'

const searchSchema = z.object({
  reason: z.enum(['unauthenticated']).optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  component: LoginPage,
})

function LoginPage() {
  const { reason } = Route.useSearch()
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('sending')
    setError(null)
    const { error } = await signIn.magicLink({ email, callbackURL: '/app' })
    if (error) {
      setError(error.message ?? 'Something went wrong')
      setState('error')
      return
    }
    setState('sent')
  }

  return (
    <AuthShell
      eyebrow={reason === 'unauthenticated' ? 'Session expired' : 'Sign in'}
      headlineLead="Welcome"
      headlineAccent="back."
      sub="Enter your email — we'll send a one-time link to sign you in. No password to remember."
      footnote={
        <span>
          New here?{' '}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Join the waitlist →
          </Link>
        </span>
      }
    >
      {state === 'sent' ? (
        <SentCard email={email} onReset={() => setState('idle')} />
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4">
          <label className="grid gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]">
            Email
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent"
            />
          </label>

          <button
            type="submit"
            disabled={state === 'sending'}
            className="group mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            {state === 'sending' ? 'Sending…' : 'Send magic link'}
            <span
              aria-hidden
              className="transition-transform duration-150 group-hover:translate-x-[3px] group-disabled:hidden"
            >
              →
            </span>
          </button>

          {state === 'error' && error ? (
            <p className="text-sm font-medium text-coral">{error}</p>
          ) : null}
        </form>
      )}
    </AuthShell>
  )
}

function SentCard({ email, onReset }: { email: string; onReset: () => void }) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-6 py-4">
        <div className="inline-flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          <span
            aria-hidden
            className="h-[6px] w-[6px] rounded-full bg-accent"
            style={{ boxShadow: '0 0 12px var(--color-accent)' }}
          />
          Sent
        </div>
        <div className="font-mono text-xs text-[#888]">expires in 5 min</div>
      </div>
      <div className="px-6 py-7">
        <p className="text-lg font-semibold text-white">Check your inbox.</p>
        <p className="mt-2 text-sm text-[#b8b8c8]">
          We sent a sign-in link to{' '}
          <span className="font-mono text-white">{email}</span>. Click it from
          the same browser and you'll land in the app.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-5 text-sm text-[#8a8a98] underline-offset-4 hover:text-white hover:underline"
        >
          Use a different email
        </button>
      </div>
    </div>
  )
}
