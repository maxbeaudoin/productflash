import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { waitlist } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'

const bodySchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().max(160).optional(),
  position: z.string().trim().max(120).optional(),
  companyUrl: z.string().trim().url().max(500).optional().or(z.literal('').transform(() => undefined)),
  source: z.string().trim().max(64).optional(),
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export const Route = createFileRoute('/api/waitlist')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let payload: unknown
        try {
          payload = await request.json()
        } catch {
          return json({ ok: false, error: 'invalid_json' }, 400)
        }
        const parsed = bodySchema.safeParse(payload)
        if (!parsed.success) {
          return json({ ok: false, error: 'invalid_input' }, 400)
        }
        const { email, name, position, companyUrl, source } = parsed.data
        const db = getDb()
        await db
          .insert(waitlist)
          .values({
            email: email.toLowerCase(),
            name: name || null,
            position: position || null,
            companyUrl: companyUrl || null,
            source: source || null,
          })
          .onConflictDoNothing({ target: waitlist.email })

        logger.info({ email: email.toLowerCase(), source }, 'waitlist_joined')

        return json({ ok: true })
      },
    },
  },
})
