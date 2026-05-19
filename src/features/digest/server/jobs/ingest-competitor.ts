import type PgBoss from "pg-boss";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import { runIngestionForCompetitor } from "./ingest";

// Admin re-trigger for a single competitor's ingestion (PF-99).
//
// Sibling to fast-path/daily-regen but scoped at the competitor layer
// (ingestion only — scoring + synthesis are per-user and live elsewhere).
// Today's ingestion paths are global (cron) and per-user (fast-path); this
// queue exposes the third natural scope so an admin debugging one
// competitor's RSS feed doesn't trigger a full crawl.
//
// `policy: "stately"` is required for the `singletonKey: "competitor:<id>"`
// dedupe on send-time to actually work — pg-boss silently ignores
// singletonKey under the default 'standard' policy (see
// feedback_pgboss_singleton_requires_policy memory note). A double-click on
// the admin button while a run is in flight is a no-op.

export const INGEST_COMPETITOR_QUEUE = "ingest-competitor";

export interface IngestCompetitorJobData {
  competitorId: string;
}

export async function enqueueIngestCompetitor(
  boss: PgBoss,
  competitorId: string,
): Promise<{ enqueued: boolean }> {
  const data: IngestCompetitorJobData = { competitorId };
  const jobId = await boss.send(INGEST_COMPETITOR_QUEUE, data, {
    singletonKey: `competitor:${competitorId}`,
  });
  return { enqueued: jobId !== null };
}

export async function handleIngestCompetitorJob(
  job: PgBoss.Job<IngestCompetitorJobData>,
): Promise<void> {
  const { competitorId } = job.data;
  const started = Date.now();
  logger.info({ jobId: job.id, competitorId }, "ingest-competitor: run started");

  const metrics = await runIngestionForCompetitor(competitorId);

  logger.info(
    {
      jobId: job.id,
      competitorId,
      durationMs: Date.now() - started,
      totalFetched: metrics.totalFetched,
      totalInserted: metrics.totalInserted,
    },
    "ingest-competitor: run complete",
  );
  captureServerEvent("worker", "ingest_competitor_run", {
    competitor_id: competitorId,
    duration_ms: Date.now() - started,
    total_fetched: metrics.totalFetched,
    total_inserted: metrics.totalInserted,
  });
}
