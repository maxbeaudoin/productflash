import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAudit, competitorSources, competitors, rawItems, users } from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";

// Integration tests for the per-source admin mutations (PF-93 phase 3 /
// PF-96). The createServerFn wrappers in `admin-fns.ts` need TanStack
// Start's AST transform to invoke their handlers in process — they short-
// circuit in raw vitest. So we test the plain `applyX` helpers in
// `source-actions.ts` directly; the wrappers are thin auth + validation
// shells, and their input schemas are exercised by the route smoke.

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
}));
vi.mock("~/shared/server/db", () => ({
  getDb: () => dbHolder.db,
}));

const { applySourceStatus, applySourceRemove, applySourceUrlUpdate } =
  await import("~/features/competitors/server/source-actions");

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
  dbHolder.db = h.db;
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await truncateAll(h.pool);
});

const ADMIN_EMAIL = "admin@test.local";

async function seed(): Promise<{
  adminId: string;
  competitorId: string;
  rssSourceId: string;
  webpageSourceId: string;
  xSourceId: string;
}> {
  const [admin] = await h.db
    .insert(users)
    .values({ email: ADMIN_EMAIL, role: "admin" })
    .returning();
  const [comp] = await h.db
    .insert(competitors)
    .values({ name: "Acme", homepageUrl: "https://acme.test" })
    .returning();
  const [rss] = await h.db
    .insert(competitorSources)
    .values({
      competitorId: comp!.id,
      sourceType: "rss",
      extractionMode: "feed_poll",
      urlOrHandle: "https://acme.test/feed.xml",
      status: "active",
      agentRationale: "homepage <link rel=alternate>",
    })
    .returning();
  const [webpage] = await h.db
    .insert(competitorSources)
    .values({
      competitorId: comp!.id,
      sourceType: "webpage",
      extractionMode: null,
      urlOrHandle: "https://acme.test/changelog",
      status: "active",
      agentRationale: "changelog page",
    })
    .returning();
  const [x] = await h.db
    .insert(competitorSources)
    .values({
      competitorId: comp!.id,
      sourceType: "x",
      extractionMode: null,
      urlOrHandle: "@acmehq",
      status: "active",
      agentRationale: "homepage footer X link",
    })
    .returning();
  return {
    adminId: admin!.id,
    competitorId: comp!.id,
    rssSourceId: rss!.id,
    webpageSourceId: webpage!.id,
    xSourceId: x!.id,
  };
}

describe("applySourceStatus", () => {
  test("disables an active source + writes audit", async () => {
    const { adminId, competitorId, rssSourceId } = await seed();

    const res = await applySourceStatus({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: rssSourceId,
      status: "disabled",
    });
    expect(res).toEqual({ changed: true });

    const [row] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, rssSourceId));
    expect(row!.status).toBe("disabled");

    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: adminId,
      targetKind: "competitor",
      action: "competitor_source_disable",
    });
    expect(audit[0]!.payload).toMatchObject({
      sourceId: rssSourceId,
      sourceType: "rss",
      before: "active",
      after: "disabled",
    });
  });

  test("re-enables a disabled source + audits with the enable action", async () => {
    const { adminId, competitorId, rssSourceId } = await seed();
    await h.db
      .update(competitorSources)
      .set({ status: "disabled" })
      .where(eq(competitorSources.id, rssSourceId));

    const res = await applySourceStatus({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: rssSourceId,
      status: "active",
    });
    expect(res).toEqual({ changed: true });

    const [row] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, rssSourceId));
    expect(row!.status).toBe("active");

    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("competitor_source_enable");
  });

  test("no-op when status already matches; no audit row", async () => {
    const { adminId, competitorId, rssSourceId } = await seed();
    const res = await applySourceStatus({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: rssSourceId,
      status: "active",
    });
    expect(res).toEqual({ changed: false });
    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(0);
  });

  test("missing source rejects", async () => {
    const { adminId } = await seed();
    await expect(
      applySourceStatus({
        actorId: adminId,
        actorEmail: ADMIN_EMAIL,
        sourceId: "11111111-1111-1111-1111-111111111111",
        status: "disabled",
      }),
    ).rejects.toThrow(/source_not_found/);
  });
});

