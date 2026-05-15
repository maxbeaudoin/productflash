import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'
import { AuthShell } from '~/components/auth/AuthShell'
import { signIn } from '~/lib/auth-client'
import { verifyInviteToken } from '~/lib/invite-token'

// The public funnel is invite-only (see #33/#34). Admins issue signed
// `?invite=<token>` URLs from /admin/waitlist; a bare /signup or a tampered
// token shows the gate. Valid tokens render the magic-link form with the
// email prefilled and locked — the user can only sign in as the address the
// invite was issued to.
const searchSchema = z.object({
  invite: z.string().min(1).optional(),
})

// HMAC verification runs server-side because INVITE_TOKEN_SECRET must never
// reach the client. The route loader returns just the verified email (or
// null) — no raw secrets cross the boundary.
const verifyInvite = createServerFn({ method: 'GET' })
  .inputValidator((data: { token?: string }) => data)
  .handler(({ data }) => {
    if (!data.token) return { email: null as string | null }
    const payload = verifyInviteToken(data.token)
    return { email: payload?.email ?? null }
  })

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  loaderDeps: ({ search: { invite } }) => ({ invite }),
  loader: async ({ deps }) => {
    const { email } = await verifyInvite({ data: { token: deps.invite } })
    return { email }
  },
  component: SignupPage,
})

function SignupPage() {
  const { email } = Route.useLoaderData()
  if (!email) return <InviteGate />
  return <MagicLinkForm email={email} />
}

function InviteGate() {
  return (
    <AuthShell
      eyebrow="Invite only"
      headlineLead="Private beta,"
      headlineAccent="by invite."
      sub="New seats open on a rolling basis. Drop your email on the waitlist and we'll be in touch when one frees up."
      footnote={
        <span>
          Already signed in?{' '}
          <Link to="/login" className="text-white underline-offset-4 hover:underline">
            Log in →
          </Link>
        </span>
      }
    >
      <Link
        to="/"
        hash="waitlist"
        className="group inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px"
      >
        Join the waitlist
        <span
          aria-hidden
          className="transition-transform duration-150 group-hover:translate-x-[3px]"
        >
          →
        </span>
      </Link>
    </AuthShell>
  )
}

function MagicLinkForm({ email }: { email: string }) {
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
      eyebrow="You're invited"
      headlineLead="One link"
      headlineAccent="to sign in."
      sub="We'll email a one-time sign-in link to your invited address. No password to set up."
      footnote={
        <span>
          Not you?{' '}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Join the waitlist instead →
          </Link>
        </span>
      }
    >
      {state === 'sent' ? (
        <SentCard email={email} />
      ) : (
        <form onSubmit={onSubmit} className="grid gap-4">
          <label className="grid gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]">
            <span className="inline-flex items-center gap-2">
              Email
              <span className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
                locked to invite
              </span>
            </span>
            <input
              type="email"
              value={email}
              readOnly
              autoComplete="email"
              className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink/60 px-4 text-base font-normal normal-case tracking-normal text-white outline-none cursor-not-allowed"
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

function SentCard({ email }: { email: string }) {
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
      </div>
    </div>
  )
}
