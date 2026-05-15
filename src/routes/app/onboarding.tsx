import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  competitors as competitorsTable,
  fteEvents,
  userCompetitors,
  users as usersTable,
} from '~/db/schema'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'

// /app/onboarding (#29). First stop after the magic-link click.
//
// Tails the FTE agent's event log via SSE for a terminal-feel "watch it
// think" pane. When the agent finishes (or has already finished by the time
// the page loads), reveals a confirm/edit card built from the user's
// AI-generated profile + their newly-linked competitor list.
//
// "Looks good →" stamps profile_confirmed_at and flips status to 'active'
// and is the v1 hand-off into the digest experience. The on-demand
// fast-path ingest → score → synthesize (#30) hangs off of this server fn
// once that task lands.

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type FteEventRow = {
  id: string
  runId: string
  kind: string
  payload: { [key: string]: JsonValue }
  ts: string
}

type ProfileView = {
  position: string | null
  companyName: string | null
  companyUrl: string | null
  ultimateGoal: string | null
  focusAreas: string[] | null
  profileConfirmedAt: string | null
}

type CompetitorView = {
  id: string
  name: string
  homepageUrl: string
  rssUrl: string | null
}

type OnboardingLoaderData = {
  runId: string | null
  events: FteEventRow[]
  profile: ProfileView
  competitors: CompetitorView[]
}

const loadOnboarding = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OnboardingLoaderData> => {
    const session = await requireSession()
    const db = getDb()
    const userId = session.user.id

    const [latest] = await db
      .select({ runId: fteEvents.runId })
      .from(fteEvents)
      .where(eq(fteEvents.userId, userId))
      .orderBy(desc(fteEvents.ts))
      .limit(1)

    const runId = latest?.runId ?? null

    const events: FteEventRow[] = runId
      ? (
          await db
            .select({
              id: fteEvents.id,
              runId: fteEvents.runId,
              kind: fteEvents.kind,
              payload: fteEvents.payload,
              ts: fteEvents.ts,
            })
            .from(fteEvents)
            .where(and(eq(fteEvents.userId, userId), eq(fteEvents.runId, runId)))
            .orderBy(asc(fteEvents.ts))
        ).map((row) => ({
          id: row.id,
          runId: row.runId,
          kind: row.kind,
          payload: (row.payload ?? {}) as { [key: string]: JsonValue },
          ts: row.ts.toISOString(),
        }))
      : []

    const [user] = await db
      .select({
        position: usersTable.position,
        companyName: usersTable.companyName,
        companyUrl: usersTable.companyUrl,
        ultimateGoal: usersTable.ultimateGoal,
        focusAreas: usersTable.focusAreas,
        profileConfirmedAt: usersTable.profileConfirmedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)

    const competitors = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(userCompetitors)
      .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
      .where(eq(userCompetitors.userId, userId))
      .orderBy(asc(competitorsTable.name))

    return {
      runId,
      events,
      profile: {
        position: user?.position ?? null,
        companyName: user?.companyName ?? null,
        companyUrl: user?.companyUrl ?? null,
        ultimateGoal: user?.ultimateGoal ?? null,
        focusAreas: user?.focusAreas ?? null,
        profileConfirmedAt: user?.profileConfirmedAt?.toISOString() ?? null,
      },
      competitors,
    }
  },
)

const editSchema = z.object({
  position: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(1).max(160),
  ultimateGoal: z.string().trim().min(8).max(400),
  focusAreas: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
})

const editProfile = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => editSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const db = getDb()
    await db
      .update(usersTable)
      .set({
        position: data.position,
        companyName: data.companyName,
        ultimateGoal: data.ultimateGoal,
        focusAreas: data.focusAreas,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, session.user.id))
    return { ok: true as const }
  })

const confirmProfile = createServerFn({ method: 'POST' }).handler(async () => {
  const session = await requireSession()
  const db = getDb()
  // Only stamp once. If the user double-clicks, the second call is a no-op.
  // We don't downgrade status here — if the agent has already promoted to
  // 'active' (because save_profile + a competitor landed) we keep it; if it
  // didn't (e.g. agent crashed mid-run), we still promote on user consent.
  await db
    .update(usersTable)
    .set({
      profileConfirmedAt: new Date(),
      status: 'active',
      updatedAt: new Date(),
    })
    .where(and(eq(usersTable.id, session.user.id), isNull(usersTable.profileConfirmedAt)))
  // The on-demand fast-path ingest → score → synthesize chain hangs off
  // this server fn once #30 lands. Until then the user catches the next
  // daily cron.
  return { ok: true as const }
})

export const Route = createFileRoute('/app/onboarding')({
  loader: () => loadOnboarding(),
  component: OnboardingPage,
})

