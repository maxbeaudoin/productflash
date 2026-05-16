import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  competitors as competitorsTable,
  fteEvents,
  userCompetitors,
  users as usersTable,
} from '~/db/schema'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'
import { autodetectRSSForHomepage } from '~/sources/rss'

// /app/onboarding (#29). First stop after the magic-link click.
//
// Renders the FTE agent's reasoning as first-class "thinking step" cards —
// one per planner_text event, live-streamed via text deltas. Tool activity
// is summarized into ambient counters at the top; the raw event log is the
// admin app's job (#16), not something end users should see.
//
// When the agent finishes (or finished before the page loaded), the profile
// preview reveals: read-only profile fields + an inline competitor list
// where the user can remove or add entries before confirming. "Looks good"
// stamps profile_confirmed_at + flips status to 'active' (the on-demand
// fast-path ingest → score → synthesize chain from #30 wires in here once
// that task lands).

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

const addCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  homepageUrl: z.string().trim().url().max(500),
})

const addCompetitor = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => addCompetitorSchema.parse(data))
  .handler(async ({ data }): Promise<{ competitor: CompetitorView }> => {
    const session = await requireSession()
    const db = getDb()

    // Auto-detect RSS so the manually-added competitor matches what the
    // agent would have done. Failure is silent — a competitor without an
    // rss_url is still usable (Firehose + Firecrawl still cover it).
    let rssUrl: string | null = null
    try {
      rssUrl = await autodetectRSSForHomepage(data.homepageUrl)
    } catch {
      rssUrl = null
    }

    const [c] = await db
      .insert(competitorsTable)
      .values({
        name: data.name,
        homepageUrl: data.homepageUrl,
        rssUrl,
      })
      .onConflictDoUpdate({
        target: competitorsTable.homepageUrl,
        set: {
          name: sql`excluded.name`,
          rssUrl: sql`coalesce(excluded.rss_url, ${competitorsTable.rssUrl})`,
        },
      })
      .returning({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
    if (!c) throw new Error('competitor_upsert_failed')

    await db
      .insert(userCompetitors)
      .values({ userId: session.user.id, competitorId: c.id })
      .onConflictDoNothing()

    return { competitor: c }
  })

const removeCompetitorSchema = z.object({
  competitorId: z.string().uuid(),
})

const removeCompetitor = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => removeCompetitorSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession()
    const db = getDb()
    await db
      .delete(userCompetitors)
      .where(
        and(
          eq(userCompetitors.userId, session.user.id),
          eq(userCompetitors.competitorId, data.competitorId),
        ),
      )
    return { ok: true as const }
  })

