import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  competitors,
  digestItems,
  digests,
  feedback,
  itemScores,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";
import type { SynthesisInput, SynthesisResult } from "~/features/digest/server/synthesize";

// Toggle the feedback-signal env flag per-test so loadDislikedExamples
// returns the right thing without mocking the env module. Mutating
// process.env directly works because env.ts re-reads from process.env at
// parse time only — but env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED is captured
// once at module load. We mock the env module here so the toggle is live.
const envMock = vi.hoisted(() => ({
  env: {
    SYNTHESIS_FEEDBACK_SIGNAL_ENABLED: false,
  } as { SYNTHESIS_FEEDBACK_SIGNAL_ENABLED: boolean },
}));
vi.mock("~/shared/server/env", () => ({
  env: new Proxy(envMock.env, {
    get(target, prop) {
      return Reflect.get(target, prop);
    },
  }),
  requireEnv: (_k: string) => {
    throw new Error("requireEnv not stubbed in this test");
  },
}));

// Stub Sonnet — echo back one synthesized item per input rawItemId so
// the job's plumbing (write digest + write digest_items + record llm_usage)
// is exercised end-to-end, while a real Anthropic call would cost money
// and add a network dep to CI.
const synthMock = vi.hoisted(() => ({
  synthesize: vi.fn<(input: SynthesisInput) => Promise<SynthesisResult>>(),
}));
vi.mock("~/features/digest/server/synthesize", async (importOriginal) => {
  const orig = await importOriginal<typeof import("~/features/digest/server/synthesize")>();
  return {
    ...orig,
    synthesizeDigest: (input: SynthesisInput) => synthMock.synthesize(input),
  };
});

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({ captureServerEvent: vi.fn() }));

const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
  pool: null as unknown as TestDb["pool"],
}));
vi.mock("~/shared/server/db", () => ({
  getDb: () => dbHolder.db,
  getPool: () => dbHolder.pool,
}));

const { runSynthesisForUser, loadDislikedExamples: _loadDislikedExamples } =
  await import("~/features/digest/server/jobs/synthesize");
