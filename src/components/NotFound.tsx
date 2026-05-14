import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">404 — Not found</h1>
      <p className="mt-2 text-sm opacity-70">
        That page doesn't exist (yet).
      </p>
      <Link to="/" className="mt-4 inline-block underline">
        Go home
      </Link>
    </div>
  )
}
