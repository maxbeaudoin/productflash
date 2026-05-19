import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { competitors, digestItems, digests, feedback, rawItems, users } from "~/db/schema";
import { signFeedbackToken } from "~/shared/server/feedback-token";
import { startTestDb, truncateAll, type TestDb } from "./setup";

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

const { handleFeedbackRating } = await import("~/shared/server/feedback-rating");

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

async function seedDigestItem(): Promise<{ userId: string; digestItemId: string }> {
  const [user] = await h.db
    .insert(users)
    .values({ email: "fb@test.local", name: "FB", tz: "UTC" })
    .returning();
  const [comp] = await h.db
    .insert(competitors)
    .values({ name: "Acme", homepageUrl: "https://acme.test" })
    .returning();
  const [raw] = await h.db
    .insert(rawItems)
    .values({
      competitorId: comp!.id,
      source: "rss",
      sourceId: "r-1",
      url: "https://acme.test/1",
      title: "t",
      body: "b",
      publishedAt: new Date("2026-05-17T00:00:00Z"),
    })
    .returning();
  const [digest] = await h.db
    .insert(digests)
    .values({ userId: user!.id, itemCount: 1 })
    .returning();
  const [item] = await h.db
    .insert(digestItems)
    .values({
      userId: user!.id,
      digestId: digest!.id,
      rawItemId: raw!.id,
      category: "launch",
      headline: "h",
      snippet: "s",
      impactNote: "i",
      score: 80,
    })
    .returning();
  return { userId: user!.id, digestItemId: item!.id };
}

describe("handleFeedbackRating — F-010", () => {
  test("valid token + valid item → 302 to /r/thanks, feedback row inserted", async () => {
    const { userId, digestItemId } = await seedDigestItem();
    const token = signFeedbackToken(digestItemId, "up");

    const res = await handleFeedbackRating(digestItemId, "up", token);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/r/thanks?rating=up");

    const rows = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ digestItemId, userId, rating: "up" });
  });

  test("missing token → 400 missing signature, no feedback row", async () => {
    const { digestItemId } = await seedDigestItem();

    const res = await handleFeedbackRating(digestItemId, "up", null);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing signature");
    expect(await h.db.select().from(feedback)).toHaveLength(0);
  });

  test("tampered token → 400 invalid signature, no feedback row", async () => {
    const { digestItemId } = await seedDigestItem();
    const token = signFeedbackToken(digestItemId, "up");
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");

    const res = await handleFeedbackRating(digestItemId, "up", tampered);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid signature");
    expect(await h.db.select().from(feedback)).toHaveLength(0);
  });

  test('token signed for "up" cannot be replayed as "down"', async () => {
    const { digestItemId } = await seedDigestItem();
    const upToken = signFeedbackToken(digestItemId, "up");

    const res = await handleFeedbackRating(digestItemId, "down", upToken);

    expect(res.status).toBe(400);
    expect(await h.db.select().from(feedback)).toHaveLength(0);
  });

  test("unknown digest_item_id → 404 not found (no insert attempted)", async () => {
    const fakeId = "11111111-1111-1111-1111-111111111111";
    const token = signFeedbackToken(fakeId, "up");

    const res = await handleFeedbackRating(fakeId, "up", token);

    expect(res.status).toBe(404);
    expect(await h.db.select().from(feedback)).toHaveLength(0);
  });

  test("re-vote (up → down) updates rating + created_at via excluded.*", async () => {
    const { userId, digestItemId } = await seedDigestItem();

    // First vote: up.
    const upToken = signFeedbackToken(digestItemId, "up");
    await handleFeedbackRating(digestItemId, "up", upToken);
    const [first] = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(first!.rating).toBe("up");

    // Tick the clock 1ms so created_at can move forward measurably.
    await new Promise((r) => setTimeout(r, 10));

    // Second vote: down. Same (user_id, digest_item_id) pair → ON CONFLICT
    // path updates the existing row.
    const downToken = signFeedbackToken(digestItemId, "down");
    await handleFeedbackRating(digestItemId, "down", downToken);
    const after = await h.db.select().from(feedback).where(eq(feedback.userId, userId));

    expect(after).toHaveLength(1); // single row — not a duplicate insert
    expect(after[0]!.rating).toBe("down");
    expect(after[0]!.createdAt.getTime()).toBeGreaterThan(first!.createdAt.getTime());
  });

  test("👎 redirect carries digestItemId + token so the thanks page can host the comment form", async () => {
    const { digestItemId } = await seedDigestItem();
    const downToken = signFeedbackToken(digestItemId, "down");

    const res = await handleFeedbackRating(digestItemId, "down", downToken);

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain(`rating=down`);
    expect(location).toContain(`digestItemId=${digestItemId}`);
    expect(location).toContain(`t=${encodeURIComponent(downToken)}`);
  });

  test("flipping 👎 → 👍 clears any saved comment", async () => {
    const { userId, digestItemId } = await seedDigestItem();

    // Rate down and attach a comment directly via SQL (mirrors what
    // `handleFeedbackComment` would do).
    const downToken = signFeedbackToken(digestItemId, "down");
    await handleFeedbackRating(digestItemId, "down", downToken);
    await h.db
      .update(feedback)
      .set({ comment: "Pricing detail was wrong", commentedAt: new Date() })
      .where(eq(feedback.userId, userId));

    const before = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(before[0]!.comment).toBe("Pricing detail was wrong");

    // Now flip to 👍 — comment must be cleared.
    const upToken = signFeedbackToken(digestItemId, "up");
    await handleFeedbackRating(digestItemId, "up", upToken);

    const after = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(after).toHaveLength(1);
    expect(after[0]!.rating).toBe("up");
    expect(after[0]!.comment).toBeNull();
    expect(after[0]!.commentedAt).toBeNull();
  });

  test("re-rating 👎 → 👎 preserves an existing comment (no-op conflict path)", async () => {
    const { userId, digestItemId } = await seedDigestItem();

    const downToken = signFeedbackToken(digestItemId, "down");
    await handleFeedbackRating(digestItemId, "down", downToken);
    await h.db
      .update(feedback)
      .set({ comment: "keep me", commentedAt: new Date() })
      .where(eq(feedback.userId, userId));

    // Click 👎 again — conflict path runs but rating stays 'down', so the
    // comment must survive.
    await handleFeedbackRating(digestItemId, "down", downToken);

    const after = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(after[0]!.comment).toBe("keep me");
    expect(after[0]!.commentedAt).not.toBeNull();
  });
});
