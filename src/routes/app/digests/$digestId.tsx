import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { DigestItemCard, type DigestItemView } from '~/components/app/DigestItemCard'
import { digestItems, digests, feedback, rawItems } from '~/db/schema'
import type { DigestTag } from '~/design/tokens'
import { requireSession } from '~/lib/auth-server'
import { getDb } from '~/lib/db'
import { signFeedbackToken } from '~/lib/feedback-token'

type DigestView = {
  id: string
  createdAt: string
  itemCount: number
  items: DigestItemView[]
}

function buildFeedbackUrls(digestItemId: string) {
  return {
    up: `/r/${digestItemId}/up?t=${signFeedbackToken(digestItemId, 'up')}`,
    down: `/r/${digestItemId}/down?t=${signFeedbackToken(digestItemId, 'down')}`,
  }
}

const loadDigest = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) =>
    z.object({ digestId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data }): Promise<DigestView> => {
    const session = await requireSession()
    const db = getDb()

    const [digest] = await db
      .select()
      .from(digests)
      .where(and(eq(digests.id, data.digestId), eq(digests.userId, session.user.id)))
      .limit(1)
    if (!digest) throw notFound()

    const rows = await db
      .select({
        id: digestItems.id,
        category: digestItems.category,
        headline: digestItems.headline,
        snippet: digestItems.snippet,
        impactNote: digestItems.impactNote,
        score: digestItems.score,
        sourceUrl: rawItems.url,
      })
      .from(digestItems)
      .innerJoin(rawItems, eq(digestItems.rawItemId, rawItems.id))
      .where(eq(digestItems.digestId, digest.id))
      .orderBy(desc(digestItems.score), asc(digestItems.createdAt))

    const feedbackRows = rows.length
      ? await db
          .select({ digestItemId: feedback.digestItemId, rating: feedback.rating })
          .from(feedback)
          .where(eq(feedback.userId, session.user.id))
      : []
    const feedbackByItem = new Map(
      feedbackRows.map((f) => [f.digestItemId, f.rating] as const),
    )

    return {
      id: digest.id,
      createdAt: digest.createdAt.toISOString(),
      itemCount: digest.itemCount,
      items: rows.map<DigestItemView>((r) => ({
        id: r.id,
        category: r.category as DigestTag,
        headline: r.headline,
        snippet: r.snippet,
        impactNote: r.impactNote,
        sourceUrl: r.sourceUrl,
        feedback: feedbackByItem.get(r.id) ?? null,
        feedbackUrls: buildFeedbackUrls(r.id),
      })),
    }
  })

const paramsSchema = z.object({ digestId: z.string().uuid() })

export const Route = createFileRoute('/app/digests/$digestId')({
  loader: async ({ params }) => {
    const parsed = paramsSchema.safeParse(params)
    if (!parsed.success) throw notFound()
    return loadDigest({ data: parsed.data })
  },
  component: DigestDetailPage,
})

function DigestDetailPage() {
  const digest = Route.useLoaderData()
  const date = new Date(digest.createdAt)
  const dateLabel = date
    .toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    .toUpperCase()
  const timeLabel = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Link
        to="/app/digests"
        className="mb-8 inline-flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-[#8a8a98] hover:text-white"
      >
        <span aria-hidden>←</span> All digests
      </Link>

      <div
        className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
        style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.4)' }}
      >
        <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
          <div className="text-[13px] text-[#888]">
            <strong className="font-semibold text-white">Product Flash</strong>{' '}
            · daily brief
          </div>
          <div className="font-mono text-xs text-[#666]">
            {dateLabel} · {timeLabel}
          </div>
        </div>

        <div className="px-7 py-9">
          {digest.items.length === 0 ? (
            <EmptyDigestBody />
          ) : (
            <>
              <div className="mb-6 text-sm text-[#888]">
                {greetingFor(digest.items.length)}
              </div>
              {digest.items.map((item, idx) => (
                <DigestItemCard
                  key={item.id}
                  item={item}
                  isLast={idx === digest.items.length - 1}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  )
}

function greetingFor(count: number) {
  if (count === 1) return 'One thing mattered overnight.'
  return `${countWord(count)} things mattered overnight.`
}

function countWord(n: number) {
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']
  return words[n] ?? String(n)
}

function EmptyDigestBody() {
  return (
    <div className="py-6 text-center">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
        Nothing notable overnight
      </div>
      <p className="mx-auto max-w-[480px] text-[15px] text-[#a8a8b8]">
        Your competitors went quiet. We'd rather tell you nothing happened than
        invent something. Back tomorrow.
      </p>
    </div>
  )
}
