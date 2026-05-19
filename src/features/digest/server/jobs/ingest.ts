import { and, eq, inArray } from "drizzle-orm";
import {
  competitors as competitorsTable,
  competitorSources,
  rawItems,
  userCompetitors,
} from "~/db/schema";
import type { NewRawItem } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import { scrapePricingPagesForCompetitors } from "~/sources/firecrawl";
import { loadLatestPricingSnapshots, saveLatestPricingSnapshot } from "~/sources/firecrawl-store";
import { fetchFirehoseForCompetitors } from "~/sources/firehose";
import { fetchPHForCompetitors } from "~/sources/ph";
import { fetchRSSForCompetitors } from "~/sources/rss";
import type { CompetitorRef, NormalizedItem, SourceName } from "~/sources/types";
import {
  fetchWebpageForSources,
  type WebpageFetchOptions,
  type WebpageSourceRef,
} from "~/sources/webpage";

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

export const INGEST_QUEUE = "ingest-run";
export const INGEST_CRON = "0 4 * * *"; // 04:00 UTC daily, per SCOPE.md §6

export interface SourceMetrics {
  fetched: number;
  inserted: number;
  errored: boolean;
}

export interface IngestionMetrics {
  competitors: number;
  durationMs: number;
  perSource: Record<SourceName, SourceMetrics>;
  totalFetched: number;
  totalInserted: number;
}

export async function runIngestion(options: WebpageFetchOptions = {}): Promise<IngestionMetrics> {
  const db = getDb();
  const rows = await db.select().from(competitorsTable);
  const refs: CompetitorRef[] = rows.map(rowToRef);
  return runIngestionForRefs(refs, "ingest: starting run", {}, options);
}

// On-demand variant used by the time-to-first-digest fast path (#30). Scopes
// adapters to a single user's competitors so we don't pay for the full
// global crawl when a brand-new user finishes onboarding.
export async function runIngestionForUser(
  userId: string,
  options: WebpageFetchOptions = {},
): Promise<IngestionMetrics> {
  const db = getDb();
  const ids = (
    await db
      .select({ id: userCompetitors.competitorId })
      .from(userCompetitors)
      .where(eq(userCompetitors.userId, userId))
  ).map((r) => r.id);
  if (ids.length === 0) {
    const metrics = emptyMetrics(0, 0);
    logger.warn({ userId, ...metrics }, "ingest: user has no competitors, skipping run");
    return metrics;
  }
  const rows = await db.select().from(competitorsTable).where(inArray(competitorsTable.id, ids));
  return runIngestionForRefs(
    rows.map(rowToRef),
    "ingest: starting per-user run",
    { userId },
    options,
  );
}

async function runIngestionForRefs(
  refs: CompetitorRef[],
  startLog: string,
  context: Record<string, unknown> = {},
  webpageOptions: WebpageFetchOptions = {},
): Promise<IngestionMetrics> {
  const started = Date.now();
  const db = getDb();

  logger.info({ ...context, competitors: refs.length }, startLog);

  if (refs.length === 0) {
    const metrics = emptyMetrics(0, Date.now() - started);
    logger.warn({ ...context, ...metrics }, "ingest: no competitors, skipping run");
    emitPosthog(metrics);
    return metrics;
  }

  const competitorIds = refs.map((c) => c.id);

  const [prevSnapshots, webpageRefs] = await Promise.all([
    loadLatestPricingSnapshots(db, competitorIds),
    loadActiveWebpageSources(competitorIds, refs),
  ]);

  const [rssResult, phResult, firehoseResult, firecrawlResult, webpageResult] =
    await Promise.allSettled([
      fetchRSSForCompetitors(refs),
      fetchPHForCompetitors(refs),
      fetchFirehoseForCompetitors(refs),
      scrapePricingPagesForCompetitors(refs, prevSnapshots),
      fetchWebpageForSources(webpageRefs, webpageOptions),
    ]);

  const perSource: Record<SourceName, SourceMetrics> = {
    rss: settleToFanoutMetrics(rssResult, "rss"),
    ph: settleToFanoutMetrics(phResult, "ph"),
    firehose: settleToFanoutMetrics(firehoseResult, "firehose"),
    firecrawl: { fetched: 0, inserted: 0, errored: firecrawlResult.status === "rejected" },
    webpage: { fetched: 0, inserted: 0, errored: webpageResult.status === "rejected" },
  };

  const inserts: NewRawItem[] = [];
  collectFanout(rssResult, inserts);
  collectFanout(phResult, inserts);
  collectFanout(firehoseResult, inserts);

  if (firecrawlResult.status === "fulfilled") {
    for (const [competitorId, result] of firecrawlResult.value) {
      try {
        await saveLatestPricingSnapshot(db, competitorId, result.newSnapshot);
      } catch (err) {
        logger.warn({ err, competitorId }, "ingest: failed to persist pricing snapshot");
      }
      if (result.item) {
        inserts.push(toNewRawItem(competitorId, result.item));
        perSource.firecrawl.fetched++;
      }
    }
  } else {
    logger.warn({ err: firecrawlResult.reason }, "ingest: firecrawl batch rejected");
  }

  if (webpageResult.status === "fulfilled") {
    for (const [sourceId, result] of webpageResult.value) {
      // Persist the watcher's bookkeeping before we insert items so the
      // admin per-source list (PF-96) reflects the run even when no item
      // is emitted (snapshot unchanged, list with no new posts, etc.).
      try {
        await persistWebpageSourceState(sourceId, result);
      } catch (err) {
        logger.warn({ err, sourceId }, "ingest: failed to persist webpage source state");
      }
      for (const item of result.items) {
        inserts.push(toNewRawItem(result.competitorId, item, sourceId));
        perSource.webpage.fetched++;
      }
      if (result.errored) {
        perSource.webpage.errored = true;
      }
    }
  } else {
    logger.warn({ err: webpageResult.reason }, "ingest: webpage batch rejected");
  }

  let insertedRows: Array<{ source: SourceName }> = [];
  if (inserts.length > 0) {
    insertedRows = await db
      .insert(rawItems)
      .values(inserts)
      .onConflictDoNothing({ target: [rawItems.source, rawItems.sourceId] })
      .returning({ source: rawItems.source });
  }
  for (const row of insertedRows) {
    perSource[row.source].inserted++;
  }

  const totalFetched =
    perSource.rss.fetched +
    perSource.ph.fetched +
    perSource.firehose.fetched +
    perSource.firecrawl.fetched +
    perSource.webpage.fetched;
  const totalInserted =
    perSource.rss.inserted +
    perSource.ph.inserted +
    perSource.firehose.inserted +
    perSource.firecrawl.inserted +
    perSource.webpage.inserted;

  const metrics: IngestionMetrics = {
    competitors: refs.length,
    durationMs: Date.now() - started,
    perSource,
    totalFetched,
    totalInserted,
  };

  logger.info(metrics, "ingest: run complete");
  emitPosthog(metrics);
  return metrics;
}

