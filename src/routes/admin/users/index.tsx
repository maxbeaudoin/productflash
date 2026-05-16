import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { desc, eq, sql } from 'drizzle-orm'
import { digests, userCompetitors, users } from '~/db/schema'
import { requireAdminSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'

// /admin/users (#16). All users newest first. Each row carries the four
// summary signals we lean on during babysitting: email (identity), status
// (where they are in the lifecycle), last digest date (is the pipeline
// reaching them?), competitor count (did the FTE agent populate anything?).
//
// Aggregations come from two correlated subqueries so we do one round trip
// regardless of user count — a left-joined fan-out across digest_items
// would double-count without `DISTINCT ON`.

type UserRow = {
  id: string
  email: string
  status: string
  role: string
  createdAt: string
  lastDigestAt: string | null
  competitorCount: number
}

const listUsers = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdminSession()
  const db = getDb()

  const lastDigest = db
    .select({
      userId: digests.userId,
      lastDigestAt: sql<Date | null>`MAX(${digests.createdAt})`.as('last_digest_at'),
    })
    .from(digests)
    .groupBy(digests.userId)
    .as('last_digest')

  const competitorCount = db
    .select({
      userId: userCompetitors.userId,
      competitorCount:
        sql<number>`COUNT(${userCompetitors.competitorId})::int`.as('competitor_count'),
    })
    .from(userCompetitors)
    .groupBy(userCompetitors.userId)
    .as('competitor_count')

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      role: users.role,
      createdAt: users.createdAt,
      lastDigestAt: lastDigest.lastDigestAt,
      competitorCount: competitorCount.competitorCount,
    })
    .from(users)
    .leftJoin(lastDigest, eq(users.id, lastDigest.userId))
    .leftJoin(competitorCount, eq(users.id, competitorCount.userId))
    .orderBy(desc(users.createdAt))

  return {
    rows: rows.map<UserRow>((r) => ({
      id: r.id,
      email: r.email,
      status: r.status,
      role: r.role,
      createdAt: r.createdAt.toISOString(),
      lastDigestAt: r.lastDigestAt ? new Date(r.lastDigestAt).toISOString() : null,
      competitorCount: r.competitorCount ?? 0,
    })),
  }
})

export const Route = createFileRoute('/admin/users/')({
  loader: () => listUsers(),
  component: AdminUsersListPage,
})

function AdminUsersListPage() {
  const { rows } = Route.useLoaderData()
  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? 'user' : 'users'} · newest first
            </p>
          </div>
        </header>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            No users yet. Invites land them here once they redeem the magic link.
          </p>
        ) : (
          <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
            {rows.map((row) => (
              <UserRowItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}

function UserRowItem({ row }: { row: UserRow }) {
  const joined = formatDate(row.createdAt)
  const lastDigest = row.lastDigestAt ? formatDate(row.lastDigestAt) : null
  return (
    <li>
      <Link
        to="/admin/users/$userId"
        params={{ userId: row.id }}
        className="group flex flex-col gap-2 px-5 py-4 transition-colors hover:bg-paper sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{row.email}</span>
            <StatusPill status={row.status} />
            {row.role === 'admin' ? (
              <span className="inline-flex items-center rounded-pill bg-accent-warm/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
                Admin
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-xs text-text-muted">
            Joined {joined}
            {lastDigest ? ` · last digest ${lastDigest}` : ' · no digest yet'}
            {' · '}
            {row.competitorCount} competitor{row.competitorCount === 1 ? '' : 's'}
          </div>
        </div>
        <span
          aria-hidden
          className="hidden text-text-muted transition-transform group-hover:translate-x-[2px] group-hover:text-text sm:inline"
        >
          →
        </span>
      </Link>
    </li>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-accent/30 text-text'
      : status === 'onboarding'
        ? 'bg-coral/20 text-text'
        : status === 'paused'
          ? 'bg-ink-line text-text-muted'
          : 'bg-ink/10 text-text-muted'
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${tone}`}
    >
      {status}
    </span>
  )
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
