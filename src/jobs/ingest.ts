import { competitors as competitorsTable, rawItems } from '~/db/schema'
import type { NewRawItem } from '~/db/schema'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { captureServerEvent } from '~/lib/posthog'
import { scrapePricingPagesForCompetitors } from '~/sources/firecrawl'
import {
  loadLatestPricingSnapshots,
  saveLatestPricingSnapshot,
} from '~/sources/firecrawl-store'
import { fetchFirehoseForCompetitors } from '~/sources/firehose'
import { fetchPHForCompetitors } from '~/sources/ph'
import { fetchRSSForCompetitors } from '~/sources/rss'
import type { CompetitorRef, NormalizedItem, SourceName } from '~/sources/types'

// Daily ingestion orchestrator.
//
// One pg-boss cron schedule fires this at 04:00 UTC (see src/worker/index.ts).
// We fan out across the 4 source adapters in parallel; each adapter is already
// batched per-competitor internally, so the orchestrator just collects results
// and bulk-inserts.
//
// Failure model: each adapter is wrapped in allSettled — one bad vendor
// (e.g. Firehose 5xx) must not block items from the other three. The
// per-source `errored` flag tells the next run / observer which axis failed.
//
// Dedupe: raw_items has a unique (source, source_id) index. We insert with
// ON CONFLICT DO NOTHING and use RETURNING to count actual inserts vs
// duplicates seen before.

export const INGEST_QUEUE = 'ingest-run'
export const INGEST_CRON = '0 4 * * *' // 04:00 UTC daily, per SCOPE.md §6

export interface SourceMetrics {
  fetched: number
  inserted: number
  errored: boolean
}

export interface IngestionMetrics {
  competitors: number
  durationMs: number
  perSource: Record<SourceName, SourceMetrics>
  totalFetched: number
  totalInserted: number
}

export async function runIngestion(): Promise<IngestionMetrics> {
  const started = Date.now()
  const db = getDb()

  const rows = await db.select().from(competitorsTable)
  const refs: CompetitorRef[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    homepageUrl: r.homepageUrl,
    rssUrl: r.rssUrl,
    phSlug: r.phSlug,
    pricingUrl: r.pricingUrl,
  }))

  logger.info({ competitors: refs.length }, 'ingest: starting run')

  if (refs.length === 0) {
    const metrics = emptyMetrics(0, Date.now() - started)
    logger.warn(metrics, 'ingest: no competitors, skipping run')
    emitPosthog(metrics)
    return metrics
  }

  const prevSnapshots = await loadLatestPricingSnapshots(
    db,
    refs.map((c) => c.id),
  )

  const [rssResult, phResult, firehoseResult, firecrawlResult] = await Promise.allSettled([
    fetchRSSForCompetitors(refs),
    fetchPHForCompetitors(refs),
    fetchFirehoseForCompetitors(refs),
    scrapePricingPagesForCompetitors(refs, prevSnapshots),
  ])

  const perSource: Record<SourceName, SourceMetrics> = {
    rss: settleToFanoutMetrics(rssResult, 'rss'),
    ph: settleToFanoutMetrics(phResult, 'ph'),
    firehose: settleToFanoutMetrics(firehoseResult, 'firehose'),
    firecrawl: { fetched: 0, inserted: 0, errored: firecrawlResult.status === 'rejected' },
  }

  const inserts: NewRawItem[] = []
  collectFanout(rssResult, inserts)
  collectFanout(phResult, inserts)
  collectFanout(firehoseResult, inserts)

  if (firecrawlResult.status === 'fulfilled') {
    for (const [competitorId, result] of firecrawlResult.value) {
      try {
        await saveLatestPricingSnapshot(db, competitorId, result.newSnapshot)
      } catch (err) {
        logger.warn({ err, competitorId }, 'ingest: failed to persist pricing snapshot')
      }
      if (result.item) {
        inserts.push(toNewRawItem(competitorId, result.item))
        perSource.firecrawl.fetched++
      }
    }
  } else {
    logger.warn({ err: firecrawlResult.reason }, 'ingest: firecrawl batch rejected')
  }

  let insertedRows: Array<{ source: SourceName }> = []
  if (inserts.length > 0) {
    insertedRows = await db
      .insert(rawItems)
      .values(inserts)
      .onConflictDoNothing({ target: [rawItems.source, rawItems.sourceId] })
      .returning({ source: rawItems.source })
  }
  for (const row of insertedRows) {
    perSource[row.source].inserted++
  }

  const totalFetched =
    perSource.rss.fetched +
    perSource.ph.fetched +
    perSource.firehose.fetched +
    perSource.firecrawl.fetched
  const totalInserted =
    perSource.rss.inserted +
    perSource.ph.inserted +
    perSource.firehose.inserted +
    perSource.firecrawl.inserted

  const metrics: IngestionMetrics = {
    competitors: refs.length,
    durationMs: Date.now() - started,
    perSource,
    totalFetched,
    totalInserted,
  }

  logger.info(metrics, 'ingest: run complete')
  emitPosthog(metrics)
  return metrics
}

function settleToFanoutMetrics(
  result: PromiseSettledResult<Map<string, NormalizedItem[]>>,
  source: SourceName,
): SourceMetrics {
  if (result.status === 'rejected') {
    logger.warn({ err: result.reason, source }, 'ingest: source batch rejected')
    return { fetched: 0, inserted: 0, errored: true }
  }
  let fetched = 0
  for (const items of result.value.values()) fetched += items.length
  return { fetched, inserted: 0, errored: false }
}

function collectFanout(
  result: PromiseSettledResult<Map<string, NormalizedItem[]>>,
  out: NewRawItem[],
): void {
  if (result.status !== 'fulfilled') return
  for (const [competitorId, items] of result.value) {
    for (const item of items) {
      out.push(toNewRawItem(competitorId, item))
    }
  }
}

function toNewRawItem(competitorId: string, item: NormalizedItem): NewRawItem {
  return {
    competitorId,
    source: item.source,
    sourceId: item.sourceId,
    url: item.url,
    title: item.title,
    body: item.body,
    publishedAt: item.publishedAt,
  }
}

function emptyMetrics(competitors: number, durationMs: number): IngestionMetrics {
  return {
    competitors,
    durationMs,
    perSource: {
      rss: { fetched: 0, inserted: 0, errored: false },
      ph: { fetched: 0, inserted: 0, errored: false },
      firehose: { fetched: 0, inserted: 0, errored: false },
      firecrawl: { fetched: 0, inserted: 0, errored: false },
    },
    totalFetched: 0,
    totalInserted: 0,
  }
}

function emitPosthog(m: IngestionMetrics): void {
  captureServerEvent('worker', 'ingestion_run', {
    competitors: m.competitors,
    duration_ms: m.durationMs,
    total_fetched: m.totalFetched,
    total_inserted: m.totalInserted,
    rss_fetched: m.perSource.rss.fetched,
    rss_inserted: m.perSource.rss.inserted,
    rss_errored: m.perSource.rss.errored,
    ph_fetched: m.perSource.ph.fetched,
    ph_inserted: m.perSource.ph.inserted,
    ph_errored: m.perSource.ph.errored,
    firehose_fetched: m.perSource.firehose.fetched,
    firehose_inserted: m.perSource.firehose.inserted,
    firehose_errored: m.perSource.firehose.errored,
    firecrawl_fetched: m.perSource.firecrawl.fetched,
    firecrawl_inserted: m.perSource.firecrawl.inserted,
    firecrawl_errored: m.perSource.firecrawl.errored,
  })
}
