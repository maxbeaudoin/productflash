import { FeedbackButtons } from './FeedbackButtons'
import type { DigestTag } from '~/design/tokens'

export type DigestItemView = {
  id: string
  category: DigestTag
  headline: string
  snippet: string
  impactNote: string | null
  sourceUrl: string | null
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
