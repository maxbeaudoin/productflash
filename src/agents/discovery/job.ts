import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { competitors as competitorsTable } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { runDiscoveryAgent } from "./agent";

// pg-boss adapter for the source-discovery agent (PF-98 / PF-93 phase 5).
//
// One shared queue (`discovery-run`) with per-competitor singleton semantics
// via `singletonKey: "competitor:<id>"` — if a discovery run is already
// pending/active for that competitor, a duplicate enqueue is a no-op
// (pg-boss returns null). Two users adding the same competitor inside the
// same window race to the same outcome instead of double-running Sonnet.

export const DISCOVERY_QUEUE = "discovery-run";

export interface DiscoveryJobData {
  competitorId: string;
  runId: string;
}

export async function enqueueDiscovery(
  boss: PgBoss,
  competitorId: string,
): Promise<{ runId: string; enqueued: boolean }> {
  const runId = randomUUID();
  const data: DiscoveryJobData = { competitorId, runId };
  const jobId = await boss.send(DISCOVERY_QUEUE, data, {
    singletonKey: `competitor:${competitorId}`,
  });
  return { runId, enqueued: jobId !== null };
}

export async function handleDiscoveryJob(job: PgBoss.Job<DiscoveryJobData>): Promise<void> {
  const { competitorId, runId } = job.data;
  const db = getDb();
  const [c] = await db
    .select({
      id: competitorsTable.id,
      name: competitorsTable.name,
      homepageUrl: competitorsTable.homepageUrl,
    })
    .from(competitorsTable)
    .where(eq(competitorsTable.id, competitorId))
    .limit(1);
  if (!c) {
    logger.error(
      { competitorId, runId, jobId: job.id },
      "discovery: competitor row not found, skipping",
    );
    return;
  }
  const result = await runDiscoveryAgent({
    competitorId: c.id,
    competitorName: c.name,
    homepageUrl: c.homepageUrl,
    runId,
  });
  logger.info(
    {
      jobId: job.id,
      competitorId: c.id,
      competitorName: c.name,
      runId,
      iterations: result.iterations,
      clientToolCalls: result.clientToolCalls,
      serverToolCalls: result.serverToolCalls,
      sourcesRecorded: result.sourcesRecorded,
      finishedReason: result.finishedReason,
    },
    "discovery: job finished",
  );
}
