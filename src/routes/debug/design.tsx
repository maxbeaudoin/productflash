import { createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { Button } from '~/components/ui/button'
import { requireAdminSession } from '~/lib/auth-server'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'

// Admin-gated so a missing NODE_ENV on a deploy slot doesn't accidentally
// expose the page (and the design-smoke artifacts) to the public.
const ensureAdmin = createServerFn({ method: 'GET' }).handler(async () => {
  await requireAdminSession()
})

export const Route = createFileRoute('/debug/design')({
  beforeLoad: async () => {
    await ensureAdmin()
  },
  component: DesignSmokePage,
})

function DesignSmokePage() {
  const [name, setName] = useState('')

  return (
    <main className="min-h-screen bg-paper px-6 py-16 text-text">
      <div className="mx-auto max-w-3xl space-y-16">
        <header>
          <div className="mb-3 text-[11px] font-semibold tracking-[0.2em] text-text-muted uppercase">
            Product Flash · Design smoke test
          </div>
          <h1 className="font-sans text-5xl font-extrabold tracking-tight text-ink">
            Brand tokens reach <span className="text-coral">shadcn</span>.
          </h1>
          <p className="mt-4 font-mono text-sm text-text-muted">
            // If you can read this in Inter, headings included, the design
            system is wired.
          </p>
        </header>

        <section className="space-y-4">
          <div className="text-xs font-semibold tracking-widest text-text-muted uppercase">
            Palette
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Swatch name="ink" className="bg-ink text-paper" />
            <Swatch name="ink-soft" className="bg-ink-soft text-paper" />
            <Swatch name="paper" className="bg-paper text-ink ring-1 ring-ink/10" />
            <Swatch name="paper-warm" className="bg-paper-warm text-ink ring-1 ring-ink/10" />
            <Swatch name="accent" className="bg-accent text-ink" />
            <Swatch name="accent-warm" className="bg-accent-warm text-ink" />
            <Swatch name="coral" className="bg-coral text-paper" />
            <Swatch name="text" className="bg-text text-paper" />
            <Swatch name="text-muted" className="bg-text-muted text-paper" />
            <Swatch name="ink-line" className="bg-ink-line text-paper" />
          </div>
        </section>

        <section className="space-y-4">
          <div className="text-xs font-semibold tracking-widest text-text-muted uppercase">
            Buttons (shadcn primary maps to ink)
          </div>
          <div className="flex flex-wrap gap-3">
            <Button>Claim your seat</Button>
            <Button variant="secondary">Book a demo</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-xs font-semibold tracking-widest text-text-muted uppercase">
            Form primitives
          </div>
          <div className="grid max-w-md gap-2">
            <Label htmlFor="design-name">Name</Label>
            <Input
              id="design-name"
              placeholder="e.g. Mira"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div className="text-xs font-semibold tracking-widest text-text-muted uppercase">
            Dialog
          </div>
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>
              Open dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Product Flash</DialogTitle>
                <DialogDescription>
                  Brand tokens flow into shadcn primitives without touching
                  generated component source.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Close
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      </div>
    </main>
  )
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div
      className={`flex h-20 flex-col justify-end rounded-card p-3 font-mono text-xs ${className}`}
    >
      {name}
    </div>
  )
}
