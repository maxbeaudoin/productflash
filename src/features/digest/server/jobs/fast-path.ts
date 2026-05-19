import { and, desc, eq, gte } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { digests as digestsTable } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import { runIngestionForUser } from "./ingest";
import { runScoringForUser } from "./score";
import { runSynthesisForUser } from "./synthesize";

// Time-to-first-digest fast path (#30) / Re-gen catch-up (PF-91).
//
// When a user confirms their FTE-generated profile, we want their first
// digest to land within ~3–5 minutes instead of waiting for the next 05:30
// UTC cron. This job runs the same ingest → score → synthesize chain the
// crons use, but scoped to one user. Each stage is idempotent (the cron
// path can still overwrite later that day) so a fast-path run before the
// cron is safe.
//
// First-digest lookback is 90 days on `ingestedAt`, aligned with the
// `published_at` cap below (PF-92). A 7d ingest window seemed reasonable
// for greenfield users (FTE just stamped `ingestedAt = now` on every
// item), but it silently breaks the catch-up WOW moment for any user
// whose competitors were already being ingested when they signed up —
// shared competitors carry older `ingestedAt` from prior cron/FTE runs
// for other users, so a 7d window erases them. 90d on ingest + 90d on
// publish gives "everything we know about your competitors published in
// the last 3 months," which is what catch-up was always meant to be.
// Daily cadence reverts to 24h once the user has at least one digest
// behind them.
//
// Singleton per user: a double-click on "Looks good" or a re-run from the
// admin app is a no-op while the previous one is still in flight.

export const FAST_PATH_QUEUE = "fast-path-run";
const FAST_PATH_LOOKBACK_HOURS = 24 * 90;
// Hard recency cap on the first digest by `published_at`. The 7-day
// `ingested_at` window above is necessary but not sufficient: the FTE
// first ingest stamps `ingested_at = now` on every item the adapter
// returns, including archive-shaped RSS feeds whose `published_at`
// goes back years. Without this cap a brand-new user can land on a
// catch-up digest dominated by items published >1y ago, which is the
// opposite of "what's happening with my competitors right now"
// (PF-90). 90 days matches the issue's directive — anything older
// is almost certainly off-topic for the first impression.
const FAST_PATH_MAX_PUBLISHED_AGE_DAYS = 90;
// Score cap matches the wider window. With ~5 competitors over 90 days a
// catch-up pull can easily clear 500 items; we order by `ingestedAt desc`
// and cap at 200 so a chatty competitor's archive doesn't blow Haiku
// spend. 200 also fits the typical "most recent N most likely to be
// load-bearing" framing — older items in the same window are still
// readable in /app/digests once they roll into a daily.
const FAST_PATH_SCORE_CAP = 200;
// Catch-up digest is intentionally wider than the daily 5-item digest:
//   - 10 items so the user gets a meatier first impression of what we'll
//     surface over time.
//   - Cap-3 per competitor (vs daily cap-2) since a 10-item digest with
//     cap-2 forces the relaxed second pass to backfill 4+ slots from the
//     top-scored competitor, defeating the diversity intent. Cap-3 at 10
//     items keeps the highest-volume competitor at ~50% of the digest
//     instead of ~60% (dogfood 2026-05-16: 5L+3Lp+2x vs 6L+2Lp+2x).
const FAST_PATH_MAX_ITEMS_PER_DIGEST = 10;
const FAST_PATH_MAX_ITEMS_PER_COMPETITOR = 3;

export interface FastPathJobData {
  userId: string;
}

export interface FastPathMetrics {
  userId: string;
  durationMs: number;
  ingest: { fetched: number; inserted: number };
  score: { candidates: number; classified: number };
  synthesize: { candidates: number; synthesized: number; empty: boolean };
  digestId: string | null;
}

export async function enqueueFastPath(
  boss: PgBoss,
  userId: string,
): Promise<{ enqueued: boolean }> {
  const data: FastPathJobData = { userId };
  const jobId = await boss.send(FAST_PATH_QUEUE, data, { singletonKey: userId });
  return { enqueued: jobId !== null };
}

export async function handleFastPathJob(
  job: PgBoss.Job<FastPathJobData>,
): Promise<FastPathMetrics> {
  const { userId } = job.data;
  const started = Date.now();
  logger.info({ jobId: job.id, userId }, "fast-path: run started");

  const ingest = await runIngestionForUser(userId);
  const score = await runScoringForUser(userId, {
    lookbackHours: FAST_PATH_LOOKBACK_HOURS,
    maxItemsPerUser: FAST_PATH_SCORE_CAP,
    maxPublishedAgeDays: FAST_PATH_MAX_PUBLISHED_AGE_DAYS,
  });
  const synthesize = await runSynthesisForUser(userId, {
    lookbackHours: FAST_PATH_LOOKBACK_HOURS,
    maxItemsPerDigest: FAST_PATH_MAX_ITEMS_PER_DIGEST,
    maxItemsPerCompetitor: FAST_PATH_MAX_ITEMS_PER_COMPETITOR,
    maxPublishedAgeDays: FAST_PATH_MAX_PUBLISHED_AGE_DAYS,
  });

  // synthesize always upserts at most one digest per (user, UTC day). Re-read
  // its id for metrics so the worker logs make the chain traceable end-to-end.
  // The frontend at /app/digests picks it up via short-interval polling — no
  // LISTEN/NOTIFY plumbing needed at this scale.
  const digestId = await latestDigestIdForUser(userId);

  const metrics: FastPathMetrics = {
    userId,
    durationMs: Date.now() - started,
    ingest: { fetched: ingest.totalFetched, inserted: ingest.totalInserted },
    score: { candidates: score.candidates, classified: score.classified },
    synthesize: {
      candidates: synthesize.candidates,
      synthesized: synthesize.synthesized,
      empty: synthesize.empty,
    },
    digestId,
  };

  logger.info(metrics, "fast-path: run complete");
  captureServerEvent(userId, "fast_path_run", {
    duration_ms: metrics.durationMs,
    ingest_fetched: metrics.ingest.fetched,
    ingest_inserted: metrics.ingest.inserted,
    score_candidates: metrics.score.candidates,
    score_classified: metrics.score.classified,
    synthesize_candidates: metrics.synthesize.candidates,
    synthesize_synthesized: metrics.synthesize.synthesized,
    synthesize_empty: metrics.synthesize.empty,
    digest_id: metrics.digestId,
  });
  return metrics;
}

async function latestDigestIdForUser(userId: string): Promise<string | null> {
  const db = getDb();
  const dayStart = startOfUtcDay(new Date());
  const [row] = await db
    .select({ id: digestsTable.id })
    .from(digestsTable)
    .where(and(eq(digestsTable.userId, userId), gte(digestsTable.createdAt, dayStart)))
    .orderBy(desc(digestsTable.createdAt))
    .limit(1);
  return row?.id ?? null;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
