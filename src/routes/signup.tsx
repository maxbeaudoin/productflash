import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
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
    <main className="min-h-screen bg-paper text-text antialiased flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mb-6 inline-flex items-center gap-[10px] rounded-pill border border-ink-line bg-paper-warm px-3 py-[6px] text-xs uppercase tracking-[0.1em] text-text-muted">
          Invite only
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Product Flash is in private beta.
        </h1>
        <p className="mt-4 text-text-muted">
          New seats open on a rolling basis. Drop your email on the waitlist
          and we'll be in touch when one frees up.
        </p>
        <Link
          to="/"
          hash="waitlist"
          className="mt-8 inline-flex items-center gap-[10px] rounded-pill bg-ink px-6 py-3 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-px"
        >
          Join the waitlist
          <span aria-hidden>→</span>
        </Link>
        <p className="mt-6 text-xs text-text-muted">
          Already signed in?{' '}
          <Link to="/login" className="underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
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
    <main className="min-h-screen bg-paper text-text antialiased flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">Sign up for Product Flash</h1>
        <p className="mt-3 text-text-muted">
          We'll email you a magic link — no password to remember.
        </p>

        {state === 'sent' ? (
          <div className="mt-8 rounded-2xl border border-ink-line bg-paper-warm p-6">
            <p className="font-medium">Check your inbox.</p>
            <p className="mt-2 text-sm text-text-muted">
              We sent a sign-in link to <span className="font-mono">{email}</span>.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                readOnly
                autoComplete="email"
                className="mt-1 bg-paper-warm"
              />
            </div>
            <Button type="submit" disabled={state === 'sending'} className="w-full">
              {state === 'sending' ? 'Sending…' : 'Send magic link'}
            </Button>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
        )}
      </div>
    </main>
  )
}
