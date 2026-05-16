import { Outlet, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { AdminHeader } from '~/components/admin/AdminHeader'
import { requireAdminSession } from '~/lib/auth-server'

// Same shape as the /app layout, but layered: requireAdminSession first
// confirms a session, then checks the admin role from Better Auth's
// admin plugin. Non-admins are bounced to /app/digests rather than the
// public landing — they're authenticated, just not authorized for this
// surface.
const ensureAdmin = createServerFn({ method: 'GET' }).handler(async () => {
  const session = await requireAdminSession()
  return { email: session.user.email }
})

export const Route = createFileRoute('/admin')({
  beforeLoad: async () => {
    const admin = await ensureAdmin()
    return { admin }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { admin } = Route.useRouteContext()
  return (
    <div className="min-h-screen bg-paper text-text antialiased">
      <AdminHeader email={admin.email} />
      <Outlet />
    </div>
  )
}
