type Props = {
  className?: string
}

const CLIP_PATH =
  'polygon(45% 0, 100% 0, 55% 45%, 100% 45%, 0 100%, 45% 55%, 0 55%)'

export function BrandMark({ className }: Props) {
  return (
    <div
      aria-hidden
      className={`bg-accent ${className ?? 'h-[22px] w-[22px]'}`}
      style={{ clipPath: CLIP_PATH }}
    />
  )
}
