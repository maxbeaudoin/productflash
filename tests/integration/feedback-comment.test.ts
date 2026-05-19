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
const { handleFeedbackComment, FEEDBACK_COMMENT_MAX_LENGTH } =
  await import("~/shared/server/feedback-comment");

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
    .values({ email: "cmt@test.local", name: "CMT", tz: "UTC" })
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

async function ensureDownRating(digestItemId: string) {
  const token = signFeedbackToken(digestItemId, "down");
  const res = await handleFeedbackRating(digestItemId, "down", token);
  expect(res.status).toBe(302);
  return token;
}

describe("handleFeedbackComment — PF-62", () => {
  test("valid token + existing 👎 row → 204, comment + commented_at persisted", async () => {
    const { userId, digestItemId } = await seedDigestItem();
    const token = await ensureDownRating(digestItemId);

    const res = await handleFeedbackComment(digestItemId, "  Pricing detail was off  ", token);

    expect(res.status).toBe(204);
    const [row] = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(row!.comment).toBe("Pricing detail was off"); // trimmed
    expect(row!.commentedAt).not.toBeNull();
  });

  test("missing token → 400", async () => {
    const { digestItemId } = await seedDigestItem();
    await ensureDownRating(digestItemId);

    const res = await handleFeedbackComment(digestItemId, "anything", null);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("missing signature");
  });

  test("tampered token → 400, comment not persisted", async () => {
    const { userId, digestItemId } = await seedDigestItem();
    const token = await ensureDownRating(digestItemId);
    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");

    const res = await handleFeedbackComment(digestItemId, "should fail", tampered);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid signature");
    const [row] = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(row!.comment).toBeNull();
  });

  test("up-rating token cannot authorize a comment (binds to 'down')", async () => {
    const { digestItemId } = await seedDigestItem();
    await ensureDownRating(digestItemId);
    const upToken = signFeedbackToken(digestItemId, "up");

    const res = await handleFeedbackComment(digestItemId, "x", upToken);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("invalid signature");
  });

  test("empty/whitespace-only comment → 400", async () => {
    const { digestItemId } = await seedDigestItem();
    const token = await ensureDownRating(digestItemId);

    const res = await handleFeedbackComment(digestItemId, "   \n\t  ", token);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("comment is empty");
  });

  test("comment longer than the cap → 400, not persisted", async () => {
    const { userId, digestItemId } = await seedDigestItem();
    const token = await ensureDownRating(digestItemId);
    const oversized = "x".repeat(FEEDBACK_COMMENT_MAX_LENGTH + 1);

    const res = await handleFeedbackComment(digestItemId, oversized, token);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("comment too long");
    const [row] = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(row!.comment).toBeNull();
  });

  test("comment on item without an existing 👎 row → 400 (nothing to attach to)", async () => {
    const { digestItemId } = await seedDigestItem();
    // No rating issued. Forge the down-token (we'd hold it if we'd rated).
    const token = signFeedbackToken(digestItemId, "down");

    const res = await handleFeedbackComment(digestItemId, "stray comment", token);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("no down-rating to comment on");
  });

  test("comment on a row that was flipped back to 👍 → 400 (no 'down' row to update)", async () => {
    const { digestItemId } = await seedDigestItem();
    await ensureDownRating(digestItemId);
    const downToken = signFeedbackToken(digestItemId, "down");
    // Flip back to up — clears any prior comment per the rating-upsert rule.
    const upToken = signFeedbackToken(digestItemId, "up");
    await handleFeedbackRating(digestItemId, "up", upToken);

    const res = await handleFeedbackComment(digestItemId, "after flip", downToken);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("no down-rating to comment on");
  });

  test("unknown digest_item_id → 404", async () => {
    const fakeId = "11111111-1111-1111-1111-111111111111";
    const token = signFeedbackToken(fakeId, "down");

    const res = await handleFeedbackComment(fakeId, "x", token);

    expect(res.status).toBe(404);
  });

  test("re-commenting overwrites the previous comment", async () => {
    const { userId, digestItemId } = await seedDigestItem();
    const token = await ensureDownRating(digestItemId);

    await handleFeedbackComment(digestItemId, "first", token);
    await new Promise((r) => setTimeout(r, 5));
    await handleFeedbackComment(digestItemId, "second", token);

    const rows = await h.db.select().from(feedback).where(eq(feedback.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.comment).toBe("second");
  });
});