const confirmProfile = createServerFn({ method: 'POST' }).handler(async () => {
  const session = await requireSession()
  const db = getDb()
  // Idempotent: only stamp the first time. The agent may have already
  // promoted status to 'active' (save_profile + ≥1 competitor) — we still
  // promote on user consent if it hadn't.
  await db
    .update(usersTable)
    .set({
      profileConfirmedAt: new Date(),
      status: 'active',
      updatedAt: new Date(),
    })
    .where(and(eq(usersTable.id, session.user.id), isNull(usersTable.profileConfirmedAt)))
  // #30 wires the on-demand ingest → score → synthesize chain here.
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
  const [streamingText, setStreamingText] = useState('')
  const [streamingActive, setStreamingActive] = useState(false)
  const [profile, setProfile] = useState<ProfileView>(loaded.profile)
  const [competitors, setCompetitors] = useState<CompetitorView[]>(loaded.competitors)
  const [editingProfile, setEditingProfile] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [addingCompetitor, setAddingCompetitor] = useState(false)

  const runId = useMemo(() => {
    return events[0]?.runId ?? loaded.runId
  }, [events, loaded.runId])

  const finished = useMemo(
    () => events.some((e) => e.kind === 'run_finished'),
    [events],
  )

  // The agent is briefed to stop after save_profile, but Sonnet sometimes
  // still emits a recap (with a markdown table and emoji headers) — that
  // duplicates the profile card below and feels like a verbatim log. Cut
  // off planner_text events that arrived after save_profile fired.
  const thoughts = useMemo(() => {
    const cutoffTs = findSaveProfileTs(events)
    return events
      .filter((e) => e.kind === 'planner_text')
      .filter((e) => cutoffTs === null || Date.parse(e.ts) <= cutoffTs)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        text: typeof e.payload.text === 'string' ? e.payload.text : '',
      }))
      .filter((t) => t.text.trim().length > 0)
  }, [events])

  const stats = useMemo(() => buildStats(events), [events])

  useEffect(() => {
    const source = new EventSource('/api/onboarding/stream')

    source.addEventListener('event', (raw) => {
      try {
        const row = JSON.parse((raw as MessageEvent).data) as FteEventRow
        setEvents((prev) => {
          if (prev.some((e) => e.id === row.id)) return prev
          return [...prev, row]
        })
        if (row.kind === 'planner_text') {
          setStreamingText('')
          setStreamingActive(false)
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
          if (d.blockKind === 'text') {
            setStreamingText('')
            setStreamingActive(true)
          } else {
            setStreamingActive(false)
          }
        } else if (d.kind === 'text_delta') {
          setStreamingActive(true)
          setStreamingText((prev) => prev + d.delta)
        }
      } catch {
        // Bad payload — ignore.
      }
    })

    source.onerror = () => {
      // Browser auto-reconnects. Nothing to do.
    }

    return () => source.close()
  }, [])

  useEffect(() => {
    if (!finished) return
    void router.invalidate()
  }, [finished, router])

  useEffect(() => {
    setProfile(loaded.profile)
    setCompetitors(loaded.competitors)
  }, [loaded.profile, loaded.competitors])

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
    setEditingProfile(false)
  }

  async function onAddCompetitor(input: { name: string; homepageUrl: string }) {
    const res = await addCompetitor({ data: input })
    setCompetitors((prev) =>
      prev.some((c) => c.id === res.competitor.id)
        ? prev
        : [...prev, res.competitor].sort((a, b) => a.name.localeCompare(b.name)),
    )
    setAddingCompetitor(false)
  }

  async function onRemoveCompetitor(competitorId: string) {
    setCompetitors((prev) => prev.filter((c) => c.id !== competitorId))
    try {
      await removeCompetitor({ data: { competitorId } })
    } catch {
      // Surface a re-load if the server rejected. Cheap heuristic.
      await router.invalidate()
    }
  }

  const profileReady =
    finished &&
    !!profile.position &&
    !!profile.ultimateGoal &&
    (profile.focusAreas?.length ?? 0) > 0

  return (
    <main className="mx-auto max-w-[920px] px-6 py-12">
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
          {finished ? 'Your AI analyst is ready.' : 'Your AI analyst is thinking…'}
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          {finished
            ? 'Below is the map and profile it built. Tweak anything that looks off, then confirm to land your first digest.'
            : 'Mapping your competitive space in real time — usually a minute or two. Feel free to keep this open and watch.'}
        </p>
        <ProgressChips stats={stats} running={!finished} />
      </header>

      <ThinkingStream
        thoughts={thoughts}
        streaming={streamingActive ? streamingText : ''}
        running={!finished}
        hasRun={Boolean(runId) || events.length > 0}
      />

      {profileReady ? (
        <section className="mt-10">
          {editingProfile ? (
            <ProfileEditor
              initial={profile}
              onCancel={() => setEditingProfile(false)}
              onSave={onSaveEdit}
            />
          ) : (
            <ProfileCard
              profile={profile}
              competitors={competitors}
              onEditProfile={() => setEditingProfile(true)}
              onConfirm={onConfirm}
              confirming={confirming}
              addingCompetitor={addingCompetitor}
              onShowAdd={() => setAddingCompetitor(true)}
              onHideAdd={() => setAddingCompetitor(false)}
              onAddCompetitor={onAddCompetitor}
              onRemoveCompetitor={onRemoveCompetitor}
            />
          )}
        </section>
      ) : null}
    </main>
  )
}

