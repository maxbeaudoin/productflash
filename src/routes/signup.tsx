import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { signIn } from '~/lib/auth-client'

// The public funnel is invite-only: visitors land on the waitlist (#33).
// A bare `/signup` shows the gate; with an `?invite=<token>` param the
// existing magic-link form is exposed. Cryptographic token verification
// arrives alongside the admin invite UI (#16 follow-up) — for now any
// non-empty token unlocks the form so manual invites still work.
const searchSchema = z.object({
  invite: z.string().min(1).optional(),
})

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  component: SignupPage,
})

function SignupPage() {
  const { invite } = Route.useSearch()
  if (!invite) return <InviteGate />
  return <MagicLinkForm />
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

function MagicLinkForm() {
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
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1"
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
