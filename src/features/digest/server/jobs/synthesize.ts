import { and, desc, eq, gte, ne } from "drizzle-orm";
import {
  competitors as competitorsTable,
  digestItems,
  digests,
  itemScores,
  rawItems,
  users as usersTable,
} from "~/db/schema";
import type { NewDigestItem } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { recordLlmUsage } from "~/shared/server/llm-cost";
import { logger } from "~/shared/server/logger";
import { captureServerEvent } from "~/shared/server/posthog";
import {
  type ReaderProfile,
  type SynthesisInputItem,
  synthesizeDigest,
  type SynthesisUsage,
  type SynthesizedItem,
} from "~/features/digest/server/synthesize";

// Daily synthesis job.
//
// pg-boss fires this at 05:30 UTC, 30 minutes after scoring (#9). For each
// active user, take their top-scored non-noise items from the last 24h,
// cap at MAX_ITEMS_PER_DIGEST, and feed them to Sonnet as a single batch.
// Sonnet returns one editorial { headline, snippet, impactNote } tuple per
// input item, which we persist as digest_items pointing at a single
// digests row.
//
// Empty-digest policy (SCOPE.md §9): if zero items qualify for a user, we
// still persist a digests row with item_count=0 so the send job (#17) can
// emit the "nothing notable today" template instead of going silent.
//
// Idempotency: one digest per (user, UTC day). Re-runs in the same window
// delete the previous day's digest_items for this digest and overwrite. The
// Sonnet call happens outside the write step so a retry against the same
// candidates produces a clean replacement.

export const SYNTHESIZE_QUEUE = "synthesize-run";
export const SYNTHESIZE_CRON = "30 5 * * *"; // 05:30 UTC daily, per SCOPE.md §6

const LOOKBACK_HOURS = 24;
// Monday's digest covers the full weekend so users never come back to a
// Saturday-shaped gap. 72h reaches from Friday 05:30 UTC (the previous
// daily run) through Monday 05:30 UTC, so Sat/Sun ingestion gets folded
// into the Monday brief alongside late-Friday/early-Monday items. The
// daily cron path enables this automatically (see weekendAwareDefaults
// below); manual + fast-path callers can override via SynthesisOptions.
const MONDAY_LOOKBACK_HOURS = 72;
const MAX_ITEMS_PER_DIGEST = 5;
// Cap per competitor in the first selection pass. With MAX_ITEMS_PER_DIGEST=5
// this guarantees at least 3 distinct competitors in any digest where ≥3
// competitors have qualifying items. Dogfood iter 2 (2026-05-16) flagged
// digests dominated by a single high-volume competitor (Lattice in the
// surfaced case) — top-N-by-score alone doesn't enforce diversity. Daily
// cron uses this default; fast-path (catch-up) overrides with a looser cap
// since the wider 10-item digest needs more headroom per competitor.
const MAX_ITEMS_PER_COMPETITOR = 2;
// Pool fetch strategy: fetch ALL non-noise items in the window for this
// user, no score-based LIMIT. A flat top-N pool silently drops low-scored
// / low-volume competitors when a high-volume competitor's tail still
// beats their head — dogfood 2026-05-16 found 15Five (max non-noise score
// 42) entirely excluded from a 60-item pool because Lattice (68 non-noise
// items, max 92) consumed every slot. With WHERE already filtering by
// userId + non-noise + 7-day window, the realistic upper bound is a few
// hundred rows — safe to load fully and partition in memory.
const POOL_WARN_THRESHOLD = 2000;

export interface UserSynthesisMetrics {
  userId: string;
  candidates: number;
  synthesized: number;
  empty: boolean;
  errored: boolean;
}

export interface SynthesisMetrics {
  users: number;
  durationMs: number;
  totalCandidates: number;
  totalSynthesized: number;
  emptyDigests: number;
  erroredUsers: number;
  perUser: UserSynthesisMetrics[];
}

export interface SynthesisOptions {
  lookbackHours?: number;
  maxItemsPerDigest?: number;
  // Per-competitor cap in the first selection pass. Falls back to the module
  // default when omitted. Fast-path (catch-up) overrides this with a looser
  // cap since a 10-item digest needs more headroom per competitor than a
  // 5-item daily one.
  maxItemsPerCompetitor?: number;
  now?: Date;
  // When true, skip the run entirely on UTC Sat/Sun (no digests produced).
  // The cron path passes this; manual `pnpm synthesize:run` does not so
  // weekend dogfooding still works.
  skipWeekends?: boolean;
  // When true and `lookbackHours` is unset, the cron path widens lookback
  // to MONDAY_LOOKBACK_HOURS on UTC Monday so the Monday digest covers
  // Fri+Sat+Sun. Off by default for manual/fast-path callers.
  useWeekendAwareDefaults?: boolean;
}