// loadDislikedExamples is typed against `ReturnType<typeof getDb>` (the
// production getter), but the test harness builds its drizzle handle
// directly via `drizzle(pool)` in setup.ts and types it as the bare
// NodePgDatabase. The two are structurally compatible — the `$client`
// drift is a typedef-only quirk — so cast at the boundary and move on.
const loadDislikedExamples = _loadDislikedExamples as unknown as (
  db: TestDb["db"],
  userId: string,
  now: Date,
) => Promise<Awaited<ReturnType<typeof _loadDislikedExamples>>>;

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
  dbHolder.db = h.db;
  dbHolder.pool = h.pool;
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await truncateAll(h.pool);
  envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = false;
  synthMock.synthesize.mockReset();
  // Default: echo back one synthesized item per input. Tests that need
  // empty-output or error paths override per-test.
  synthMock.synthesize.mockImplementation(async (input) => ({
    items: input.items.map((i) => ({
      rawItemId: i.rawItemId,
      headline: `H: ${i.title}`,
      snippet: "short snippet",
      impactNote: "impact note",
    })),
    usage: {
      model: "claude-sonnet-4-6",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedFullChain(emailSuffix: string, items: Array<{ score: number; title: string }>) {
  const [user] = await h.db
    .insert(users)
    .values({ email: `${emailSuffix}@test.local`, name: emailSuffix, tz: "UTC" })
    .returning();
  const [comp] = await h.db
    .insert(competitors)
    .values({ name: `Acme-${emailSuffix}`, homepageUrl: `https://acme-${emailSuffix}.test` })
    .returning();
  await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const [raw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: `${emailSuffix}-${i}`,
        url: `https://acme.test/${i}`,
        title: it.title,
        body: "body",
        publishedAt: new Date("2026-05-17T00:00:00Z"),
      })
      .returning();
    await h.db.insert(itemScores).values({
      userId: user!.id,
      rawItemId: raw!.id,
      category: "launch",
      score: it.score,
      why: "because",
    });
  }
  return { userId: user!.id, competitorId: comp!.id };
}

describe("runSynthesisForUser — F-003 happy path", () => {
  test("non-empty pool → digest row + digest_items rows + llm_usage row", async () => {
    const { userId } = await seedFullChain("alpha", [
      { score: 90, title: "Pricing change" },
      { score: 80, title: "New feature" },
    ]);

    const metrics = await runSynthesisForUser(userId, { now: new Date("2026-05-17T10:00:00Z") });

    expect(metrics).toMatchObject({ userId, candidates: 2, synthesized: 2, empty: false });

    const digestRows = await h.db.select().from(digests).where(eq(digests.userId, userId));
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]!.itemCount).toBe(2);
    expect(digestRows[0]!.periodStart).not.toBeNull();
    expect(digestRows[0]!.periodEnd).not.toBeNull();

    const items = await h.db.select().from(digestItems).where(eq(digestItems.userId, userId));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.digestId === digestRows[0]!.id)).toBe(true);
    expect(items.map((i) => i.headline).sort()).toEqual(["H: New feature", "H: Pricing change"]);
  });

  test("empty candidate pool → digest row with item_count=0 (SCOPE.md §9 empty policy)", async () => {
    // User exists but has no item_scores → pool is empty. Job must still
    // persist a digest row so the send job can render the "nothing
    // notable today" template instead of going silent.
    const [user] = await h.db
      .insert(users)
      .values({ email: "empty@test.local", name: "Empty", tz: "UTC" })
      .returning();

    const metrics = await runSynthesisForUser(user!.id, { now: new Date("2026-05-17T10:00:00Z") });

    expect(metrics).toMatchObject({ candidates: 0, synthesized: 0, empty: true });

    const digestRows = await h.db.select().from(digests).where(eq(digests.userId, user!.id));
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]!.itemCount).toBe(0);

    const items = await h.db.select().from(digestItems).where(eq(digestItems.userId, user!.id));
    expect(items).toHaveLength(0);

    // Sonnet was never called — saved a real $0.02 hit.
    expect(synthMock.synthesize).not.toHaveBeenCalled();
  });

  test("re-running on the same UTC day overwrites items (idempotency)", async () => {
    const { userId } = await seedFullChain("idem", [{ score: 80, title: "First" }]);
    const now = new Date("2026-05-17T10:00:00Z");

    await runSynthesisForUser(userId, { now });
    const firstItems = await h.db.select().from(digestItems).where(eq(digestItems.userId, userId));
    const firstDigest = (await h.db.select().from(digests).where(eq(digests.userId, userId)))[0]!;

    // Re-run — same day, same items. The job should delete the old
    // digest_items and replace, keeping the same digest row.
    await runSynthesisForUser(userId, { now: new Date("2026-05-17T11:00:00Z") });

    const digestRows = await h.db.select().from(digests).where(eq(digests.userId, userId));
    expect(digestRows).toHaveLength(1);
    expect(digestRows[0]!.id).toBe(firstDigest.id); // same digest row

    const secondItems = await h.db.select().from(digestItems).where(eq(digestItems.userId, userId));
    expect(secondItems).toHaveLength(1);
    // New ids → rows were replaced, not appended.
    expect(secondItems[0]!.id).not.toBe(firstItems[0]!.id);
  });
});

