import { createFileRoute } from '@tanstack/react-router'

// Placeholder for the auth round-trip target. Replaced in #31 by a redirect
// to /app/digests + the real app shell.
export const Route = createFileRoute('/app/')({
  component: AppIndex,
})

function AppIndex() {
  const { user } = Route.useRouteContext()
  return (
    <main className="min-h-screen bg-paper text-text antialiased flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Signed in</h1>
        <p className="mt-3 text-text-muted">
          Welcome, <span className="font-mono">{user.email}</span>. The full app
          shell ships in task #31.
        </p>
        <a
          href="/logout"
          className="mt-8 inline-block rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper hover:bg-ink-soft"
        >
          Sign out
        </a>
      </div>
    </main>
  )
}