function OnboardingPage() {
  const loaded = Route.useLoaderData()
  const router = useRouter()

  const [events, setEvents] = useState<FteEventRow[]>(loaded.events)
  const [currentBlock, setCurrentBlock] = useState<{
    kind: string | null
    text: string
  }>({ kind: null, text: '' })
  const [profile, setProfile] = useState<ProfileView>(loaded.profile)
  const [competitors] = useState<CompetitorView[]>(loaded.competitors)
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const runId = useMemo(() => {
    return events[0]?.runId ?? loaded.runId
  }, [events, loaded.runId])

  const finished = useMemo(
    () => events.some((e) => e.kind === 'run_finished'),
    [events],
  )

  useEffect(() => {
    const source = new EventSource('/api/onboarding/stream')

    source.addEventListener('event', (raw) => {
      try {
        const row = JSON.parse((raw as MessageEvent).data) as FteEventRow
        setEvents((prev) => {
          if (prev.some((e) => e.id === row.id)) return prev
          return [...prev, row]
        })
        // Durable block landed — clear the streaming text buffer.
        if (row.kind === 'planner_text' || row.kind === 'tool_use') {
          setCurrentBlock({ kind: null, text: '' })
        }
      } catch {
        // Bad payload — ignore.
      }
    })

    source.addEventListener('delta', (raw) => {
      try {
        const d = JSON.parse((raw as MessageEvent).data) as {
          kind: 'text_delta' | 'tool_input_delta' | 'block_start'
          delta: string
          blockKind?: string
        }
        if (d.kind === 'block_start') {
          setCurrentBlock({ kind: d.blockKind ?? null, text: '' })
        } else if (d.kind === 'text_delta') {
          setCurrentBlock((prev) => ({
            kind: prev.kind ?? 'text',
            text: prev.text + d.delta,
          }))
        }
        // tool_input_delta is verbose JSON fragments — skip rendering it
        // live; the durable tool_use event carries the parsed input.
      } catch {
        // Bad payload — ignore.
      }
    })

    source.onerror = () => {
      // The browser auto-reconnects. Nothing to do besides letting it.
    }

    return () => source.close()
  }, [])

  // When run_finished arrives, re-pull profile so the card reflects what the
  // agent saved.
  useEffect(() => {
    if (!finished) return
    void router.invalidate().then(() => {
      // Loader runs again, but we want to feed only the profile back into
      // state — preserve our local events array which is more complete than
      // a fresh load could be during reconnect.
    })
  }, [finished, router])

  // After router.invalidate, loaded changes; sync profile.
  useEffect(() => {
    setProfile(loaded.profile)
  }, [loaded.profile])

  async function onConfirm() {
    setConfirming(true)
    try {
      await confirmProfile()
      await router.navigate({ to: '/app/digests' })
    } catch {
      setConfirming(false)
    }
  }

  async function onSaveEdit(next: ProfileView) {
    await editProfile({
      data: {
        position: next.position ?? '',
        companyName: next.companyName ?? '',
        ultimateGoal: next.ultimateGoal ?? '',
        focusAreas: next.focusAreas ?? [],
      },
    })
    setProfile(next)
    setEditing(false)
  }

  // Don't show the confirm card until profile is saved AND we're done.
  const profileReady =
    finished &&
    !!profile.position &&
    !!profile.ultimateGoal &&
    (profile.focusAreas?.length ?? 0) > 0

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 inline-flex items-center gap-[10px] text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          <span
            aria-hidden
            className={`h-[6px] w-[6px] rounded-full ${finished ? 'bg-accent' : 'animate-pulse bg-coral'}`}
            style={{ boxShadow: '0 0 12px var(--color-accent)' }}
          />
          {finished ? 'Onboarding complete' : 'Onboarding in progress'}
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          {finished
            ? 'Your AI analyst is ready.'
            : 'Watch your AI analyst work.'}
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          {finished
            ? 'Below is the competitive map and profile it built. Tweak anything that looks off, then confirm to land your first digest.'
            : 'It is researching your space, finding direct competitors, and shaping your profile. Roughly a couple of minutes — feel free to keep this open.'}
        </p>
      </header>

      <EventLog events={events} currentBlock={currentBlock} runId={runId} />

      {profileReady ? (
        <section className="mt-10">
          {editing ? (
            <ProfileEditor
              initial={profile}
              onCancel={() => setEditing(false)}
              onSave={onSaveEdit}
            />
          ) : (
            <ProfilePreview
              profile={profile}
              competitors={competitors}
              onEdit={() => setEditing(true)}
              onConfirm={onConfirm}
              confirming={confirming}
            />
          )}
        </section>
      ) : null}
    </main>
  )
}