// ---- thinking stream --------------------------------------------------

type Stats = {
  pagesRead: number
  webSearches: number
  competitorsAdded: number
  elapsedMs: number | null
}

function findSaveProfileTs(events: FteEventRow[]): number | null {
  for (const e of events) {
    if (e.kind === 'tool_use' && e.payload.name === 'save_profile') {
      const t = Date.parse(e.ts)
      return Number.isFinite(t) ? t : null
    }
  }
  return null
}

function buildStats(events: FteEventRow[]): Stats {
  let pagesRead = 0
  let webSearches = 0
  let competitorsAdded = 0
  let startTs: number | null = null
  let lastTs: number | null = null
  for (const e of events) {
    const t = Date.parse(e.ts)
    if (Number.isFinite(t)) {
      if (startTs === null) startTs = t
      lastTs = t
    }
    if (e.kind === 'tool_result') {
      const name = typeof e.payload.name === 'string' ? e.payload.name : ''
      if (name === 'fetch_url' && !e.payload.error) pagesRead++
      if (name === 'add_competitor' && !e.payload.error) competitorsAdded++
    } else if (e.kind === 'server_tool_use') {
      webSearches++
    }
  }
  return {
    pagesRead,
    webSearches,
    competitorsAdded,
    elapsedMs: startTs !== null && lastTs !== null ? lastTs - startTs : null,
  }
}

function ProgressChips({ stats, running }: { stats: Stats; running: boolean }) {
  const items: Array<{ label: string; value: string | null }> = [
    { label: 'pages read', value: stats.pagesRead ? String(stats.pagesRead) : null },
    {
      label: 'web searches',
      value: stats.webSearches ? String(stats.webSearches) : null,
    },
    {
      label: 'competitors',
      value: stats.competitorsAdded ? String(stats.competitorsAdded) : null,
    },
    {
      label: 'elapsed',
      value: stats.elapsedMs ? formatElapsed(stats.elapsedMs) : null,
    },
  ]
  const visible = items.filter((i) => i.value)
  if (visible.length === 0) return null
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      {visible.map((item) => (
        <span
          key={item.label}
          className="inline-flex items-center gap-[8px] rounded-pill border border-[#2a2a38] bg-ink-soft/60 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.12em] text-[#a8a8b8]"
        >
          <span className="font-mono text-xs tracking-normal text-accent">
            {item.value}
          </span>
          {item.label}
        </span>
      ))}
      {running ? (
        <span className="inline-flex items-center gap-[8px] rounded-pill bg-coral/15 px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.12em] text-coral">
          <span aria-hidden className="h-[6px] w-[6px] animate-pulse rounded-full bg-coral" />
          live
        </span>
      ) : null}
    </div>
  )
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

function ThinkingStream({
  thoughts,
  streaming,
  running,
  hasRun,
}: {
  thoughts: Array<{ id: string; ts: string; text: string }>
  streaming: string
  running: boolean
  hasRun: boolean
}) {
  if (!hasRun) {
    return (
      <div className="rounded-card-lg border border-dashed border-[#2a2a38] bg-ink-soft px-7 py-12 text-center">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
          Warming up
        </div>
        <p className="text-[15px] text-[#a8a8b8]">
          Your analyst will start any moment now. If nothing happens within a
          minute, refresh the page.
        </p>
      </div>
    )
  }

  return (
    <ol className="grid gap-4">
      {thoughts.map((thought, idx) => (
        <Thought
          key={thought.id}
          index={idx + 1}
          text={thought.text}
          live={false}
        />
      ))}
      {running && streaming ? (
        <Thought
          key="live"
          index={thoughts.length + 1}
          text={streaming}
          live
        />
      ) : null}
      {running && !streaming && thoughts.length === 0 ? (
        <Thought key="warming" index={1} text="Reading your homepage…" live />
      ) : null}
    </ol>
  )
}