// On-demand variant used by the debug preview (#25) and the time-to-first
// digest fast path (#30). Bypasses the `status='active'` filter and runs
// for one user only — same idempotency rules as the cron path.
export async function runSynthesisForUser(
  userId: string,
  options: SynthesisOptions = {},
): Promise<UserSynthesisMetrics> {
  const db = getDb();
  const lookbackHours = options.lookbackHours ?? LOOKBACK_HOURS;
  const maxItems = options.maxItemsPerDigest ?? MAX_ITEMS_PER_DIGEST;
  const maxPerCompetitor = options.maxItemsPerCompetitor ?? MAX_ITEMS_PER_COMPETITOR;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const dayStart = startOfUtcDay(now);

  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      position: usersTable.position,
      companyName: usersTable.companyName,
      ultimateGoal: usersTable.ultimateGoal,
      focusAreas: usersTable.focusAreas,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) throw new Error(`synthesize: user ${userId} not found`);

  const userName = user.name ?? user.email.split("@")[0];
  const reader = toReaderProfile(user);
  const metrics = await runForUser(
    db,
    user.id,
    userName,
    reader,
    cutoff,
    now,
    dayStart,
    maxItems,
    maxPerCompetitor,
  );
  logger.info({ ...metrics, email: user.email }, "synthesize: on-demand user run complete");
  return metrics;
}

export async function runSynthesis(options: SynthesisOptions = {}): Promise<SynthesisMetrics> {
  const started = Date.now();
  const db = getDb();
  const now = options.now ?? new Date();
  const dayStart = startOfUtcDay(now);

  // Weekend skip — the cron path passes skipWeekends=true so Saturday and
  // Sunday produce no digests. Synthesize cost stays zero, and the per-TZ
  // send dispatcher's weekend filter would have suppressed delivery anyway.
  if (options.skipWeekends) {
    const utcDay = now.getUTCDay(); // 0=Sun, 6=Sat
    if (utcDay === 0 || utcDay === 6) {
      logger.info(
        { utcDay, now: now.toISOString() },
        "synthesize: weekend — skipping run (use skipWeekends:false to override)",
      );
      return {
        users: 0,
        durationMs: Date.now() - started,
        totalCandidates: 0,
        totalSynthesized: 0,
        emptyDigests: 0,
        erroredUsers: 0,
        perUser: [],
      };
    }
  }

  // Monday's lookback widens to 72h to fold in Fri/Sat/Sun ingestion. Only
  // applied when the caller did not override `lookbackHours` and opted into
  // weekend-aware defaults (cron path). Tue–Fri stay on the 24h daily window.
  const defaultLookback =
    options.useWeekendAwareDefaults && now.getUTCDay() === 1
      ? MONDAY_LOOKBACK_HOURS
      : LOOKBACK_HOURS;
  const lookbackHours = options.lookbackHours ?? defaultLookback;
  const maxItems = options.maxItemsPerDigest ?? MAX_ITEMS_PER_DIGEST;
  const maxPerCompetitor = options.maxItemsPerCompetitor ?? MAX_ITEMS_PER_COMPETITOR;
  const cutoff = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);

  const activeUsers = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      position: usersTable.position,
      companyName: usersTable.companyName,
      ultimateGoal: usersTable.ultimateGoal,
      focusAreas: usersTable.focusAreas,
    })
    .from(usersTable)
    .where(eq(usersTable.status, "active"));

  logger.info(
    {
      users: activeUsers.length,
      lookbackHours,
      cutoff: cutoff.toISOString(),
      dayStart: dayStart.toISOString(),
    },
    "synthesize: starting run",
  );

  const perUser: UserSynthesisMetrics[] = [];

  for (const user of activeUsers) {
    try {
      // `users.name` is nullable post-Better-Auth (#26) — the magic-link
      // signup may create a row before the FTE agent fills it in. Fall
      // back to the email local-part so the greeting is never empty.
      const userName = user.name ?? user.email.split("@")[0];
      const reader = toReaderProfile(user);
      const metrics = await runForUser(
        db,
        user.id,
        userName,
        reader,
        cutoff,
        now,
        dayStart,
        maxItems,
        maxPerCompetitor,
      );
      perUser.push(metrics);
      logger.info({ ...metrics, email: user.email }, "synthesize: user complete");
    } catch (err) {
      logger.error(
        { err, userId: user.id, email: user.email },
        "synthesize: user failed — skipping, will retry on next run",
      );
      perUser.push({
        userId: user.id,
        candidates: 0,
        synthesized: 0,
        empty: false,
        errored: true,
      });
    }
  }

  const aggregate: SynthesisMetrics = {
    users: activeUsers.length,
    durationMs: Date.now() - started,
    totalCandidates: sum(perUser, (m) => m.candidates),
    totalSynthesized: sum(perUser, (m) => m.synthesized),
    emptyDigests: perUser.filter((m) => m.empty).length,
    erroredUsers: perUser.filter((m) => m.errored).length,
    perUser,
  };

  logger.info(aggregate, "synthesize: run complete");
  emitPosthog(aggregate);
  return aggregate;
}

