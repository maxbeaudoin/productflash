import { describe, expect, test, vi } from "vitest";

// synthesize.ts pulls in pino-backed logger + posthog + drizzle at module
// load. Short-circuit the side-effectful ones so the unit suite runs
// without a DB connection or analytics writes.
vi.mock("~/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

const { buildDigestItemRow, selectDiverseCandidates, startOfUtcDay } = await import("./synthesize");

describe("selectDiverseCandidates — diversity cap", () => {
  type Item = { rawItemId: string; competitorName: string; score: number };
  const item = (id: string, comp: string, score = 0): Item => ({
    rawItemId: id,
    competitorName: comp,
    score,
  });

  test("empty pool → empty result", () => {
    expect(selectDiverseCandidates<Item>([], 5, 2)).toEqual([]);
  });

  test("pool smaller than maxItems → all items kept", () => {
    const pool = [item("a", "A"), item("b", "B")];
    expect(selectDiverseCandidates(pool, 5, 2).map((i) => i.rawItemId)).toEqual(["a", "b"]);
  });

  test("cap=2 enforced in pass 1 when ≥3 competitors have items (dogfood iter 2 regression)", () => {
    // 5-item digest, cap=2. Lattice has 4 high-score items at the top, then
    // 15Five and Notion. Without the cap, Lattice would consume 4 of 5 slots
    // and 15Five would never appear. Pass 1 caps Lattice at 2; pass 2 then
    // backfills the 5th slot from leftovers in input order (which is
    // score-sorted upstream), pulling lattice-3 back in.
    const pool = [
      item("lattice-1", "Lattice", 92),
      item("lattice-2", "Lattice", 88),
      item("lattice-3", "Lattice", 80),
      item("lattice-4", "Lattice", 75),
      item("fifteen5-1", "15Five", 70),
      item("notion-1", "Notion", 60),
    ];
    const result = selectDiverseCandidates(pool, 5, 2);
    expect(result.length).toBe(5);

    // Final distribution: pass 1 = 2 Lattice + 1 15Five + 1 Notion (4 items),
    // pass 2 = 1 more Lattice (the next leftover in score order).
    const counts = new Map<string, number>();
    for (const i of result) counts.set(i.competitorName, (counts.get(i.competitorName) ?? 0) + 1);
    expect(counts.get("Lattice")).toBe(3);
    expect(counts.get("15Five")).toBe(1);
    expect(counts.get("Notion")).toBe(1);

    // 15Five reached the digest — that's the regression this cap exists to
    // prevent. Without the cap, slot order was [lattice-1..4, fifteen5-1].
    expect(result.some((i) => i.competitorName === "15Five")).toBe(true);

    // Pass-2 backfill preserves input order: lattice-3 lands before lattice-4.
    expect(result[4]!.rawItemId).toBe("lattice-3");
  });

  test("second pass fills remaining slots when only one competitor has items", () => {
    // Single-competitor edge case: cap=2 would normally cap at 2, but the
    // user genuinely has news from only one competitor and we'd rather show
    // 5 items than ship a near-empty digest. Second pass relaxes the cap.
    const pool = [
      item("a-1", "Acme"),
      item("a-2", "Acme"),
      item("a-3", "Acme"),
      item("a-4", "Acme"),
      item("a-5", "Acme"),
    ];
    const result = selectDiverseCandidates(pool, 5, 2);
    expect(result.length).toBe(5);
    expect(result.every((i) => i.competitorName === "Acme")).toBe(true);
  });

  test("input order is preserved within each pass (no re-sorting)", () => {
    // Caller pre-sorts by score; the function must not shuffle.
    const pool = [item("first", "A"), item("second", "B"), item("third", "C"), item("fourth", "D")];
    const result = selectDiverseCandidates(pool, 4, 2);
    expect(result.map((i) => i.rawItemId)).toEqual(["first", "second", "third", "fourth"]);
  });

  test("cap=3 at maxItems=10 lands closer to a 50/30/20 split (catch-up tuning)", () => {
    // Mirrors the comment in synthesize.ts: fast-path catch-up uses 10
    // items + cap=3 to keep diversity meaningful when the pool is broader.
    const pool: Item[] = [];
    for (let i = 0; i < 10; i++) pool.push(item(`lat-${i}`, "Lattice", 100 - i));
    for (let i = 0; i < 5; i++) pool.push(item(`bam-${i}`, "BambooHR", 50 - i));
    for (let i = 0; i < 5; i++) pool.push(item(`gus-${i}`, "Gusto", 40 - i));

    const result = selectDiverseCandidates(pool, 10, 3);
    const counts = new Map<string, number>();
    for (const i of result) counts.set(i.competitorName, (counts.get(i.competitorName) ?? 0) + 1);
    // Pass 1: 3 Lattice + 3 BambooHR + 3 Gusto = 9. Pass 2: fills the 10th
    // slot from the leftover (next-highest score = Lattice's #4).
    expect(counts.get("Lattice")).toBe(4);
    expect(counts.get("BambooHR")).toBe(3);
    expect(counts.get("Gusto")).toBe(3);
    expect(result.length).toBe(10);
  });

  test("maxItems=0 returns empty", () => {
    const pool = [item("a", "A"), item("b", "B")];
    expect(selectDiverseCandidates(pool, 0, 2)).toEqual([]);
  });
});

describe("startOfUtcDay", () => {
  test("mid-day instant collapses to UTC midnight of that day", () => {
    const result = startOfUtcDay(new Date("2026-05-16T14:32:11.500Z"));
    expect(result.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });

  test("already at midnight is a no-op (but a fresh instance)", () => {
    const midnight = new Date("2026-05-16T00:00:00.000Z");
    const result = startOfUtcDay(midnight);
    expect(result.toISOString()).toBe("2026-05-16T00:00:00.000Z");
    expect(result).not.toBe(midnight); // doesn't mutate the input
  });

  test("one millisecond before midnight floors to previous day", () => {
    const result = startOfUtcDay(new Date("2026-05-16T23:59:59.999Z"));
    expect(result.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });

  test("one millisecond past midnight floors to that day", () => {
    const result = startOfUtcDay(new Date("2026-05-17T00:00:00.001Z"));
    expect(result.toISOString()).toBe("2026-05-17T00:00:00.000Z");
  });
});

describe("buildDigestItemRow", () => {
  const synthesized = {
    rawItemId: "raw-1",
    headline: "Acme launches new pricing tier",
    snippet: "Acme today introduced a new $99/mo professional plan.",
    impactNote: "Direct competition with our Pro plan.",
  };

  test("meta found → row combines synthesized text with score/category/occurredAt from meta", () => {
    const byId = new Map([
      ["raw-1", { category: "pricing", score: 78, publishedAt: new Date("2026-05-16T00:00:00Z") }],
    ]);
    const row = buildDigestItemRow("user-1", synthesized, byId);
    expect(row).toEqual({
      userId: "user-1",
      rawItemId: "raw-1",
      category: "pricing",
      headline: synthesized.headline,
      snippet: synthesized.snippet,
      impactNote: synthesized.impactNote,
      score: 78,
      occurredAt: new Date("2026-05-16T00:00:00Z"),
    });
  });

  test("meta missing → returns null (drops orphan synthesized item rather than throwing)", () => {
    const row = buildDigestItemRow("user-1", synthesized, new Map());
    expect(row).toBeNull();
  });

  test("publishedAt null propagates as null (no fabricated date — #41 rule)", () => {
    const byId = new Map([["raw-1", { category: "feature", score: 50, publishedAt: null }]]);
    const row = buildDigestItemRow("user-1", synthesized, byId);
    expect(row?.occurredAt).toBeNull();
  });
});
