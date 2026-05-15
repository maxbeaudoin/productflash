import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { sql } from 'drizzle-orm'
import { useState } from 'react'
import { z } from 'zod'
import { enqueueFteRun } from '~/agents/fte/job'
import { AuthShell } from '~/components/auth/AuthShell'
import { users as usersTable } from '~/db/schema'
import { auth } from '~/lib/auth'
import { getBoss } from '~/lib/boss'
import { getDb } from '~/lib/db'
import { verifyInviteToken } from '~/lib/invite-token'
import { logger } from '~/lib/logger'

// The public funnel is invite-only (see #33/#34). Admins issue signed
// `?invite=<token>` URLs from /admin/waitlist; a bare /signup or a tampered
// token shows the gate. Valid tokens render the FTE intake form with the
// email prefilled and locked — the user can only sign up as the address the
// invite was issued to. Submitting kicks off the FTE agent (#28) and sends
// the magic-link via Better Auth in the same request.
const searchSchema = z.object({
  invite: z.string().min(1).optional(),
})

// HMAC verification runs server-side because INVITE_TOKEN_SECRET must never
// reach the client. The loader returns just the verified email (or null) —
// no raw secrets cross the boundary.
const verifyInvite = createServerFn({ method: 'GET' })
  .inputValidator((data: { token?: string }) => data)
  .handler(({ data }) => {
    if (!data.token) return { email: null as string | null }
    const payload = verifyInviteToken(data.token)
    return { email: payload?.email ?? null }
  })

const submitSchema = z.object({
  inviteToken: z.string().min(1),
  companyUrl: z.string().trim().url().max(500),
  position: z.string().trim().min(2).max(120),
  ultimateGoal: z.string().trim().min(8).max(400),
})

type SubmitError = 'invalid_invite' | 'user_insert_failed' | 'send_failed'
type SubmitResult = { ok: true; email: string } | { ok: false; error: SubmitError }

// Server fn: re-verifies the invite token, upserts the user with the AI-
// profile seed fields the user typed, enqueues the FTE agent, then sends the
// magic-link. The user row MUST exist before sendMagicLink because the
// magic-link plugin runs with `disableSignUp: true` (private beta).
const submitSignup = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => submitSchema.parse(data))
  .handler(async ({ data }): Promise<SubmitResult> => {
    const payload = verifyInviteToken(data.inviteToken)
    if (!payload) return { ok: false, error: 'invalid_invite' }

    const email = payload.email.toLowerCase()
    const db = getDb()

    // Re-running /signup with the same invite should re-seed profile inputs
    // and re-kick the agent — useful when the magic link expires or the
    // user wants to retry. Only overwrite status when the user hasn't yet
    // confirmed a profile (we don't want to demote an active user back to
    // onboarding by accident).
    const [user] = await db
      .insert(usersTable)
      .values({
        email,
        status: 'onboarding',
        companyUrl: data.companyUrl,
        position: data.position,
        ultimateGoal: data.ultimateGoal,
      })
      .onConflictDoUpdate({
        target: usersTable.email,
        set: {
          status: sql`case when ${usersTable.profileConfirmedAt} is null then 'onboarding'::user_status else ${usersTable.status} end`,
          companyUrl: data.companyUrl,
          position: data.position,
          ultimateGoal: data.ultimateGoal,
          updatedAt: new Date(),
        },
      })
      .returning({ id: usersTable.id, email: usersTable.email })

    if (!user) return { ok: false, error: 'user_insert_failed' }

    // Best-effort enqueue. `singletonKey: userId` makes a double-submit a
    // no-op; if the FTE worker is down the row is still queued and will
    // pick up when it comes back.
    const boss = await getBoss()
    const enqueueRes = await enqueueFteRun(boss, user.id, {
      signup: {
        email: user.email,
        companyUrl: data.companyUrl,
        position: data.position,
        ultimateGoal: data.ultimateGoal,
      },
    })
    logger.info(
      { userId: user.id, runId: enqueueRes.runId, enqueued: enqueueRes.enqueued },
      'signup: fte enqueued',
    )

    // Send the magic-link. Better Auth requires headers (origin check); the
    // server fn request gives us those via getRequest().
    try {
      await auth.api.signInMagicLink({
        body: { email: user.email, callbackURL: '/app' },
        headers: getRequest().headers,
      })
    } catch (err) {
      logger.error({ err, userId: user.id }, 'signup: magic-link send failed')
      return { ok: false, error: 'send_failed' }
    }

    return { ok: true, email: user.email }
  })

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  loaderDeps: ({ search: { invite } }) => ({ invite }),
  loader: async ({ deps }) => {
    const { email } = await verifyInvite({ data: { token: deps.invite } })
    return { email, inviteToken: deps.invite ?? null }
  },
  component: SignupPage,
})

