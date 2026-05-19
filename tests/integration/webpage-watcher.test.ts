import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { competitors, competitorSources, rawItems, userCompetitors, users } from "~/db/schema";
import type { WebpageExtractionMode, WebpageFetchOptions } from "~/sources/webpage";
import { startTestDb, truncateAll, type TestDb } from "./setup";

// PF-97. We let the real webpage adapter run end-to-end (mode inference,
// snapshot_diff hashing, list_extract dedupe) but inject deterministic
// stand-ins for the three Haiku-backed extension points. Firecrawl is mocked
// via the adapter's `fetchImpl` hook so no network is touched.

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("~/shared/server/env", () => ({
  // FIRECRAWL_API_KEY is read by the adapter even when fetchImpl is mocked
  // (the Bearer header is built before dispatch). Stubbing requireEnv keeps
  // the test self-contained.
  requireEnv: vi.fn((name: string) => `mock-${name}`),
}));

const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
  pool: null as unknown as TestDb["pool"],
}));
vi.mock("~/shared/server/db", () => ({
  getDb: () => dbHolder.db,
  getPool: () => dbHolder.pool,
}));

const { runIngestionForUser } = await import("~/features/digest/server/jobs/ingest");

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
});

afterEach(() => {
  vi.clearAllMocks();
});

interface SeedResult {
  userId: string;
  competitorId: string;
  sourceId: string;
}

async function seedWebpageSource(opts: {
  url: string;
  extractionMode?: WebpageExtractionMode | null;
  lastContentHash?: string | null;
}): Promise<SeedResult> {
  const [user] = await h.db
    .insert(users)
    .values({ email: `u-${Date.now()}-${Math.random()}@test.local`, name: "U", tz: "UTC" })
    .returning();
  const [comp] = await h.db
    .insert(competitors)
    .values({ name: "Acme", homepageUrl: "https://acme.test" })
    .returning();
  await h.db.insert(userCompetitors).values({ userId: user!.id, competitorId: comp!.id });
  const [src] = await h.db
    .insert(competitorSources)
    .values({
      competitorId: comp!.id,
      sourceType: "webpage",
      extractionMode: opts.extractionMode ?? null,
      urlOrHandle: opts.url,
      status: "active",
      lastContentHash: opts.lastContentHash ?? null,
    })
    .returning();
  return { userId: user!.id, competitorId: comp!.id, sourceId: src!.id };
}

