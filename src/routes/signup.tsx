import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { eq, sql } from 'drizzle-orm'
import { useState } from 'react'
import { z } from 'zod'
import { enqueueFteRun } from '~/agents/fte/job'
import { AuthShell } from '~/components/auth/AuthShell'
import { users as usersTable, waitlist as waitlistTable } from '~/db/schema'
import { issueAutoSignInUrl } from '~/lib/auth-server'
import { getBoss } from '~/lib/boss'
import { getDb } from '~/lib/db'
import { verifyInviteToken } from '~/lib/invite-token'
import { logger } from '~/lib/logger'

// The public funnel is invite-only (see #33/#34). Admins issue signed
// `?invite=<token>` URLs from /admin/waitlist; a bare /signup or a tampered
// token shows the gate. Valid tokens render the FTE intake form with the
// email prefilled and locked — the user can only sign up as the address the
// invite was issued to. Submitting kicks off the FTE agent (#28) and auto-
// signs the user in (#38): the invite token's HMAC is the trust anchor, so
// we skip the magic-link email round-trip and return a one-shot verify URL
// the client navigates to — establishing the Better Auth session cookie.
const searchSchema = z.object({
  invite: z.string().min(1).optional(),
})

// HMAC verification runs server-side because INVITE_TOKEN_SECRET must never
// reach the client. On a valid token the loader also fetches the matching
// waitlist row to seed the FTE intake form with `position` + `companyUrl` the
// user already typed on the landing waitlist (task #37). Defaults are
// returned to the client; the form lets the user revise them.
type InviteVerification = {
  email: string | null
  defaults: { position: string; companyUrl: string } | null
}

const verifyInvite = createServerFn({ method: 'GET' })
  .inputValidator((data: { token?: string }) => data)
  .handler(async ({ data }): Promise<InviteVerification> => {
    if (!data.token) return { email: null, defaults: null }
    const payload = verifyInviteToken(data.token)
    if (!payload) return { email: null, defaults: null }

    const db = getDb()
    const [row] = await db
      .select({ position: waitlistTable.position, companyUrl: waitlistTable.companyUrl })
      .from(waitlistTable)
      .where(eq(waitlistTable.id, payload.id))
      .limit(1)

    return {
      email: payload.email,
      defaults: {
        position: row?.position ?? '',
        companyUrl: row?.companyUrl ?? '',
      },
    }
  })

const submitSchema = z.object({
  inviteToken: z.string().min(1),
  companyUrl: z.string().trim().url().max(500),
  position: z.string().trim().min(2).max(120),
  ultimateGoal: z.string().trim().min(8).max(400),
})

type SubmitError = 'invalid_invite' | 'user_insert_failed' | 'session_failed'
type SubmitResult =
  | { ok: true; email: string; signInUrl: string }
  | { ok: false; error: SubmitError }

// Server fn: re-verifies the invite token, upserts the user with the AI-
// profile seed fields the user typed, enqueues the FTE agent, then mints a
// one-shot magic-link verify URL the client navigates to (auto-sign-in). The
// user row MUST exist before the verify URL is hit because magic-link runs
// with `disableSignUp: true` (private beta).
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

    // Mint a one-shot verify URL — the client navigates to it to consume the
    // pre-seeded verification row, which lands the Better Auth session cookie
    // on the response. /app routes admin → /admin, unconfirmed → onboarding.
    let signInUrl: string
    try {
      signInUrl = await issueAutoSignInUrl(user.email, '/app')
    } catch (err) {
      logger.error({ err, userId: user.id }, 'signup: auto-sign-in url failed')
      return { ok: false, error: 'session_failed' }
    }

    return { ok: true, email: user.email, signInUrl }
  })

export const Route = createFileRoute('/signup')({
  validateSearch: searchSchema,
  loaderDeps: ({ search: { invite } }) => ({ invite }),
  loader: async ({ deps }) => {
    const { email, defaults } = await verifyInvite({ data: { token: deps.invite } })
    return { email, defaults, inviteToken: deps.invite ?? null }
  },
  component: SignupPage,
})

function SignupPage() {
  const { email, defaults, inviteToken } = Route.useLoaderData()
  if (!email || !inviteToken) return <InviteGate />
  return <FteSignupForm email={email} inviteToken={inviteToken} defaults={defaults} />
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

function FteSignupForm({
  email,
  inviteToken,
  defaults,
}: {
  email: string
  inviteToken: string
  defaults: { position: string; companyUrl: string } | null
}) {
  const [companyUrl, setCompanyUrl] = useState(defaults?.companyUrl ?? '')
  const [position, setPosition] = useState(defaults?.position ?? '')
  const [ultimateGoal, setUltimateGoal] = useState('')
  const [state, setState] = useState<'idle' | 'submitting' | 'redirecting' | 'error'>('idle')
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
    // Full-page nav so Better Auth's redirect + Set-Cookie land naturally.
    // The verify URL is single-use and expires in 60s; consuming it now
    // creates the session and routes to /app → /app/onboarding.
    setState('redirecting')
    window.location.href = res.signInUrl
  }

  return (
    <AuthShell
      eyebrow="You're invited"
      headlineLead="Tell us"
      headlineAccent="who you are."
      sub="Four lines, then your AI analyst goes to work — researching your space, finding your competitors, and shaping your first brief in real time."
      footnote={
        <span>
          Not you?{' '}
          <Link to="/" hash="waitlist" className="text-white underline-offset-4 hover:underline">
            Join the waitlist instead →
          </Link>
        </span>
      }
    >
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
            autoFocus={!defaults?.companyUrl}
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

        <Field label="What's your goal" hint="one sentence">
          <textarea
            required
            rows={3}
            autoFocus={!!defaults?.companyUrl}
            placeholder="Catch every competitor launch / pricing change so I can react before my CEO asks."
            value={ultimateGoal}
            onChange={(e) => setUltimateGoal(e.target.value)}
            className="min-h-[96px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink-soft px-4 py-3 text-base font-normal normal-case tracking-normal text-white outline-none placeholder:text-[#5a5a6a] transition-colors focus:border-accent"
          />
        </Field>

        <button
          type="submit"
          disabled={state === 'submitting' || state === 'redirecting'}
          className="group mt-2 inline-flex h-12 items-center justify-center gap-[10px] rounded-pill bg-accent px-8 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
        >
          {state === 'submitting'
            ? 'Kicking it off…'
            : state === 'redirecting'
              ? 'Signing you in…'
              : 'Start onboarding'}
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

function messageForError(code: SubmitError) {
  switch (code) {
    case 'invalid_invite':
      return 'This invite link looks invalid or expired. Ask for a fresh one.'
    case 'user_insert_failed':
      return 'We couldn\'t set up your account. Try again in a moment.'
    case 'session_failed':
      return 'We couldn\'t start your session. Try again in a moment.'
  }
}
