import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { signIn } from '~/lib/auth-client'

const searchSchema = z.object({
  reason: z.enum(['unauthenticated']).optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: searchSchema,
  component: LoginPage,
})

function LoginPage() {
  const { reason } = Route.useSearch()
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('sending')
    setError(null)
    const { error } = await signIn.magicLink({ email, callbackURL: '/app' })
    if (error) {
      setError(error.message ?? 'Something went wrong')
      setState('error')
      return
    }
    setState('sent')
  }

  return (
    <main className="min-h-screen bg-paper text-text antialiased flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
        {reason === 'unauthenticated' ? (
          <p className="mt-3 text-coral">Sign in to continue.</p>
        ) : (
          <p className="mt-3 text-text-muted">
            Enter your email — we'll send a magic link.
          </p>
        )}

        {state === 'sent' ? (
          <div className="mt-8 rounded-2xl border border-ink-line bg-paper-warm p-6">
            <p className="font-medium">Check your inbox.</p>
            <p className="mt-2 text-sm text-text-muted">
              We sent a sign-in link to <span className="font-mono">{email}</span>.
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button type="submit" disabled={state === 'sending'} className="w-full">
              {state === 'sending' ? 'Sending…' : 'Send magic link'}
            </Button>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
        )}
      </div>
    </main>
  )
}