function firecrawlMockResponding(markdown: string): WebpageFetchOptions["fetchImpl"] {
  return async () =>
    new Response(JSON.stringify({ success: true, data: { markdown } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("webpage watcher integration (PF-97)", () => {
  test("first fetch with extraction_mode=NULL → Haiku infers mode and persists it", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/blog",
    });

    const fetchImpl = firecrawlMockResponding("# Blog\n\n- Post 1\n- Post 2\n");
    const inferModeImpl = vi.fn(async () => "list_extract" as const);
    const extractListImpl = vi.fn(async () => [
      { title: "Post 1", url: "/blog/post-1", publishedAt: "2026-05-15" },
      { title: "Post 2", url: "/blog/post-2", publishedAt: null },
    ]);

    const metrics = await runIngestionForUser(userId, {
      fetchImpl,
      inferModeImpl,
      extractListImpl,
    });

    expect(inferModeImpl).toHaveBeenCalledTimes(1);
    expect(extractListImpl).toHaveBeenCalledTimes(1);
    expect(metrics.perSource.webpage).toEqual({ fetched: 2, inserted: 2, errored: false });

    const [updatedSource] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, sourceId));
    expect(updatedSource!.extractionMode).toBe("list_extract");
    expect(updatedSource!.lastFetchedAt).not.toBeNull();
    expect(updatedSource!.lastContentHash).toBeNull();

    const items = await h.db.select().from(rawItems);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.source).toBe("webpage");
      expect(item.competitorSourceId).toBe(sourceId);
    }
    const urls = items.map((i) => i.url).sort();
    expect(urls).toEqual(["https://acme.test/blog/post-1", "https://acme.test/blog/post-2"]);
  });

  test("snapshot_diff first fetch (no baseline) → no item emitted, hash persisted", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/about",
      extractionMode: "snapshot_diff",
      lastContentHash: null,
    });

    const fetchImpl = firecrawlMockResponding("# About\nWe make great PDFs.");
    const inferModeImpl = vi.fn();
    const changeMeaningfulImpl = vi.fn();

    const metrics = await runIngestionForUser(userId, {
      fetchImpl,
      inferModeImpl,
      changeMeaningfulImpl,
    });

    // Mode is already set; inference must NOT run.
    expect(inferModeImpl).not.toHaveBeenCalled();
    // No baseline → no comparison → no Haiku judge call.
    expect(changeMeaningfulImpl).not.toHaveBeenCalled();
    expect(metrics.perSource.webpage.fetched).toBe(0);

    const [updatedSource] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, sourceId));
    expect(updatedSource!.lastContentHash).not.toBeNull();
    expect(updatedSource!.lastFetchedAt).not.toBeNull();
    expect(await h.db.select().from(rawItems)).toEqual([]);
  });

  test("snapshot_diff hash unchanged → cost gate skips Haiku call and emits no item", async () => {
    const sameContent = "# About\nStatic page that never changes.";
    // We need to compute the hash the adapter would compute. Easiest path:
    // run the watcher once to establish baseline, then run again.
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/about",
      extractionMode: "snapshot_diff",
    });

    const fetchImpl = firecrawlMockResponding(sameContent);
    const changeMeaningfulImpl = vi.fn();

    await runIngestionForUser(userId, { fetchImpl, changeMeaningfulImpl });
    // After first run the hash is set; run again with identical content.
    await runIngestionForUser(userId, { fetchImpl, changeMeaningfulImpl });

    expect(changeMeaningfulImpl).not.toHaveBeenCalled();
    expect(await h.db.select().from(rawItems)).toEqual([]);

    const [updatedSource] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, sourceId));
    expect(updatedSource!.lastContentHash).not.toBeNull();
  });

  test("snapshot_diff hash changed + judge says meaningful → emits one webpage item", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/pricing",
      extractionMode: "snapshot_diff",
      lastContentHash: "STALE-HASH-BASELINE",
    });

    const fetchImpl = firecrawlMockResponding(
      "# Pricing\n\n- Free: 5 PDFs/month\n- Pro: $19/mo, 500 PDFs",
    );
    const changeMeaningfulImpl = vi.fn(async () => true);

    const metrics = await runIngestionForUser(userId, { fetchImpl, changeMeaningfulImpl });

    expect(changeMeaningfulImpl).toHaveBeenCalledTimes(1);
    expect(metrics.perSource.webpage).toEqual({ fetched: 1, inserted: 1, errored: false });

    const items = await h.db.select().from(rawItems);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe("webpage");
    expect(items[0]!.competitorSourceId).toBe(sourceId);
    expect(items[0]!.title).toMatch(/Page updated/);
    expect(items[0]!.body).toContain("Pricing"); // diff body carries new content
  });

  test("snapshot_diff hash changed but judge says NOT meaningful → no item, hash still updated", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/about",
      extractionMode: "snapshot_diff",
      lastContentHash: "STALE-HASH",
    });

    const fetchImpl = firecrawlMockResponding("# About\nSlightly different copy.");
    const changeMeaningfulImpl = vi.fn(async () => false);

    const metrics = await runIngestionForUser(userId, { fetchImpl, changeMeaningfulImpl });

    expect(changeMeaningfulImpl).toHaveBeenCalledTimes(1);
    expect(metrics.perSource.webpage.fetched).toBe(0);
    expect(await h.db.select().from(rawItems)).toEqual([]);

    const [updatedSource] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, sourceId));
    // Hash still rolls forward so we don't ask Haiku again next cycle for
    // this same cosmetic state.
    expect(updatedSource!.lastContentHash).not.toBe("STALE-HASH");
  });

  test("list_extract re-run with same posts → ON CONFLICT dedupes; 0 new inserts", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/changelog",
      extractionMode: "list_extract",
    });

    const fetchImpl = firecrawlMockResponding("# Changelog\n- v1\n- v2");
    const extractListImpl = vi.fn(async () => [
      { title: "Release v1", url: "https://acme.test/changelog/v1", publishedAt: "2026-05-10" },
      { title: "Release v2", url: "https://acme.test/changelog/v2", publishedAt: "2026-05-12" },
    ]);

    const first = await runIngestionForUser(userId, { fetchImpl, extractListImpl });
    expect(first.perSource.webpage.inserted).toBe(2);

    const second = await runIngestionForUser(userId, { fetchImpl, extractListImpl });
    expect(second.perSource.webpage.fetched).toBe(2); // adapter still extracted both
    expect(second.perSource.webpage.inserted).toBe(0); // but the unique index dedupes

    const allItems = await h.db.select().from(rawItems);
    expect(allItems).toHaveLength(2);
    for (const item of allItems) {
      expect(item.competitorSourceId).toBe(sourceId);
    }
  });

  test("list_extract: only new URLs are inserted on the second run", async () => {
    const { userId, sourceId } = await seedWebpageSource({
      url: "https://acme.test/changelog",
      extractionMode: "list_extract",
    });

    const fetchImpl = firecrawlMockResponding("# Changelog");
    const extractListImpl = vi
      .fn()
      .mockResolvedValueOnce([
        { title: "v1", url: "https://acme.test/changelog/v1", publishedAt: null },
      ])
      .mockResolvedValueOnce([
        { title: "v1", url: "https://acme.test/changelog/v1", publishedAt: null },
        { title: "v2", url: "https://acme.test/changelog/v2", publishedAt: null },
      ]);

    await runIngestionForUser(userId, { fetchImpl, extractListImpl });
    const second = await runIngestionForUser(userId, { fetchImpl, extractListImpl });

    expect(second.perSource.webpage.inserted).toBe(1);

    const urls = (await h.db.select().from(rawItems))
      .filter((r) => r.competitorSourceId === sourceId)
      .map((r) => r.url)
      .sort();
    expect(urls).toEqual(["https://acme.test/changelog/v1", "https://acme.test/changelog/v2"]);
  });

  test("disabled webpage source is skipped entirely", async () => {
    const seed = await seedWebpageSource({
      url: "https://acme.test/blog",
      extractionMode: "list_extract",
    });
    await h.db
      .update(competitorSources)
      .set({ status: "disabled" })
      .where(eq(competitorSources.id, seed.sourceId));

    const fetchImpl = vi.fn();
    const extractListImpl = vi.fn();

    const metrics = await runIngestionForUser(seed.userId, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      extractListImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(extractListImpl).not.toHaveBeenCalled();
    expect(metrics.perSource.webpage).toEqual({ fetched: 0, inserted: 0, errored: false });
  });
});