async function runForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  userName: string,
  reader: ReaderProfile | null,
  cutoff: Date,
  now: Date,
  dayStart: Date,
  maxItems: number,
  maxPerCompetitor: number,
): Promise<UserSynthesisMetrics> {
  const pool = await db
    .select({
      rawItemId: rawItems.id,
      competitorName: competitorsTable.name,
      source: rawItems.source,
      url: rawItems.url,
      title: rawItems.title,
      body: rawItems.body,
      publishedAt: rawItems.publishedAt,
      category: itemScores.category,
      score: itemScores.score,
      why: itemScores.why,
    })
    .from(itemScores)
    .innerJoin(rawItems, eq(rawItems.id, itemScores.rawItemId))
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(
      and(
        eq(itemScores.userId, userId),
        ne(itemScores.category, "noise"),
        gte(rawItems.ingestedAt, cutoff),
      ),
    )
    .orderBy(desc(itemScores.score));

  if (pool.length > POOL_WARN_THRESHOLD) {
    logger.warn(
      { userId, poolSize: pool.length },
      "synthesize: large candidate pool — investigate classifier noise filter",
    );
  }

  if (pool.length === 0) {
    await upsertDigest(db, userId, dayStart, cutoff, now, []);
    return { userId, candidates: 0, synthesized: 0, empty: true, errored: false };
  }

  const candidates = selectDiverseCandidates(pool, maxItems, maxPerCompetitor);

  const synthesisInput: SynthesisInputItem[] = candidates.map((c) => ({
    rawItemId: c.rawItemId,
    competitorName: c.competitorName,
    source: c.source,
    url: c.url,
    title: c.title,
    body: c.body,
    publishedAt: c.publishedAt,
    category: c.category as SynthesisInputItem["category"],
    score: c.score,
    why: c.why,
  }));

  const { items: synthesized, usage: synthesisUsage } = await synthesizeDigest({
    userName,
    reader,
    items: synthesisInput,
  });

  if (synthesized.length === 0) {
    // Sonnet returned an empty array despite non-empty input — treat as
    // synthesis failure and persist empty digest so send job stays unblocked.
    // Still attach cost to the empty digest row so the spend isn't lost.
    logger.warn(
      { userId, candidates: candidates.length },
      "synthesize: empty output for non-empty input",
    );
    const digestId = await upsertDigest(db, userId, dayStart, cutoff, now, []);
    await recordSynthesisUsage(userId, digestId, synthesisUsage);
    return { userId, candidates: candidates.length, synthesized: 0, empty: true, errored: true };
  }

  const byId = new Map(candidates.map((c) => [c.rawItemId, c]));
  const itemRows = synthesized
    .map((s) => buildDigestItemRow(userId, s, byId))
    .filter((row): row is Omit<NewDigestItem, "digestId"> => row !== null);

  const digestId = await upsertDigest(db, userId, dayStart, cutoff, now, itemRows);
  await recordSynthesisUsage(userId, digestId, synthesisUsage);

  return {
    userId,
    candidates: candidates.length,
    synthesized: itemRows.length,
    empty: false,
    errored: false,
  };
}

async function recordSynthesisUsage(
  userId: string,
  digestId: string,
  usage: SynthesisUsage | null,
): Promise<void> {
  if (!usage) return;
  await recordLlmUsage(
    {
      kind: "synthesize",
      model: usage.model,
      userId,
      digestId,
    },
    {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      server_tool_use: { web_search_requests: usage.webSearchRequests },
    },
  );
}

