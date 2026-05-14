import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Landing,
})

function Landing() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold">Product Flash</h1>
        <p className="mt-2 text-sm opacity-70">
          Landing page lives here — port from <code>executive-summary.html</code> ships in task #14.
        </p>
      </div>
    </main>
  )
}
