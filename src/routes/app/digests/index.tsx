import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { desc, eq, sql } from 'drizzle-orm'
import { digestItems, digests } from '~/db/schema'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'

type DigestRow = {
  id: string
  createdAt: string
  itemCount: number
  peek: string | null
}

const listDigests = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await requireSession()
  const db = getDb()
  const digestRows = await db
    .select({
      id: digests.id,
      createdAt: digests.createdAt,
      itemCount: digests.itemCount,
    })
    .from(digests)
    .where(eq(digests.userId, session.user.id))
    .orderBy(desc(digests.createdAt))

  // Top-scored headline per digest — used as the list row peek. One round
  // trip via `DISTINCT ON`; Drizzle's correlated-subquery templating
  // doesn't carry the outer-query alias through, so we fan out in JS.
  let peeks = new Map<string, string>()
  if (digestRows.length) {
    const peekRows = await db.execute<{ digest_id: string; headline: string }>(sql`
      SELECT DISTINCT ON (${digestItems.digestId})
        ${digestItems.digestId} AS digest_id,
        ${digestItems.headline} AS headline
      FROM ${digestItems}
      WHERE ${digestItems.userId} = ${session.user.id}
      ORDER BY ${digestItems.digestId}, ${digestItems.score} DESC
    `)
    peeks = new Map(peekRows.rows.map((r) => [r.digest_id, r.headline]))
  }

  return {
    rows: digestRows.map<DigestRow>((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      itemCount: r.itemCount,
      peek: peeks.get(r.id) ?? null,
    })),
  }
})

export const Route = createFileRoute('/app/digests/')({
  loader: async () => listDigests(),
  component: DigestsListPage,
})

function DigestsListPage() {
  const { rows } = Route.useLoaderData()
  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <header className="mb-10">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-accent">
          Your digests
        </div>
        <h1 className="text-[clamp(28px,3vw,40px)] font-extrabold leading-[1.1] tracking-[-0.02em] text-white">
          What your competitors did, day by day.
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] text-[#a8a8b8]">
          Newest first. Open one to read the full brief, react with 👍 / 👎 on
          anything load-bearing.
        </p>
      </header>

      {rows.length === 0 ? <EmptyState /> : <DigestList rows={rows} />}
    </main>
  )
}

function DigestList({ rows }: { rows: DigestRow[] }) {
  return (
    <ul className="divide-y divide-[#2a2a38] overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft">
      {rows.map((row) => (
        <DigestListRow key={row.id} row={row} />
      ))}
    </ul>
  )
}

function DigestListRow({ row }: { row: DigestRow }) {
  const date = new Date(row.createdAt)
  const dateLabel = date
    .toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    .toUpperCase()
  const timeLabel = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const itemLabel =
    row.itemCount === 0
      ? 'Nothing notable'
      : `${row.itemCount} ${row.itemCount === 1 ? 'item' : 'items'}`

  return (
    <li>
      <Link
        to="/app/digests/$digestId"
        params={{ digestId: row.id }}
        className="group flex items-start justify-between gap-6 px-7 py-5 transition-colors hover:bg-[#1a1a23]"
      >
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xs text-[#888]">
            {dateLabel} · {timeLabel}
          </div>
          <div className="mt-2 line-clamp-2 text-base font-semibold leading-[1.4] text-white">
            {row.peek ?? 'Nothing notable overnight.'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          <span className="rounded-pill bg-accent/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
            {itemLabel}
          </span>
          <span
            aria-hidden
            className="text-[#5a5a6a] transition-transform group-hover:translate-x-[2px] group-hover:text-white"
          >
            →
          </span>
        </div>
      </Link>
    </li>
  )
}

function EmptyState() {
  return (
    <div className="rounded-card-lg border border-dashed border-[#2a2a38] bg-ink-soft px-7 py-16 text-center">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
        No digests yet
      </div>
      <p className="text-[15px] text-[#a8a8b8]">
        Your first brief will land here once the pipeline runs. If you just
        finished onboarding, give it a few minutes.
      </p>
    </div>
  )
}
