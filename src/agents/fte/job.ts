import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { runFteAgent, type FteSignupHints } from "./agent";

// pg-boss adapter for the FTE agent (#28).
//
// One shared queue (`fte-run`) with per-user singleton semantics via
// `singletonKey: userId` — sending while a run is already pending/active for
// that user is a no-op (pg-boss returns null). This is the cleaner shape for
// fan-in from the signup server fn, since we don't want N parallel runs if a
// user double-clicks "Submit".

export const FTE_QUEUE = "fte-run";

export interface FteJobData {
  userId: string;
  runId: string;
  signup: FteSignupHints;
}

export interface EnqueueFteOptions {
  signup: FteSignupHints;
}

/**
 * Enqueue an FTE run for a user. Generates a fresh runId. Returns the runId
 * (or null if a run was already in flight for this user — caller can read
 * the previous runId from fte_events).
 */
export async function enqueueFteRun(
  boss: PgBoss,
  userId: string,
  options: EnqueueFteOptions,
): Promise<{ runId: string; enqueued: boolean }> {
  const runId = randomUUID();
  const data: FteJobData = {
    userId,
    runId,
    signup: options.signup,
  };
  const jobId = await boss.send(FTE_QUEUE, data, { singletonKey: userId });
  return { runId, enqueued: jobId !== null };
}

export async function handleFteJob(job: PgBoss.Job<FteJobData>): Promise<void> {
  const { userId, runId, signup } = job.data;
  await runFteAgent({ userId, runId, signup });
}
