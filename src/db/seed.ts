import { sql } from 'drizzle-orm'
import { getDb, getPool } from '~/lib/db'
import { logger } from '~/lib/logger'
import { competitors, type NewCompetitor } from './schema'

// A handful of real SaaS competitors covering analytics / CRM / devtools /
// product surfaces — enough to exercise all four source adapters end-to-end
// in task #8. Idempotent: re-running won't duplicate rows.
//
// rssUrl values verified against live feeds via
// `pnpm tsx scripts/test-source-rss.ts --autodetect`. Linear, Notion, and
// Attio do not expose a parseable RSS/Atom feed — they rely on PH +
// Firehose + Firecrawl pricing-diff for coverage. The orchestrator handles
// nullable rssUrl by skipping the RSS adapter for that competitor.
const seedCompetitors: NewCompetitor[] = [
  {
    name: 'Linear',
    homepageUrl: 'https://linear.app',
    rssUrl: null,
    phSlug: 'linear',
    pricingUrl: 'https://linear.app/pricing',
  },
  {
    name: 'Notion',
    homepageUrl: 'https://www.notion.so',
    rssUrl: null,
    phSlug: 'notion',
    pricingUrl: 'https://www.notion.so/pricing',
  },
  {
    name: 'Vercel',
    homepageUrl: 'https://vercel.com',
    rssUrl: 'https://vercel.com/atom',
    phSlug: 'vercel',
    pricingUrl: 'https://vercel.com/pricing',
  },
  {
    name: 'PostHog',
    homepageUrl: 'https://posthog.com',
    rssUrl: 'https://posthog.com/rss.xml',
    phSlug: 'posthog',
    pricingUrl: 'https://posthog.com/pricing',
  },
  {
    name: 'Resend',
    homepageUrl: 'https://resend.com',
    rssUrl: 'https://resend.com/blog/index.xml',
    phSlug: 'resend',
    pricingUrl: 'https://resend.com/pricing',
  },
  {
    name: 'Attio',
    homepageUrl: 'https://attio.com',
    rssUrl: null,
    phSlug: 'attio',
    pricingUrl: 'https://attio.com/pricing',
  },
  {
    name: 'Amplitude',
    homepageUrl: 'https://amplitude.com',
    rssUrl: 'https://amplitude.com/feed',
    phSlug: 'amplitude',
    pricingUrl: 'https://amplitude.com/pricing',
  },
]

async function main() {
  const db = getDb()
  // Upsert (not insert-or-skip) so corrections to seed values — e.g. an RSS
  // URL discovered via autodetect — propagate to existing rows on re-run.
  // Still idempotent: identical input produces no new rows and no diffs.
  const upserted = await db
    .insert(competitors)
    .values(seedCompetitors)
    .onConflictDoUpdate({
      target: competitors.homepageUrl,
      set: {
        name: sql`excluded.name`,
        rssUrl: sql`excluded.rss_url`,
        phSlug: sql`excluded.ph_slug`,
        pricingUrl: sql`excluded.pricing_url`,
      },
    })
    .returning({ id: competitors.id, name: competitors.name })

  logger.info(
    { upserted: upserted.length, total: seedCompetitors.length },
    'seed competitors done',
  )

  await getPool().end()
}

main().catch((err) => {
  logger.fatal({ err }, 'seed failed')
  process.exit(1)
})
