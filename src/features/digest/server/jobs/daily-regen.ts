import type PgBoss from "pg-boss";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import { runScoringForUser } from "./score";
import { runSynthesisForUser } from "./synthesize";

// Daily-regen admin action (PF-91).
//
// Sibling to fast-path (catch-up regen). Where fast-path runs the full
// ingest → score → synthesize chain with catch-up params (7d/90d windows,
// 10 items, cap-3 per competitor), daily-regen skips ingest and uses
// daily params (24h lookback, 5 items, cap-2 per competitor) — the same
// numbers the 05:30 UTC cron uses.
//
// Why no ingest: re-pulling RSS for yesterday is a no-op (items already in
// `raw_items`). Score still runs because (a) the user's profile or (b) the
// classifier rules may have changed since the last cron run — re-scoring
// the in-window pool is what makes "re-gen" actually move the digest.
// score.runForUser is already idempotent per (user, raw_item) and the
// daily score cron leaves `maxPublishedAgeDays` unset, so this matches
// daily-cron behavior exactly.
//
// Synthesize's upsertDigest keys on (user, today UTC) — so re-gen
// overwrites today's row in place if one exists (id + createdAt survive,
// items replaced), else creates one. That's PF-91 Option-2 behavior:
// digest ids are stable across regen.
//
// Singleton per user: a double-click is a no-op while the previous one is
// still in flight, same shape as fast-path.

export const DAILY_REGEN_QUEUE = "daily-regen-run";

export interface DailyRegenJobData {
  userId: string;
}

export interface DailyRegenMetrics {
  userId: string;
  durationMs: number;
  score: { candidates: number; classified: number };
  synthesize: { candidates: number; synthesized: number; empty: boolean };
}

export async function enqueueDailyRegen(
  boss: PgBoss,
  userId: string,
): Promise<{ enqueued: boolean }> {
  const data: DailyRegenJobData = { userId };
  const jobId = await boss.send(DAILY_REGEN_QUEUE, data, { singletonKey: userId });
  return { enqueued: jobId !== null };
}

export async function handleDailyRegenJob(
  job: PgBoss.Job<DailyRegenJobData>,
): Promise<DailyRegenMetrics> {
  const { userId } = job.data;
  const started = Date.now();
  logger.info({ jobId: job.id, userId }, "daily-regen: run started");

  const score = await runScoringForUser(userId);
  const synthesize = await runSynthesisForUser(userId);

  const metrics: DailyRegenMetrics = {
    userId,
    durationMs: Date.now() - started,
    score: { candidates: score.candidates, classified: score.classified },
    synthesize: {
      candidates: synthesize.candidates,
      synthesized: synthesize.synthesized,
      empty: synthesize.empty,
    },
  };

  logger.info(metrics, "daily-regen: run complete");
  captureServerEvent(userId, "daily_regen_run", {
    duration_ms: metrics.durationMs,
    score_candidates: metrics.score.candidates,
    score_classified: metrics.score.classified,
    synthesize_candidates: metrics.synthesize.candidates,
    synthesize_synthesized: metrics.synthesize.synthesized,
    synthesize_empty: metrics.synthesize.empty,
  });
  return metrics;
}