export function buildDigestItemRow(
  userId: string,
  s: SynthesizedItem,
  byId: Map<string, { category: string; score: number; publishedAt: Date | null }>,
): Omit<NewDigestItem, "digestId"> | null {
  const meta = byId.get(s.rawItemId);
  if (!meta) {
    logger.warn(
      { rawItemId: s.rawItemId },
      "synthesize: synthesized item references unknown rawItemId — dropping",
    );
    return null;
  }
  return {
    userId,
    rawItemId: s.rawItemId,
    category: meta.category as NewDigestItem["category"],
    headline: s.headline,
    snippet: s.snippet,
    impactNote: s.impactNote,
    score: meta.score,
    // Snapshot the source's publication time at synthesis time. Nullable
    // when the source has no date — frontend renders nothing rather than a
    // fabricated "recently" (#41).
    occurredAt: meta.publishedAt,
  };
}

async function upsertDigest(
  db: ReturnType<typeof getDb>,
  userId: string,
  dayStart: Date,
  periodStart: Date,
  periodEnd: Date,
  itemRows: Array<Omit<NewDigestItem, "digestId">>,
): Promise<string> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.userId, userId), gte(digests.createdAt, dayStart)))
      .limit(1);

    let digestId: string;
    if (existing.length > 0) {
      digestId = existing[0].id;
      await tx.delete(digestItems).where(eq(digestItems.digestId, digestId));
      await tx
        .update(digests)
        .set({ itemCount: itemRows.length, periodStart, periodEnd })
        .where(eq(digests.id, digestId));
    } else {
      const inserted = await tx
        .insert(digests)
        .values({ userId, itemCount: itemRows.length, periodStart, periodEnd })
        .returning({ id: digests.id });
      digestId = inserted[0].id;
    }

    if (itemRows.length > 0) {
      await tx.insert(digestItems).values(itemRows.map((row) => ({ ...row, digestId })));
    }

    return digestId;
  });
}

// Two-pass selection: first pass enforces `maxPerCompetitor` so a single
// high-volume source can't monopolize the digest. Second pass fills any
// remaining slots from the leftover pool (still ordered by score) — protects
// the small-N case where the user genuinely only has news from one or two
// competitors and we'd rather show 5 items from that competitor than ship a
// near-empty digest.
//
// The cap is a parameter (not the module constant) so fast-path can loosen it
// for the 10-item catch-up — at 5 items + cap=2 every digest gets ≥3
// competitors when the pool has them; at 10 items the same cap-2 gives a
// flat 60% concentration on the highest-volume competitor (caps fill, then
// the relaxed second pass falls back to top-score = all leader). Cap=3 at
// 10 items lands closer to a 50/30/20 split.
export function selectDiverseCandidates<T extends { rawItemId: string; competitorName: string }>(
  pool: T[],
  maxItems: number,
  maxPerCompetitor: number,
): T[] {
  const selected: T[] = [];
  const used = new Set<string>();
  const perCompetitor = new Map<string, number>();

  for (const item of pool) {
    if (selected.length >= maxItems) break;
    const count = perCompetitor.get(item.competitorName) ?? 0;
    if (count >= maxPerCompetitor) continue;
    selected.push(item);
    used.add(item.rawItemId);
    perCompetitor.set(item.competitorName, count + 1);
  }

  if (selected.length < maxItems) {
    for (const item of pool) {
      if (selected.length >= maxItems) break;
      if (used.has(item.rawItemId)) continue;
      selected.push(item);
      used.add(item.rawItemId);
    }
  }

  return selected;
}

function toReaderProfile(user: {
  position: string | null;
  companyName: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
}): ReaderProfile | null {
  if (!user.position && !user.ultimateGoal && (user.focusAreas ?? []).length === 0) {
    return null;
  }
  return {
    position: user.position,
    companyName: user.companyName,
    ultimateGoal: user.ultimateGoal,
    focusAreas: user.focusAreas,
  };
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function sum<T>(arr: T[], pick: (t: T) => number): number {
  return arr.reduce((acc, x) => acc + pick(x), 0);
}

function emitPosthog(m: SynthesisMetrics): void {
  captureServerEvent("worker", "synthesize_run", {
    users: m.users,
    duration_ms: m.durationMs,
    total_candidates: m.totalCandidates,
    total_synthesized: m.totalSynthesized,
    empty_digests: m.emptyDigests,
    errored_users: m.erroredUsers,
  });
}
