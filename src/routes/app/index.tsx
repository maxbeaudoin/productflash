import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { users as usersTable } from '~/db/schema'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'

// /app is the magic-link callbackURL. Route new users (no profile confirmed
// yet) to the onboarding view; everyone else lands on /app/digests.

const resolveLanding = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await requireSession()
  const db = getDb()
  const [row] = await db
    .select({ profileConfirmedAt: usersTable.profileConfirmedAt })
    .from(usersTable)
    .where(eq(usersTable.id, session.user.id))
    .limit(1)
  return { confirmed: Boolean(row?.profileConfirmedAt) }
})

export const Route = createFileRoute('/app/')({
  beforeLoad: async () => {
    const { confirmed } = await resolveLanding()
    throw redirect({ to: confirmed ? '/app/digests' : '/app/onboarding' })
  },
})