describe("runSynthesisForUser — PF-90 maxPublishedAgeDays cap", () => {
  // Seed two raw items + scores for one user: one published yesterday,
  // one published 18 months ago. Both ingested today. Mirrors the
  // first-ingest shape of an archive-heavy RSS feed.
  async function seedRecentAndStale(emailSuffix: string, now: Date) {
    const [user] = await h.db
      .insert(users)
      .values({ email: `${emailSuffix}@test.local`, name: emailSuffix, tz: "UTC" })
      .returning();
    const [comp] = await h.db
      .insert(competitors)
      .values({ name: `Acme-${emailSuffix}`, homepageUrl: `https://${emailSuffix}.test` })
      .returning();
    await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });

    const recent = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day old
    const stale = new Date(now.getTime() - 540 * 24 * 60 * 60 * 1000); // 540 days old

    const [recentRaw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: `${emailSuffix}-recent`,
        url: `https://${emailSuffix}.test/recent`,
        title: "Recent launch",
        body: "body",
        publishedAt: recent,
        // ingestedAt defaults to now() — both items look freshly-ingested.
      })
      .returning();
    const [staleRaw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: `${emailSuffix}-stale`,
        url: `https://${emailSuffix}.test/stale`,
        title: "Ancient archive item",
        body: "body",
        publishedAt: stale,
      })
      .returning();
    await h.db.insert(itemScores).values([
      {
        userId: user!.id,
        rawItemId: recentRaw!.id,
        category: "launch",
        score: 80,
        why: "fresh",
      },
      {
        userId: user!.id,
        rawItemId: staleRaw!.id,
        category: "launch",
        score: 95, // higher score — would dominate without the cap
        why: "old",
      },
    ]);
    return { userId: user!.id };
  }

  test("with maxPublishedAgeDays=90: items older than 90d are excluded from the pool", async () => {
    const now = new Date("2026-05-17T10:00:00Z");
    const { userId } = await seedRecentAndStale("capped", now);

    const metrics = await runSynthesisForUser(userId, { now, maxPublishedAgeDays: 90 });

    // Only the recent item survives — even though the stale one out-scores it.
    expect(metrics).toMatchObject({ userId, candidates: 1, synthesized: 1, empty: false });

    const items = await h.db.select().from(digestItems).where(eq(digestItems.userId, userId));
    expect(items).toHaveLength(1);
    expect(items[0]!.headline).toBe("H: Recent launch");

    // The synthesizer was called with one item only — no stale title leaked
    // into the Sonnet prompt either.
    const calledInput = synthMock.synthesize.mock.calls[0]![0];
    expect(calledInput.items).toHaveLength(1);
    expect(calledInput.items[0]!.title).toBe("Recent launch");
  });

  test("without the cap: both items reach the digest (regression guard for daily cron)", async () => {
    // The daily cron path doesn't pass maxPublishedAgeDays — preserves the
    // pre-PF-90 behavior. Items still flow through as before.
    const now = new Date("2026-05-17T10:00:00Z");
    const { userId } = await seedRecentAndStale("uncapped", now);

    const metrics = await runSynthesisForUser(userId, { now });

    expect(metrics).toMatchObject({ candidates: 2, synthesized: 2, empty: false });
    const items = await h.db.select().from(digestItems).where(eq(digestItems.userId, userId));
    expect(items).toHaveLength(2);
  });

  test("publishedAt=null is kept even when the cap is set (adapter contract is loose)", async () => {
    // Policy: adapters SHOULD populate published_at, but a missing date
    // is not grounds to silently drop the item. The outer ingested_at
    // window already bounds it. RSS is the only adapter that could
    // realistically return null today (and 0% do in dev).
    const now = new Date("2026-05-17T10:00:00Z");
    const [user] = await h.db
      .insert(users)
      .values({ email: "nulldate@test.local", name: "n", tz: "UTC" })
      .returning();
    const [comp] = await h.db
      .insert(competitors)
      .values({ name: "Acme-null", homepageUrl: "https://null.test" })
      .returning();
    await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });
    const [raw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: "no-date",
        url: "https://null.test/x",
        title: "Undated item",
        body: "body",
        publishedAt: null,
      })
      .returning();
    await h.db.insert(itemScores).values({
      userId: user!.id,
      rawItemId: raw!.id,
      category: "launch",
      score: 80,
      why: "fresh",
    });

    const metrics = await runSynthesisForUser(user!.id, { now, maxPublishedAgeDays: 90 });

    expect(metrics).toMatchObject({ candidates: 1, synthesized: 1, empty: false });
  });
});

describe("runSynthesis cron — PF-90 daily published_at cap", () => {
  // The cron path (`useWeekendAwareDefaults: true`) defaults
  // maxPublishedAgeDays to 1 (Mon: 3). Tue–Fri = 1d, so an item with
  // published_at = 2 days ago should be filtered out even though
  // ingested_at = now passes the 24h ingested window. Defense against a
  // future source that backfills with old published_at values (the
  // PF-90 mechanism, applied to daily not just first-ingest).
  test("Tue–Fri daily cron drops items whose published_at is >24h old", async () => {
    const now = new Date("2026-05-19T05:30:00Z"); // Tuesday
    const recent = new Date(now.getTime() - 6 * 60 * 60 * 1000); // 6h ago
    const stale = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago

    const [user] = await h.db
      .insert(users)
      .values({
        email: "tue@test.local",
        name: "Tue",
        tz: "UTC",
        status: "active",
      })
      .returning();
    const [comp] = await h.db
      .insert(competitors)
      .values({ name: "Acme-tue", homepageUrl: "https://acme-tue.test" })
      .returning();
    await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });
    const [recentRaw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: "tue-recent",
        url: "https://acme-tue.test/recent",
        title: "Recent",
        body: "body",
        publishedAt: recent,
      })
      .returning();
    const [staleRaw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: "tue-stale",
        url: "https://acme-tue.test/stale",
        title: "Backfilled stale",
        body: "body",
        publishedAt: stale,
      })
      .returning();
    await h.db.insert(itemScores).values([
      { userId: user!.id, rawItemId: recentRaw!.id, category: "launch", score: 80, why: "r" },
      { userId: user!.id, rawItemId: staleRaw!.id, category: "launch", score: 95, why: "s" },
    ]);

    const { runSynthesis } = await import("~/features/digest/server/jobs/synthesize");
    await runSynthesis({ now, useWeekendAwareDefaults: true });

    const items = await h.db.select().from(digestItems).where(eq(digestItems.userId, user!.id));
    // Only the recent one — stale (48h old published_at) is dropped
    // by the daily cap even though it out-scores recent.
    expect(items).toHaveLength(1);
    expect(items[0]!.headline).toBe("H: Recent");
  });
});