async function loadActiveWebpageSources(
  competitorIds: string[],
  refs: CompetitorRef[],
): Promise<WebpageSourceRef[]> {
  if (competitorIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select()
    .from(competitorSources)
    .where(
      and(
        inArray(competitorSources.competitorId, competitorIds),
        eq(competitorSources.sourceType, "webpage"),
        eq(competitorSources.status, "active"),
      ),
    );
  const nameById = new Map(refs.map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    id: r.id,
    competitorId: r.competitorId,
    competitorName: nameById.get(r.competitorId) ?? "(unknown)",
    url: r.urlOrHandle,
    extractionMode:
      r.extractionMode === "snapshot_diff" || r.extractionMode === "list_extract"
        ? r.extractionMode
        : null,
    lastContentHash: r.lastContentHash,
  }));
}

async function persistWebpageSourceState(
  sourceId: string,
  result: {
    inferredMode: "snapshot_diff" | "list_extract" | null;
    newContentHash: string | null;
    fetchedAt: Date;
    errored: boolean;
  },
): Promise<void> {
  // Skip writes when the fetch errored — preserves last_content_hash so the
  // next successful fetch can still diff. last_fetched_at stays stale on
  // purpose: a missing update is the signal that the source is broken.
  if (result.errored) return;
  const db = getDb();
  const update: Partial<typeof competitorSources.$inferInsert> = {
    lastFetchedAt: result.fetchedAt,
  };
  if (result.inferredMode) update.extractionMode = result.inferredMode;
  if (result.newContentHash !== null) update.lastContentHash = result.newContentHash;
  await db.update(competitorSources).set(update).where(eq(competitorSources.id, sourceId));
}

function rowToRef(r: typeof competitorsTable.$inferSelect): CompetitorRef {
  return {
    id: r.id,
    name: r.name,
    homepageUrl: r.homepageUrl,
    rssUrl: r.rssUrl,
    phSlug: r.phSlug,
    pricingUrl: r.pricingUrl,
  };
}

export function settleToFanoutMetrics(
  result: PromiseSettledResult<Map<string, NormalizedItem[]>>,
  source: SourceName,
): SourceMetrics {
  if (result.status === "rejected") {
    logger.warn({ err: result.reason, source }, "ingest: source batch rejected");
    return { fetched: 0, inserted: 0, errored: true };
  }
  let fetched = 0;
  for (const items of result.value.values()) fetched += items.length;
  return { fetched, inserted: 0, errored: false };
}

export function collectFanout(
  result: PromiseSettledResult<Map<string, NormalizedItem[]>>,
  out: NewRawItem[],
): void {
  if (result.status !== "fulfilled") return;
  for (const [competitorId, items] of result.value) {
    for (const item of items) {
      out.push(toNewRawItem(competitorId, item));
    }
  }
}

function toNewRawItem(
  competitorId: string,
  item: NormalizedItem,
  competitorSourceId?: string,
): NewRawItem {
  return {
    competitorId,
    source: item.source,
    sourceId: item.sourceId,
    competitorSourceId: competitorSourceId ?? null,
    url: item.url,
    title: item.title,
    body: item.body,
    publishedAt: item.publishedAt,
  };
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
      webpage: { fetched: 0, inserted: 0, errored: false },
    },
    totalFetched: 0,
    totalInserted: 0,
  };
}

function emitPosthog(m: IngestionMetrics): void {
  captureServerEvent("worker", "ingestion_run", {
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
    webpage_fetched: m.perSource.webpage.fetched,
    webpage_inserted: m.perSource.webpage.inserted,
    webpage_errored: m.perSource.webpage.errored,
  });
}
