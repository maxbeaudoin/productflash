import type { DigestPreviewItem } from '~/data/landing'

const TAG_TONE: Record<DigestPreviewItem['tone'], string> = {
  launch: 'bg-accent/15 text-accent',
  market: 'bg-coral/15 text-coral',
  voc: 'bg-[#78b4ff]/15 text-[#78b4ff]',
}

export function DigestItem({
  item,
  isLast,
}: {
  item: DigestPreviewItem
  isLast: boolean
}) {
  return (
    <div
      className={`grid grid-cols-[100px_1fr] gap-6 py-5 max-md:grid-cols-1 max-md:gap-3 ${
        isLast ? '' : 'border-b border-[#2a2a38]'
      }`}
    >
      <div
        className={`h-fit rounded-[4px] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${TAG_TONE[item.tone]}`}
      >
        {item.tag}
      </div>
      <div>
        <div className="mb-[6px] text-base font-semibold leading-[1.4] text-white">
          {item.headline}
        </div>
        <div className="text-sm leading-[1.5] text-[#aaa]">
          {item.summary}{' '}
          <em className="not-italic text-accent">{item.impact}</em>
        </div>
      </div>
    </div>
  )
}
