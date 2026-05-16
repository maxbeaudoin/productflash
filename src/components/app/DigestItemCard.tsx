import { FeedbackButtons } from './FeedbackButtons'
import type { DigestTag } from '~/design/tokens'

export type DigestItemView = {
  id: string
  category: DigestTag
  headline: string
  snippet: string
  impactNote: string | null
  sourceUrl: string | null
  // ISO string when the source supplied a publication time, null otherwise.
  // No fabricated "today" / "recently" — see [[feedback_rtfm]] and #41.
  occurredAt: string | null
  feedback?: 'up' | 'down' | null
  feedbackUrls?: { up: string; down: string }
}

// Color treatment mirrors `src/components/landing/DigestItem.tsx` so the
// in-app card reads identical to the email/landing mock. Source of truth
// for the underlying palette is `src/design/tokens.ts:digestTags`.
const TAG_TONE: Record<DigestTag, string> = {
  launch: 'bg-accent/15 text-accent',
  pricing: 'bg-coral/15 text-coral',
  feature: 'bg-[#78b4ff]/15 text-[#78b4ff]',
  positioning: 'bg-accent-warm/15 text-accent-warm',
  noise: 'bg-text-muted/15 text-text-muted',
}

const TAG_LABEL: Record<DigestTag, string> = {
  launch: 'Launch',
  pricing: 'Pricing',
  feature: 'Feature',
  positioning: 'Positioning',
  noise: 'Noise',
}

export function DigestItemCard({ item, isLast }: { item: DigestItemView; isLast: boolean }) {
  const timestamp = formatOccurredAt(item.occurredAt)
  return (
    <div
      className={`grid grid-cols-[100px_1fr] gap-6 py-6 max-md:grid-cols-1 max-md:gap-3 ${
        isLast ? '' : 'border-b border-[#2a2a38]'
      }`}
    >
      <div
        className={`h-fit rounded-[4px] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${TAG_TONE[item.category]}`}
      >
        {TAG_LABEL[item.category]}
      </div>
      <div>
        {timestamp ? (
          <div className="mb-1 font-mono text-[11px] uppercase tracking-[0.1em] text-[#7a7a88]">
            {timestamp}
          </div>
        ) : null}
        <div className="mb-[6px] text-base font-semibold leading-[1.4] text-white">
          {item.sourceUrl ? (
            <a
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-accent"
            >
              {item.headline}
            </a>
          ) : (
            item.headline
          )}
        </div>
        <div className="text-sm leading-[1.5] text-[#aaa]">
          {item.snippet}
          {item.impactNote ? (
            <>
              {' '}
              <em className="not-italic text-accent">{item.impactNote}</em>
            </>
          ) : null}
        </div>
        {item.feedbackUrls ? (
          <FeedbackButtons
            digestItemId={item.id}
            initialRating={item.feedback ?? null}
            signedUrls={item.feedbackUrls}
          />
        ) : null}
      </div>
    </div>
  )
}

// "May 14 · 2 days ago" when we know; null when the source didn't supply a
// date (e.g. some Firehose events). Server-rendered; relative phrasing reflects
// the moment the page was rendered — accurate enough at PoC fidelity, and
// users reload often enough that drift never compounds.
function formatOccurredAt(iso: string | null): string | null {
  if (!iso) return null
  const occurred = new Date(iso)
  if (Number.isNaN(occurred.getTime())) return null
  const dateLabel = occurred.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
  const relative = relativeLabel(occurred, new Date())
  return relative ? `${dateLabel} · ${relative}` : dateLabel
}

function relativeLabel(occurred: Date, now: Date): string | null {
  const diffMs = now.getTime() - occurred.getTime()
  if (diffMs < 0) return null
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) {
    if (minutes < 1) return 'just now'
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1 month ago' : `${months} months ago`
}