describe("runSynthesisForUser — F-009 tenant isolation", () => {
  test("running for user A leaves user B untouched", async () => {
    const a = await seedFullChain("alpha", [{ score: 90, title: "A item 1" }]);
    const b = await seedFullChain("bravo", [
      { score: 85, title: "B item 1" },
      { score: 70, title: "B item 2" },
    ]);

    const now = new Date("2026-05-17T10:00:00Z");
    await runSynthesisForUser(a.userId, { now });

    // A got a digest + 1 item.
    const aDigests = await h.db.select().from(digests).where(eq(digests.userId, a.userId));
    expect(aDigests).toHaveLength(1);
    const aItems = await h.db.select().from(digestItems).where(eq(digestItems.userId, a.userId));
    expect(aItems).toHaveLength(1);

    // B was NEVER processed.
    const bDigests = await h.db.select().from(digests).where(eq(digests.userId, b.userId));
    expect(bDigests).toHaveLength(0);
    const bItems = await h.db.select().from(digestItems).where(eq(digestItems.userId, b.userId));
    expect(bItems).toHaveLength(0);

    // Sonnet was called once, and that call's input never contained any
    // of B's rawItemIds — defense-in-depth on the prompt boundary.
    expect(synthMock.synthesize).toHaveBeenCalledOnce();
    const calledInput = synthMock.synthesize.mock.calls[0]![0];
    const bRaws = await h.db
      .select({ id: rawItems.id })
      .from(rawItems)
      .innerJoin(
        itemScores,
        and(eq(itemScores.rawItemId, rawItems.id), eq(itemScores.userId, b.userId)),
      );
    const bRawIds = new Set(bRaws.map((r) => r.id));
    for (const item of calledInput.items) {
      expect(bRawIds.has(item.rawItemId)).toBe(false);
    }
  });

  test("A's noise-classified items do NOT leak into B's digest", async () => {
    // Edge case for the WHERE: itemScores.category != 'noise' filters per
    // user, not globally. Bug shape: a missed userId clause + a missed
    // noise filter would let A's noise-classified items show up in B's
    // digest if their rawItemId happened to collide. Pin the isolation.
    const [userA] = await h.db
      .insert(users)
      .values({ email: "a@test.local", name: "A", tz: "UTC" })
      .returning();
    const [userB] = await h.db
      .insert(users)
      .values({ email: "b@test.local", name: "B", tz: "UTC" })
      .returning();
    const [comp] = await h.db
      .insert(competitors)
      .values({ name: "Shared", homepageUrl: "https://shared.test" })
      .returning();
    const [raw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: "shared-1",
        url: "https://shared.test/1",
        title: "shared",
        body: "body",
        publishedAt: new Date("2026-05-17T00:00:00Z"),
      })
      .returning();
    // A says noise (will NOT surface in their pool). B says launch+80 (will).
    await h.db.insert(itemScores).values({
      userId: userA!.id,
      rawItemId: raw!.id,
      category: "noise",
      score: 5,
      why: "recap",
    });
    await h.db.insert(itemScores).values({
      userId: userB!.id,
      rawItemId: raw!.id,
      category: "launch",
      score: 80,
      why: "big",
    });

    await runSynthesisForUser(userA!.id, { now: new Date("2026-05-17T10:00:00Z") });

    const aItems = await h.db.select().from(digestItems).where(eq(digestItems.userId, userA!.id));
    expect(aItems).toHaveLength(0); // A's only item was noise → not synthesized

    // B was not processed in this run; their own score row is untouched.
    const bScores = await h.db.select().from(itemScores).where(eq(itemScores.userId, userB!.id));
    expect(bScores).toHaveLength(1);
    expect(bScores[0]!.score).toBe(80);
  });
});

