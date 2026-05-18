import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { competitors, rawItems, userCompetitors, users } from "~/db/schema";
import type { NormalizedItem } from "~/sources/types";
import { startTestDb, truncateAll, type TestDb } from "./setup";

// Source modules are mocked so the test focuses on the ingest job's
// orchestration: DB writes, fan-out aggregation, ON CONFLICT dedupe.
// Per-adapter HTTP parsing belongs in unit tests (scripts/test-source-*
// covers real-API validation manually, per CLAUDE.md).
const sourceMocks = vi.hoisted(() => ({
  rss: vi.fn(),
  ph: vi.fn(),
  firehose: vi.fn(),
  firecrawl: vi.fn(),
  loadSnaps: vi.fn(),
  saveSnap: vi.fn(),
}));

vi.mock("~/sources/rss", () => ({
  fetchRSSForCompetitors: sourceMocks.rss,
  fetchRSS: vi.fn(),
  autodetectRSSForHomepage: vi.fn(),
}));
vi.mock("~/sources/ph", () => ({
  fetchPHForCompetitors: sourceMocks.ph,
  fetchPH: vi.fn(),
}));
vi.mock("~/sources/firehose", () => ({
  fetchFirehoseForCompetitors: sourceMocks.firehose,
}));
vi.mock("~/sources/firecrawl", () => ({
  scrapePricingPagesForCompetitors: sourceMocks.firecrawl,
  scrapePricingPage: vi.fn(),
}));
vi.mock("~/sources/firecrawl-store", () => ({
  loadLatestPricingSnapshots: sourceMocks.loadSnaps,
  saveLatestPricingSnapshot: sourceMocks.saveSnap,
}));

// Logger + posthog short-circuited so test output stays clean and PostHog
// never tries to phone home.
vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({ captureServerEvent: vi.fn() }));

// Point production `getDb` / `getPool` at our test container — the ingest
// job calls these at request time, not at module load, so a vi.hoisted
// holder we mutate in beforeAll works.
const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
  pool: null as unknown as TestDb["pool"],
}));
vi.mock("~/shared/server/db", () => ({
  getDb: () => dbHolder.db,
  getPool: () => dbHolder.pool,
}));

const { runIngestionForUser } = await import("~/jobs/ingest");

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
  sourceMocks.rss.mockReset();
  sourceMocks.ph.mockReset();
  sourceMocks.firehose.mockReset();
  sourceMocks.firecrawl.mockReset();
  sourceMocks.loadSnaps.mockReset();
  sourceMocks.saveSnap.mockReset();

  // Default: every adapter returns an empty Map (no items, no error). Per-
  // test overrides set richer responses below.
  sourceMocks.rss.mockResolvedValue(new Map());
  sourceMocks.ph.mockResolvedValue(new Map());
  sourceMocks.firehose.mockResolvedValue(new Map());
  sourceMocks.firecrawl.mockResolvedValue(new Map());
  sourceMocks.loadSnaps.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedUserWithCompetitor(): Promise<{ userId: string; competitorId: string }> {
  const [user] = await h.db
    .insert(users)
    .values({ email: `u-${Date.now()}-${Math.random()}@test.local`, name: "U", tz: "UTC" })
    .returning();
  const [comp] = await h.db
    .insert(competitors)
    .values({ name: "Acme", homepageUrl: "https://acme.test" })
    .returning();
  await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });
  return { userId: user!.id, competitorId: comp!.id };
}

function rssItem(sourceId: string): NormalizedItem {
  return {
    source: "rss",
    sourceId,
    url: `https://acme.test/${sourceId}`,
    title: `title-${sourceId}`,
    body: "body",
    publishedAt: new Date("2026-05-17T00:00:00Z"),
  };
}

