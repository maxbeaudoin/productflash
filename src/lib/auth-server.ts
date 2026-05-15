import { redirect } from '@tanstack/react-router'
import { getRequest } from '@tanstack/react-start/server'
import { auth } from './auth'

export type AppSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

// Fetch the current session if one exists. Returns null when unauthenticated.
// Safe to call from server functions and route `beforeLoad` handlers.
export async function getSession(): Promise<AppSession | null> {
  const request = getRequest()
  return await auth.api.getSession({ headers: request.headers })
}

// Gate /app/* routes — throws a TanStack `redirect` to /login when there is
// no session. Use inside a parent route `beforeLoad`. Children inherit the
// guarantee that a session exists.
export async function requireSession(): Promise<AppSession> {
  const session = await getSession()
  if (!session) {
    throw redirect({ to: '/login', search: { reason: 'unauthenticated' } })
  }
  return session
}

// Gate /admin/* routes — first requires a session, then checks the admin
// role granted by Better Auth's admin plugin.
export async function requireAdminSession(): Promise<AppSession> {
  const session = await requireSession()
  if (session.user.role !== 'admin') {
    throw redirect({ to: '/app' })
  }
  return session
}