describe("applySourceRemove", () => {
  test("deletes the row + writes audit; raw_items keep history with SET NULL", async () => {
    const { adminId, competitorId, webpageSourceId } = await seed();
    await h.db.insert(rawItems).values({
      competitorId,
      source: "firecrawl",
      sourceId: "ext-1",
      competitorSourceId: webpageSourceId,
      url: "https://acme.test/changelog#1",
      title: "Acme v1 ships",
    });

    const res = await applySourceRemove({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: webpageSourceId,
    });
    expect(res).toEqual({ removed: true });

    const rows = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, webpageSourceId));
    expect(rows).toHaveLength(0);

    const [item] = await h.db.select().from(rawItems).where(eq(rawItems.sourceId, "ext-1"));
    expect(item!.competitorSourceId).toBeNull();

    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("competitor_source_remove");
    expect(audit[0]!.payload).toMatchObject({
      sourceId: webpageSourceId,
      sourceType: "webpage",
    });
  });

  test("missing source rejects", async () => {
    const { adminId } = await seed();
    await expect(
      applySourceRemove({
        actorId: adminId,
        actorEmail: ADMIN_EMAIL,
        sourceId: "22222222-2222-2222-2222-222222222222",
      }),
    ).rejects.toThrow(/source_not_found/);
  });
});

describe("applySourceUrlUpdate", () => {
  test("rss/webpage normalizes URL, resets fetch state, audits", async () => {
    const { adminId, competitorId, webpageSourceId } = await seed();
    await h.db
      .update(competitorSources)
      .set({
        lastFetchedAt: new Date("2026-05-01T00:00:00Z"),
        lastContentHash: "abc123",
      })
      .where(eq(competitorSources.id, webpageSourceId));

    const res = await applySourceUrlUpdate({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: webpageSourceId,
      urlOrHandle: "acme.test/releases",
    });
    expect(res).toEqual({ changed: true });

    const [row] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, webpageSourceId));
    expect(row!.urlOrHandle).toBe("https://acme.test/releases");
    expect(row!.lastFetchedAt).toBeNull();
    expect(row!.lastContentHash).toBeNull();

    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe("competitor_source_edit_url");
    expect(audit[0]!.payload).toMatchObject({
      sourceId: webpageSourceId,
      sourceType: "webpage",
      before: "https://acme.test/changelog",
      after: "https://acme.test/releases",
    });
  });

  test("social accepts @handle without URL normalization", async () => {
    const { adminId, competitorId, xSourceId } = await seed();
    const res = await applySourceUrlUpdate({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: xSourceId,
      urlOrHandle: "@acme",
    });
    expect(res).toEqual({ changed: true });

    const [row] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, xSourceId));
    expect(row!.urlOrHandle).toBe("@acme");

    const [audit] = await h.db
      .select()
      .from(adminAudit)
      .where(eq(adminAudit.targetId, competitorId));
    expect(audit!.action).toBe("competitor_source_edit_url");
  });

  test("rss with malformed URL rejects, no DB write", async () => {
    const { adminId, rssSourceId } = await seed();
    await expect(
      applySourceUrlUpdate({
        actorId: adminId,
        actorEmail: ADMIN_EMAIL,
        sourceId: rssSourceId,
        urlOrHandle: "not a url",
      }),
    ).rejects.toThrow(/invalid_url/);
    const [row] = await h.db
      .select()
      .from(competitorSources)
      .where(eq(competitorSources.id, rssSourceId));
    expect(row!.urlOrHandle).toBe("https://acme.test/feed.xml");
  });

  test("social with neither URL nor @handle rejects", async () => {
    const { adminId, xSourceId } = await seed();
    await expect(
      applySourceUrlUpdate({
        actorId: adminId,
        actorEmail: ADMIN_EMAIL,
        sourceId: xSourceId,
        urlOrHandle: "acmehq",
      }),
    ).rejects.toThrow(/invalid_handle/);
  });

  test("unchanged URL is a no-op; no audit row", async () => {
    const { adminId, competitorId, rssSourceId } = await seed();
    const res = await applySourceUrlUpdate({
      actorId: adminId,
      actorEmail: ADMIN_EMAIL,
      sourceId: rssSourceId,
      urlOrHandle: "https://acme.test/feed.xml",
    });
    expect(res).toEqual({ changed: false });
    const audit = await h.db.select().from(adminAudit).where(eq(adminAudit.targetId, competitorId));
    expect(audit).toHaveLength(0);
  });
});