function Thought({
  index,
  text,
  live,
}: {
  index: number
  text: string
  live: boolean
}) {
  return (
    <li
      className={`relative grid grid-cols-[auto_1fr] gap-5 rounded-card-lg border bg-ink-soft px-7 py-6 transition-all duration-300 ${
        live
          ? 'border-accent/40 shadow-[0_0_0_4px_rgba(217,255,58,0.05)]'
          : 'border-[#2a2a38]'
      }`}
      style={
        live
          ? undefined
          : { boxShadow: '0 20px 40px -20px rgba(0,0,0,0.5)' }
      }
    >
      <div className="flex flex-col items-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full font-mono text-[12px] font-bold ${
            live
              ? 'bg-accent text-ink'
              : 'border border-[#2a2a38] bg-ink text-[#8a8a98]'
          }`}
        >
          {index.toString().padStart(2, '0')}
        </div>
      </div>
      <div className="min-w-0">
        <ThoughtBody text={text} />
        {live ? (
          <div className="mt-2 inline-flex items-center gap-[8px] text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
            <span aria-hidden className="h-[6px] w-[6px] animate-pulse rounded-full bg-accent" />
            thinking
          </div>
        ) : null}
      </div>
    </li>
  )
}

// Light prose renderer for planner_text. Splits on blank-line paragraph
// breaks and lifts `**bold**` runs to <strong>. Anything else (lists,
// tables, headers) passes through as plain text — we don't try to fully
// render markdown, the agent is briefed to be concise.
function ThoughtBody({ text }: { text: string }) {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (paragraphs.length === 0) {
    return <p className="text-[15px] text-[#a8a8b8]">…</p>
  }
  return (
    <div className="grid gap-3 text-[15px] leading-[1.65] text-white">
      {paragraphs.map((para, i) => (
        <p key={i} className="whitespace-pre-wrap">
          {renderInline(para)}
        </p>
      ))}
    </div>
  )
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <span key={i}>{part}</span>
  })
}

// ---- profile card -----------------------------------------------------

function ProfileCard({
  profile,
  competitors,
  onEditProfile,
  onConfirm,
  confirming,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: {
  profile: ProfileView
  competitors: CompetitorView[]
  onEditProfile: () => void
  onConfirm: () => void
  confirming: boolean
  addingCompetitor: boolean
  onShowAdd: () => void
  onHideAdd: () => void
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>
  onRemoveCompetitor: (competitorId: string) => Promise<void>
}) {
  return (
    <div
      className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
      style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
    >
      <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
        <div className="text-[13px] text-[#888]">
          <strong className="font-semibold text-white">Profile preview</strong>{' '}
          · review and edit before confirming
        </div>
        <div className="font-mono text-xs text-[#666]">
          {competitors.length} competitor{competitors.length === 1 ? '' : 's'}
        </div>
      </div>

      <div className="grid gap-6 px-7 py-7">
        <div className="grid gap-6 md:grid-cols-2">
          <DetailRow label="Role" value={profile.position} />
          <DetailRow label="Company" value={profile.companyName ?? profile.companyUrl} />
        </div>
        <DetailRow label="Goal" value={profile.ultimateGoal} />
        <FocusAreas areas={profile.focusAreas} />
        <CompetitorsList
          competitors={competitors}
          addingCompetitor={addingCompetitor}
          onShowAdd={onShowAdd}
          onHideAdd={onHideAdd}
          onAddCompetitor={onAddCompetitor}
          onRemoveCompetitor={onRemoveCompetitor}
        />
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
          onClick={onEditProfile}
          className="inline-flex h-11 items-center gap-2 rounded-pill border border-[#2a2a38] px-5 text-sm font-semibold text-white hover:bg-ink/40"
        >
          Edit profile fields
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

function CompetitorsList({
  competitors,
  addingCompetitor,
  onShowAdd,
  onHideAdd,
  onAddCompetitor,
  onRemoveCompetitor,
}: {
  competitors: CompetitorView[]
  addingCompetitor: boolean
  onShowAdd: () => void
  onHideAdd: () => void
  onAddCompetitor: (input: { name: string; homepageUrl: string }) => Promise<void>
  onRemoveCompetitor: (competitorId: string) => Promise<void>
}) {
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#666]">
          Competitors
        </div>
        {!addingCompetitor ? (
          <button
            type="button"
            onClick={onShowAdd}
            className="inline-flex items-center gap-[6px] rounded-pill border border-[#2a2a38] px-3 py-[6px] text-[11px] font-semibold uppercase tracking-[0.08em] text-white hover:bg-ink/40"
          >
            <span aria-hidden>+</span> Add
          </button>
        ) : null}
      </div>

      {competitors.length === 0 && !addingCompetitor ? (
        <div className="rounded-md border border-dashed border-[#2a2a38] px-4 py-5 text-center text-[14px] text-[#666]">
          No competitors yet. Add one to start tracking.
        </div>
      ) : null}

      {competitors.length > 0 ? (
        <ul className="divide-y divide-[#2a2a38] overflow-hidden rounded-md border border-[#2a2a38]">
          {competitors.map((c) => (
            <CompetitorRow
              key={c.id}
              competitor={c}
              onRemove={() => onRemoveCompetitor(c.id)}
            />
          ))}
        </ul>
      ) : null}

      {addingCompetitor ? (
        <AddCompetitorForm onCancel={onHideAdd} onSubmit={onAddCompetitor} />
      ) : null}
    </div>
  )
}

function CompetitorRow({
  competitor,
  onRemove,
}: {
  competitor: CompetitorView
  onRemove: () => void | Promise<void>
}) {
  const [removing, setRemoving] = useState(false)
  return (
    <li className="group flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">
          {competitor.name}
        </div>
        <div className="truncate font-mono text-[11px] text-[#666]">
          {competitor.homepageUrl}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {competitor.rssUrl ? (
          <span className="rounded-pill bg-accent/15 px-2 py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
            rss
          </span>
        ) : null}
        <button
          type="button"
          onClick={async () => {
            setRemoving(true)
            await onRemove()
          }}
          disabled={removing}
          aria-label={`Remove ${competitor.name}`}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-lg leading-none text-[#666] transition-colors hover:border-coral/40 hover:bg-coral/10 hover:text-coral disabled:opacity-40"
        >
          ×
        </button>
      </div>
    </li>
  )
}

function AddCompetitorForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void
  onSubmit: (input: { name: string; homepageUrl: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [homepageUrl, setHomepageUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const parsed = addCompetitorSchema.safeParse({ name, homepageUrl })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name and a homepage URL.')
      setSubmitting(false)
      return
    }
    try {
      await onSubmit(parsed.data)
      setName('')
      setHomepageUrl('')
    } catch {
      setError('Could not add competitor. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-md border border-[#2a2a38] bg-ink/40 px-4 py-4"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <input
          type="text"
          placeholder="Notion"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          className="h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent"
        />
        <input
          type="url"
          placeholder="https://notion.so"
          value={homepageUrl}
          onChange={(e) => setHomepageUrl(e.target.value)}
          className="h-11 w-full rounded-md border-[1.5px] border-[#2a2a38] bg-ink px-4 text-base text-white outline-none transition-colors focus:border-accent"
        />
      </div>
      {error ? <p className="text-sm text-coral">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-pill bg-accent px-5 text-sm font-semibold text-ink hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? 'Adding…' : 'Add competitor'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-pill border border-[#2a2a38] px-4 text-sm font-semibold text-white hover:bg-ink/40 disabled:opacity-50"
        >
          Cancel
        </button>
        <span className="text-[11px] uppercase tracking-[0.1em] text-[#666]">
          we'll auto-detect RSS
        </span>
      </div>
    </form>
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
