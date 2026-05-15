import { Outlet, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { AppHeader } from '~/components/app/AppHeader'
import { Toaster } from '~/components/ui/sonner'
import { requireSession } from '~/lib/auth-server'

// Server fn wrapper so `beforeLoad` can call a server-only helper
// during SSR + client navigations. The handler throws a TanStack
// `redirect` when no session is present — TanStack catches it and
// routes to /login before this layout renders.
const ensureAuthed = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await requireSession()
  return { email: session.user.email, name: session.user.name ?? null }
})

export const Route = createFileRoute('/app')({
  beforeLoad: async () => {
    const user = await ensureAuthed()
    return { user }
  },
  component: AppLayout,
})

function AppLayout() {
  const { user } = Route.useRouteContext()
  return (
    <div className="min-h-screen bg-ink text-white antialiased">
      <AppHeader email={user.email} />
      <Outlet />
      <Toaster theme="dark" />
    </div>
  )
}
