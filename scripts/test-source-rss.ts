import { competitors } from '~/db/schema'
import { getDb, getPool } from '~/lib/db'
import { logger } from '~/lib/logger'
import { autodetectRSSForHomepage, fetchRSSForCompetitors } from '~/sources/rss'
import type { CompetitorRef } from '~/sources/types'

// End-to-end probe for the RSS adapter.
//
//  pnpm tsx scripts/test-source-rss.ts
//     -> Fetch every seeded competitor that has an rss_url and print per-feed
//        counts + a few items. Then re-run to prove dedupe holds (sourceIds
//        across the two runs should be identical sets, not new IDs).
//
//  pnpm tsx scripts/test-source-rss.ts --autodetect
//     -> Same as above, plus run autodetect against each seeded homepage
//        (ignoring the stored rss_url) and report whether the resolver
//        rediscovers a feed. Useful before #15 wires the helper into signup.

async function main() {
  const autodetect = process.argv.includes('--autodetect')
  const db = getDb()

  const rows = await db.select().from(competitors)
  const refs: CompetitorRef[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    homepageUrl: r.homepageUrl,
    rssUrl: r.rssUrl,
    phSlug: r.phSlug,
    pricingUrl: r.pricingUrl,
  }))

  const withFeed = refs.filter((r) => r.rssUrl)
  logger.info(
    { total: refs.length, withFeed: withFeed.length },
    'rss probe: competitors loaded',
  )

  // --- run 1 ---
  const started1 = Date.now()
  const run1 = await fetchRSSForCompetitors(withFeed)
  logger.info(
    { durationMs: Date.now() - started1, fetched: run1.size },
    'rss probe: run 1 complete',
  )

  for (const c of withFeed) {
    const items = run1.get(c.id) ?? []
    logger.info(
      { competitor: c.name, rssUrl: c.rssUrl, count: items.length },
      'rss result',
    )
    for (const item of items.slice(0, 3)) {
      logger.info(
        {
          competitor: c.name,
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt?.toISOString(),
          sourceId: item.sourceId.slice(0, 80),
        },
        'rss item',
      )
    }
  }

  // --- run 2 (dedupe check) ---
  logger.info('rss probe: re-running to verify sourceId stability for dedupe')
  const run2 = await fetchRSSForCompetitors(withFeed)

  let stable = 0
  let drifted = 0
  for (const c of withFeed) {
    const ids1 = new Set((run1.get(c.id) ?? []).map((i) => i.sourceId))
    const ids2 = new Set((run2.get(c.id) ?? []).map((i) => i.sourceId))
    const overlap = [...ids1].filter((id) => ids2.has(id)).length
    const onlyIn1 = [...ids1].filter((id) => !ids2.has(id)).length
    const onlyIn2 = [...ids2].filter((id) => !ids1.has(id)).length
    if (ids1.size === 0 && ids2.size === 0) continue
    if (onlyIn1 === 0 && onlyIn2 === 0) {
      stable++
    } else {
      drifted++
      logger.warn(
        { competitor: c.name, overlap, onlyIn1, onlyIn2 },
        'rss dedupe: sourceId set drifted between runs',
      )
    }
  }
  logger.info({ stable, drifted }, 'rss probe: dedupe verification done')
  if (drifted > 0) process.exitCode = 1

  // --- autodetect ---
  if (autodetect) {
    logger.info('rss probe: running autodetect against seeded homepages')
    let resolved = 0
    for (const c of refs) {
      try {
        const found = await autodetectRSSForHomepage(c.homepageUrl)
        if (found) {
          resolved++
          const expected = c.rssUrl ?? '(none stored)'
          const match = found === c.rssUrl ? 'matches-seed' : 'different-from-seed'
          logger.info(
            { competitor: c.name, homepageUrl: c.homepageUrl, found, expected, match },
            'rss autodetect: resolved',
          )
        } else {
          logger.warn(
            { competitor: c.name, homepageUrl: c.homepageUrl, expected: c.rssUrl ?? '(none)' },
            'rss autodetect: no feed found',
          )
        }
      } catch (err) {
        logger.warn({ err, competitor: c.name }, 'rss autodetect: threw')
      }
    }
    logger.info({ resolved, total: refs.length }, 'rss autodetect: summary')
    if (resolved === 0) {
      logger.error('rss autodetect: FAILED — resolved zero feeds across all competitors')
      process.exitCode = 1
    }
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'rss probe failed')
    process.exit(1)
  })
  .finally(() => getPool().end())
