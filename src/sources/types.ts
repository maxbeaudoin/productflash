import type { Competitor } from '~/db/schema'

export type SourceName = 'rss' | 'ph' | 'firehose' | 'firecrawl'

export interface NormalizedItem {
  source: SourceName
  sourceId: string
  url: string
  title: string
  body: string | null
  publishedAt: Date | null
}

export type CompetitorRef = Pick<
  Competitor,
  'id' | 'name' | 'homepageUrl' | 'rssUrl' | 'phSlug' | 'pricingUrl'
>
