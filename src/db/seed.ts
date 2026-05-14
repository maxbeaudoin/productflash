import { getDb, getPool } from '~/lib/db'
import { logger } from '~/lib/logger'
import { competitors, type NewCompetitor } from './schema'

// A handful of real SaaS competitors covering analytics / CRM / devtools /
// product surfaces — enough to exercise all four source adapters end-to-end
// in task #8. Idempotent: re-running won't duplicate rows.
const seedCompetitors: NewCompetitor[] = [
  {
    name: 'Linear',
    homepageUrl: 'https://linear.app',
    rssUrl: 'https://linear.app/changelog/rss.xml',
    phSlug: 'linear',
    pricingUrl: 'https://linear.app/pricing',
  },
  {
    name: 'Notion',
    homepageUrl: 'https://www.notion.so',
    rssUrl: 'https://www.notion.so/blog/rss.xml',
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
    rssUrl: 'https://resend.com/changelog/rss.xml',
    phSlug: 'resend',
    pricingUrl: 'https://resend.com/pricing',
  },
  {
    name: 'Attio',
    homepageUrl: 'https://attio.com',
    rssUrl: 'https://attio.com/changelog/rss.xml',
    phSlug: 'attio',
    pricingUrl: 'https://attio.com/pricing',
  },
  {
    name: 'Amplitude',
    homepageUrl: 'https://amplitude.com',
    rssUrl: null,
    phSlug: 'amplitude',
    pricingUrl: 'https://amplitude.com/pricing',
  },
]

async function main() {
  const db = getDb()
  const inserted = await db
    .insert(competitors)
    .values(seedCompetitors)
    .onConflictDoNothing({ target: competitors.homepageUrl })
    .returning({ id: competitors.id, name: competitors.name })

  logger.info(
    { newlyInserted: inserted.length, total: seedCompetitors.length },
    'seed competitors done',
  )

  await getPool().end()
}

main().catch((err) => {
  logger.fatal({ err }, 'seed failed')
  process.exit(1)
})