function EventLog({
  events,
  currentBlock,
  runId,
}: {
  events: FteEventRow[]
  currentBlock: { kind: string | null; text: string }
  runId: string | null
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length, currentBlock.text])

  if (!runId && events.length === 0) {
    return (
      <div className="rounded-card-lg border border-dashed border-[#2a2a38] bg-ink-soft px-7 py-12 text-center">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
          Waiting for first step
        </div>
        <p className="text-[15px] text-[#a8a8b8]">
          Your run will appear here within seconds. If nothing shows up in a
          minute or two, the worker may be down — try refreshing.
        </p>
      </div>
    )
  }

  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-6 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#a8a8b8]">
          Live event log
        </div>
        <div className="font-mono text-xs text-[#666]">
          run {runId ? runId.slice(0, 8) : '—'}
        </div>
      </div>
      <div
        ref={scrollRef}
        className="max-h-[420px] overflow-y-auto px-6 py-5 font-mono text-[13px] leading-[1.65]"
      >
        {events.map((event) => (
          <EventLine key={event.id} event={event} />
        ))}
        {currentBlock.text ? (
          <pre className="whitespace-pre-wrap text-white">
            <span className="text-[#666]">›</span>{' '}
            <span>{currentBlock.text}</span>
            <span className="animate-pulse text-accent">▍</span>
          </pre>
        ) : null}
        {events.length === 0 && !currentBlock.text ? (
          <div className="text-[#666]">…connecting</div>
        ) : null}
      </div>
    </div>
  )
}

function EventLine({ event }: { event: FteEventRow }) {
  const payload = event.payload
  const t = new Date(event.ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  switch (event.kind) {
    case 'run_started':
      return (
        <Line color="accent" time={t} prefix="●">
          run started · {String(payload.email ?? '')}
        </Line>
      )
    case 'iteration':
      return (
        <Line color="muted" time={t} prefix="○">
          iteration {String(payload.n ?? '?')}
        </Line>
      )
    case 'planner_text':
      return (
        <Line color="white" time={t} prefix="›">
          {String(payload.text ?? '')}
        </Line>
      )
    case 'planner_thinking':
      return (
        <Line color="muted" time={t} prefix="…">
          (thinking)
        </Line>
      )
    case 'tool_use': {
      const name = String(payload.name ?? 'tool')
      const input = compactJson(payload.input)
      return (
        <Line color="accent" time={t} prefix="→">
          {name}({input})
        </Line>
      )
    }
    case 'tool_result':
      return (
        <Line color="muted" time={t} prefix="←">
          {String(payload.name ?? '')} · ok
        </Line>
      )
    case 'tool_error':
      return (
        <Line color="coral" time={t} prefix="×">
          {String(payload.name ?? 'tool')} · {String(payload.error ?? 'error')}
        </Line>
      )
    case 'server_tool_use':
      return (
        <Line color="accent" time={t} prefix="→">
          web_search({compactJson(payload.input)})
        </Line>
      )
    case 'server_tool_result': {
      const summary = payload.summary as { count?: number } | undefined
      return (
        <Line color="muted" time={t} prefix="←">
          web_search · {summary?.count ?? 0} results
        </Line>
      )
    }
    case 'run_finished':
      return (
        <Line color="accent" time={t} prefix="●">
          finished · {String(payload.finished_reason ?? '')} ·{' '}
          {String(payload.iterations ?? '?')} iterations
        </Line>
      )
    case 'error':
      return (
        <Line color="coral" time={t} prefix="×">
          {String(payload.message ?? 'error')}
        </Line>
      )
    default:
      return (
        <Line color="muted" time={t} prefix="·">
          {event.kind}
        </Line>
      )
  }
}

function Line({
  color,
  time,
  prefix,
  children,
}: {
  color: 'white' | 'muted' | 'accent' | 'coral'
  time: string
  prefix: string
  children: React.ReactNode
}) {
  const colorClass =
    color === 'white'
      ? 'text-white'
      : color === 'accent'
      ? 'text-accent'
      : color === 'coral'
      ? 'text-coral'
      : 'text-[#888]'
  return (
    <div className="flex gap-3 py-[2px]">
      <span className="shrink-0 text-[#444]">{time}</span>
      <span className={`shrink-0 ${colorClass}`}>{prefix}</span>
      <span className={`min-w-0 break-words ${color === 'muted' ? 'text-[#a8a8b8]' : 'text-white'}`}>
        {children}
      </span>
    </div>
  )
}

function ProfilePreview({
  profile,
  competitors,
  onEdit,
  onConfirm,
  confirming,
}: {
  profile: ProfileView
  competitors: CompetitorView[]
  onEdit: () => void
  onConfirm: () => void
  confirming: boolean
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Profile preview</strong>{' '}
          · ready for review
        </div>
        <div className="font-mono text-xs text-[#666]">
          {competitors.length} competitors
        </div>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <DetailRow label="Role" value={profile.position} />
        <DetailRow label="Company" value={profile.companyName ?? profile.companyUrl} />
        <DetailRow label="Goal" value={profile.ultimateGoal} />
        <FocusAreas areas={profile.focusAreas} />
        <CompetitorsList competitors={competitors} />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirming}
          className="group inline-flex h-11 items-center justify-center gap-[10px] rounded-pill bg-accent px-7 text-base font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
        >
          {confirming ? 'Confirming…' : 'Looks good'}
          <span
            aria-hidden
            className="transition-transform duration-150 group-hover:translate-x-[3px] group-disabled:hidden"
          >
            →
          </span>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40"
        >
          Edit fields
        </button>
      </div>
    </div>
  )
}

function ProfileEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: ProfileView
  onCancel: () => void
  onSave: (next: ProfileView) => Promise<void> | void
}) {
  const [position, setPosition] = useState(initial.position ?? '')
  const [companyName, setCompanyName] = useState(initial.companyName ?? '')
  const [ultimateGoal, setUltimateGoal] = useState(initial.ultimateGoal ?? '')
  const [focusAreas, setFocusAreas] = useState(
    (initial.focusAreas ?? []).join(', '),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    const parsedFocus = focusAreas
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const result = editSchema.safeParse({
      position,
      companyName,
      ultimateGoal,
      focusAreas: parsedFocus,
    })
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Please fill in every field.')
      setSaving(false)
      return
    }
    try {
      await onSave({
        ...initial,
        position: result.data.position,
        companyName: result.data.companyName,
        ultimateGoal: result.data.ultimateGoal,
        focusAreas: result.data.focusAreas,
      })
    } catch {
      setError('Could not save changes. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
    >
      <div className="border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5 text-[13px] text-[#888]">
        <strong className="font-semibold text-white">Edit profile</strong> ·
        change anything the agent got wrong
      </div>

      <div className="grid gap-5 px-7 py-7">
        <EditField label="Role">
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent"
          />
        </EditField>
        <EditField label="Company">
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent"
          />
        </EditField>
        <EditField label="Goal">
          <textarea
            rows={3}
            value={ultimateGoal}
            onChange={(e) => setUltimateGoal(e.target.value)}
            className="min-h-[88px] w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 py-3 text-base text-white outline-none transition-colors focus:border-accent"
          />
        </EditField>
        <EditField label="Focus areas" hint="comma separated">
          <input
            value={focusAreas}
            onChange={(e) => setFocusAreas(e.target.value)}
            className="h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent"
          />
        </EditField>
        {error ? <p className="text-sm font-medium text-coral">{error}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-11 items-center gap-2 rounded-pill bg-accent px-6 text-sm font-semibold text-ink transition-transform duration-150 hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        {label}
      </div>
      <div className="text-[15px] text-white">
        {value && value.length > 0 ? value : <span className="text-[#666]">—</span>}
      </div>
    </div>
  )
}

function FocusAreas({ areas }: { areas: string[] | null }) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        Focus areas
      </div>
      <div className="flex flex-wrap gap-2">
        {(areas ?? []).map((area) => (
          <span
            key={area}
            className="rounded-pill bg-accent/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-accent"
          >
            {area}
          </span>
        ))}
        {(areas ?? []).length === 0 ? (
          <span className="text-[15px] text-[#666]">—</span>
        ) : null}
      </div>
    </div>
  )
}

function CompetitorsList({ competitors }: { competitors: CompetitorView[] }) {
  return (
    <div className="grid gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
        Competitors
      </div>
      {competitors.length === 0 ? (
        <div className="text-[15px] text-[#666]">—</div>
      ) : (
        <ul className="divide-y divide-[#2a2a38] overflow-hidden rounded-md border border-[#2a2a38]">
          {competitors.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">{c.name}</div>
                <div className="truncate font-mono text-[11px] text-[#666]">
                  {c.homepageUrl}
                </div>
              </div>
              {c.rssUrl ? (
                <span className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
                  rss
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EditField({
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
          <span className="rounded-pill bg-accent/10 px-2 py-[2px] font-mono text-[10px] normal-case tracking-normal text-accent">
            {hint}
          </span>
        ) : null}
      </span>
      {children}
    </label>
  )
}

function compactJson(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    if (!s) return ''
    return s.length > 80 ? `${s.slice(0, 77)}…` : s
  } catch {
    return ''
  }
}