function SignupPage() {
  const { email, inviteToken } = Route.useLoaderData()
  if (!email || !inviteToken) return <InviteGate />
  return <FteSignupForm email={email} inviteToken={inviteToken} />
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

function FteSignupForm({ email, inviteToken }: { email: string; inviteToken: string }) {
  const router = useRouter()
  const [companyUrl, setCompanyUrl] = useState('')
  const [position, setPosition] = useState('')
  const [ultimateGoal, setUltimateGoal] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('submitting')
    setError(null)
    const parsed = submitSchema.safeParse({
      inviteToken,
      companyUrl,
      position,
      ultimateGoal,
    })
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      setError(first?.message ?? 'Please fill in every field.')
      setState('error')
      return
    }
    const res = await submitSignup({ data: parsed.data })
    if (!res.ok) {
      setError(messageForError(res.error))
      setState('error')
      return
    }
    setState('sent')
    // Preload /app so the magic-link click feels instant.
    router.preloadRoute({ to: '/app' }).catch(() => {})
  }

  return (
    <AuthShell
      eyebrow="You're invited"
      headlineLead="Tell us"
      headlineAccent="who you are."
      sub="Four lines, then your AI analyst goes to work — researching your space, finding your competitors, and shaping your first brief while you check your email."
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
          <Field label="Email" hint="locked to invite">
            <input
              type="email"
              value={email}
              readOnly
              autoComplete="email"
              className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink/60 px-4 text-base font-normal normal-case tracking-normal text-white outline-none cursor-not-allowed"
            />
          </Field>

          <Field label="Company URL">
            <input
              type="url"
              required
              autoFocus
              autoComplete="url"
              placeholder="https://yourcompany.com"
              value={companyUrl}
              onChange={(e) => setCompanyUrl(e.target.value)}
              className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent"
            />
          </Field>

          <Field label="Your role">
            <input
              type="text"
              required
              autoComplete="organization-title"
              placeholder="Head of Product, PM Lead, …"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              className="h-12 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent"
            />
          </Field>

          <Field
            label="What's your goal"
            hint="one sentence"
          >
            <textarea
              required
              rows={3}
              placeholder="Catch every competitor launch / pricing change so I can react before my CEO asks."
              value={ultimateGoal}
              onChange={(e) => setUltimateGoal(e.target.value)}
              className="min-h-[96px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 py-3 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent"
            />
          </Field>

          <button
            type="submit"
            disabled={state === 'submitting'}
            className="group mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
          >
            {state === 'submitting' ? 'Kicking it off…' : 'Start onboarding'}
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

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="grid gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8a8a98]">
      <span className="inline-flex items-center gap-2">
        {label}
        {hint ? (
          <span className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
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
          Onboarding running
        </div>
        <div className="font-mono text-xs text-[#888]">expires in 5 min</div>
      </div>
      <div className="px-6 py-7">
        <p className="text-lg font-semibold text-white">Check your inbox.</p>
        <p className="mt-2 text-sm text-[#b8b8c8]">
          We sent a sign-in link to{' '}
          <span className="font-mono text-white">{email}</span>. Click it from
          the same browser — by the time you land in the app, your AI analyst
          should be most of the way through researching your competitive map.
        </p>
      </div>
    </div>
  )
}

function messageForError(code: SubmitError) {
  switch (code) {
    case 'invalid_invite':
      return 'This invite link looks invalid or expired. Ask for a fresh one.'
    case 'user_insert_failed':
      return 'We couldn\'t set up your account. Try again in a moment.'
    case 'send_failed':
      return 'The magic-link email didn\'t go through. Try again in a moment.'
  }
}