describe("runIngestionForUser — F-003", () => {
  test("user with no competitors → 0 inserts, no source adapters called", async () => {
    const [user] = await h.db
      .insert(users)
      .values({ email: "lonely@test.local", name: "Lonely", tz: "UTC" })
      .returning();

    const metrics = await runIngestionForUser(user!.id);

    expect(metrics.competitors).toBe(0);
    expect(metrics.totalInserted).toBe(0);
    expect(sourceMocks.rss).not.toHaveBeenCalled();
    expect(await h.db.select().from(rawItems)).toEqual([]);
  });

  test("writes raw_items returned by RSS, tagged with the right competitorId + source", async () => {
    const { userId, competitorId } = await seedUserWithCompetitor();
    sourceMocks.rss.mockResolvedValueOnce(
      new Map([[competitorId, [rssItem("a-1"), rssItem("a-2")]]]),
    );

    const metrics = await runIngestionForUser(userId);

    expect(metrics.totalInserted).toBe(2);
    expect(metrics.perSource.rss).toEqual({ fetched: 2, inserted: 2, errored: false });

    const rows = await h.db.select().from(rawItems).orderBy(rawItems.sourceId);
    expect(rows.map((r) => ({ id: r.sourceId, c: r.competitorId, s: r.source }))).toEqual([
      { id: "a-1", c: competitorId, s: "rss" },
      { id: "a-2", c: competitorId, s: "rss" },
    ]);
  });

  test("re-running with the same source_ids inserts zero new rows (ON CONFLICT DO NOTHING)", async () => {
    const { userId, competitorId } = await seedUserWithCompetitor();
    sourceMocks.rss.mockResolvedValue(new Map([[competitorId, [rssItem("a-1"), rssItem("a-2")]]]));

    await runIngestionForUser(userId);
    const firstCount = (await h.db.select().from(rawItems)).length;
    expect(firstCount).toBe(2);

    const secondRun = await runIngestionForUser(userId);
    // perSource.inserted counts ACTUAL inserts (RETURNING rowcount), not
    // attempts — the dedupe is exactly what the job promises.
    expect(secondRun.perSource.rss.inserted).toBe(0);
    expect(secondRun.perSource.rss.fetched).toBe(2); // adapter still returned 2

    const secondCount = (await h.db.select().from(rawItems)).length;
    expect(secondCount).toBe(2); // total unchanged
  });

  test("one source rejecting still inserts from the others", async () => {
    const { userId, competitorId } = await seedUserWithCompetitor();
    sourceMocks.rss.mockResolvedValueOnce(new Map([[competitorId, [rssItem("rss-only")]]]));
    sourceMocks.ph.mockRejectedValueOnce(new Error("PH 5xx"));

    const metrics = await runIngestionForUser(userId);

    expect(metrics.perSource.rss).toEqual({ fetched: 1, inserted: 1, errored: false });
    expect(metrics.perSource.ph.errored).toBe(true);
    expect(metrics.totalInserted).toBe(1);
    const rows = await h.db.select().from(rawItems);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceId).toBe("rss-only");
  });

  test("two competitors → items land tagged to their respective competitor_id", async () => {
    const { userId, competitorId: c1 } = await seedUserWithCompetitor();
    const [c2] = await h.db
      .insert(competitors)
      .values({ name: "BambooHR", homepageUrl: "https://bamboohr.test" })
      .returning();
    await h.db.insert(userCompetitors).values({ userId, competitorId: c2!.id });

    sourceMocks.rss.mockResolvedValueOnce(
      new Map([
        [c1, [rssItem("a-1")]],
        [c2!.id, [rssItem("b-1")]],
      ]),
    );

    await runIngestionForUser(userId);

    const c1Rows = await h.db.select().from(rawItems).where(eq(rawItems.competitorId, c1));
    const c2Rows = await h.db.select().from(rawItems).where(eq(rawItems.competitorId, c2!.id));
    expect(c1Rows.map((r) => r.sourceId)).toEqual(["a-1"]);
    expect(c2Rows.map((r) => r.sourceId)).toEqual(["b-1"]);
  });
});