describe("loadDislikedExamples — PF-63 feedback signal", () => {
  // Helper: spin up a user with one synthesized digest item the user has
  // rated. `rating` controls 👍/👎 and `comment` simulates the optional
  // "why?" follow-up. Returns the user's id so the caller can run more
  // assertions.
  async function seedRatedItem(opts: {
    emailSuffix: string;
    rating: "up" | "down";
    comment?: string;
    headline?: string;
    competitorName?: string;
    createdAt?: Date;
  }): Promise<{ userId: string; digestItemId: string }> {
    const [user] = await h.db
      .insert(users)
      .values({
        email: `${opts.emailSuffix}@test.local`,
        name: opts.emailSuffix,
        tz: "UTC",
      })
      .returning();
    const [comp] = await h.db
      .insert(competitors)
      .values({
        name: opts.competitorName ?? "Lattice",
        homepageUrl: `https://${opts.emailSuffix}-comp.test`,
      })
      .returning();
    const [raw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: `${opts.emailSuffix}-raw`,
        url: `https://${opts.emailSuffix}.test/1`,
        title: "raw title",
        body: "body",
        publishedAt: new Date("2026-05-01T00:00:00Z"),
      })
      .returning();
    const [digest] = await h.db
      .insert(digests)
      .values({
        userId: user!.id,
        itemCount: 1,
        periodStart: new Date("2026-05-01T00:00:00Z"),
        periodEnd: new Date("2026-05-02T00:00:00Z"),
      })
      .returning();
    const [item] = await h.db
      .insert(digestItems)
      .values({
        digestId: digest!.id,
        userId: user!.id,
        rawItemId: raw!.id,
        category: "launch",
        headline: opts.headline ?? "Lattice shipped X",
        snippet: "Snippet for the rated item.",
        impactNote: "Impact note for the rated item.",
        score: 70,
      })
      .returning();
    await h.db.insert(feedback).values({
      userId: user!.id,
      digestItemId: item!.id,
      rating: opts.rating,
      comment: opts.comment ?? null,
      commentedAt: opts.comment ? new Date() : null,
      createdAt: opts.createdAt ?? new Date(),
    });
    return { userId: user!.id, digestItemId: item!.id };
  }

  test("env flag off → returns null even with plenty of feedback", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = false;
    const { userId } = await seedRatedItem({ emailSuffix: "flagoff", rating: "down" });
    // Add 3 more ratings so cold-start would otherwise pass.
    for (let i = 0; i < 3; i++) {
      const { digestItemId } = await seedRatedItem({
        emailSuffix: `flagoff-${i}`,
        rating: "down",
      });
      // Re-attach to the same user via the unique constraint workaround:
      // just insert a new feedback row pointing to the new digestItemId
      // for the same user.
      await h.db.insert(feedback).values({
        userId,
        digestItemId,
        rating: "down",
        createdAt: new Date(),
      });
    }
    const result = await loadDislikedExamples(h.db, userId, new Date("2026-05-18T00:00:00Z"));
    expect(result).toBeNull();
  });

  test("cold-start (<3 ratings) → returns null even with a recent 👎", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = true;
    const { userId } = await seedRatedItem({ emailSuffix: "coldstart", rating: "down" });
    // Only 1 rating total → below the 3-rating cold-start threshold.
    const result = await loadDislikedExamples(h.db, userId, new Date("2026-05-18T00:00:00Z"));
    expect(result).toBeNull();
  });

  test("≥3 ratings + recent 👎 → returns the disliked items with competitor + headline + snippet + impact", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = true;
    // First rating creates the user. Two more pad to reach the threshold.
    const { userId } = await seedRatedItem({
      emailSuffix: "hot",
      rating: "down",
      headline: "Lattice shipped weekly check-ins",
      competitorName: "Lattice",
      comment: "this is just a recap, not a real launch",
      createdAt: new Date("2026-05-17T00:00:00Z"),
    });
    // Pad the rating count with a 👍 and another 👎 for the same user.
    for (const r of ["up", "down"] as const) {
      const { digestItemId } = await seedRatedItem({
        emailSuffix: `hot-${r}`,
        rating: r,
      });
      await h.db.insert(feedback).values({
        userId,
        digestItemId,
        rating: r,
        createdAt: new Date("2026-05-16T00:00:00Z"),
      });
    }

    const result = await loadDislikedExamples(h.db, userId, new Date("2026-05-18T00:00:00Z"));
    expect(result).not.toBeNull();
    // Two 👎 rows for this user — the original + the padding one.
    expect(result!.length).toBeGreaterThanOrEqual(1);
    // Most recent dislike first (2026-05-17).
    expect(result![0]!.competitorName).toBe("Lattice");
    expect(result![0]!.headline).toBe("Lattice shipped weekly check-ins");
    expect(result![0]!.comment).toBe("this is just a recap, not a real launch");
  });

  test("👎 outside the 30-day lookback window is excluded", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = true;
    const stale = new Date("2026-03-01T00:00:00Z"); // ~80 days before now
    const { userId } = await seedRatedItem({
      emailSuffix: "stale",
      rating: "down",
      createdAt: stale,
    });
    // Pad with 2 more recent 👎 to clear the cold-start gate but the stale
    // row should still be filtered out by the date window.
    for (let i = 0; i < 2; i++) {
      const { digestItemId } = await seedRatedItem({
        emailSuffix: `stale-pad-${i}`,
        rating: "down",
      });
      await h.db.insert(feedback).values({
        userId,
        digestItemId,
        rating: "down",
        createdAt: stale,
      });
    }
    const result = await loadDislikedExamples(h.db, userId, new Date("2026-05-18T00:00:00Z"));
    // All 👎 rows are stale → no examples returned, even though cold-start
    // gate counts them as ratings.
    expect(result).toBeNull();
  });

  test("👍 ratings are NOT included in examples (block is dislikes-only)", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = true;
    const { userId } = await seedRatedItem({
      emailSuffix: "thumbsup",
      rating: "up",
      headline: "Liked headline — must not appear",
    });
    // Two more 👍 to clear cold-start.
    for (let i = 0; i < 2; i++) {
      const { digestItemId } = await seedRatedItem({
        emailSuffix: `thumbsup-pad-${i}`,
        rating: "up",
      });
      await h.db.insert(feedback).values({
        userId,
        digestItemId,
        rating: "up",
        createdAt: new Date(),
      });
    }
    const result = await loadDislikedExamples(h.db, userId, new Date("2026-05-18T00:00:00Z"));
    // 3 👍 ratings, 0 👎 → cold-start clears but no dislikes to encode.
    expect(result).toBeNull();
  });

  test("end-to-end runSynthesisForUser passes dislikedExamples through to the synthesizer", async () => {
    envMock.env.SYNTHESIS_FEEDBACK_SIGNAL_ENABLED = true;
    // Seed a user with 3 dislikes that include comments.
    const { userId } = await seedRatedItem({
      emailSuffix: "e2e",
      rating: "down",
      comment: "recap, not a launch",
      headline: "Lattice shipped X",
    });
    for (let i = 0; i < 2; i++) {
      const { digestItemId } = await seedRatedItem({
        emailSuffix: `e2e-pad-${i}`,
        rating: "down",
      });
      await h.db.insert(feedback).values({
        userId,
        digestItemId,
        rating: "down",
        createdAt: new Date(),
      });
    }
    // Now seed a fresh raw item + score so the synthesis pool is non-empty.
    const [comp] = await h.db
      .insert(competitors)
      .values({ name: "Other", homepageUrl: "https://other.test" })
      .returning();
    const [raw] = await h.db
      .insert(rawItems)
      .values({
        competitorId: comp!.id,
        source: "rss",
        sourceId: "e2e-fresh",
        url: "https://other.test/fresh",
        title: "Fresh title",
        body: "Fresh body",
        publishedAt: new Date("2026-05-17T00:00:00Z"),
      })
      .returning();
    await h.db.insert(itemScores).values({
      userId,
      rawItemId: raw!.id,
      category: "launch",
      score: 90,
      why: "because",
    });

    await runSynthesisForUser(userId, { now: new Date("2026-05-17T10:00:00Z") });

    expect(synthMock.synthesize).toHaveBeenCalledOnce();
    const calledInput = synthMock.synthesize.mock.calls[0]![0];
    expect(calledInput.dislikedExamples).not.toBeNull();
    expect(calledInput.dislikedExamples!.length).toBeGreaterThanOrEqual(1);
    // At least one disliked example carries the original comment.
    expect(calledInput.dislikedExamples!.some((d) => d.comment === "recap, not a launch")).toBe(
      true,
    );
  });
});
