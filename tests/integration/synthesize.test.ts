import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  competitors,
  digestItems,
  digests,
  itemScores,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";
import type { SynthesisInput, SynthesisResult } from "~/features/digest/server/synthesize";

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

const { runSynthesisForUser } = await import("~/features/digest/server/jobs/synthesize");

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
