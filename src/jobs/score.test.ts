import { describe, expect, test, vi } from "vitest";

// score.ts pulls logger + posthog at module load. Short-circuit the
// side-effectful ones; this suite only tests the concurrency helper.
vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({ captureServerEvent: vi.fn() }));

const { runWithConcurrency } = await import("./score");

describe("runWithConcurrency", () => {
  test("preserves input order in the result array even when workers finish out of order", async () => {
    // Items have descending delays so worker[0] finishes last. Without the
    // explicit index assignment in the source, results would arrive in
    // completion order and the array would be scrambled.
    const items = [
      { id: 0, delay: 30 },
      { id: 1, delay: 20 },
      { id: 2, delay: 10 },
      { id: 3, delay: 5 },
    ];
    const result = await runWithConcurrency(items, 4, async (i) => {
      await new Promise((r) => setTimeout(r, i.delay));
      return i.id * 2;
    });
    expect(result).toEqual([0, 2, 4, 6]);
  });

  test("runs items in parallel up to the concurrency limit (3 items, 1 worker → sequential)", async () => {
    const start = Date.now();
    const result = await runWithConcurrency([10, 10, 10], 1, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(result).toEqual([10, 10, 10]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25); // ~3 × 10ms sequential
  });

  test("concurrency capped at items.length (5 workers on 2 items → only 2 workers spawn)", async () => {
    const seen: number[] = [];
    const result = await runWithConcurrency([100, 200], 5, async (n) => {
      seen.push(n);
      return n + 1;
    });
    expect(seen).toHaveLength(2); // not 5
    expect(result).toEqual([101, 201]);
  });

  test("empty items → empty result, fn never called", async () => {
    const fn = vi.fn();
    const result = await runWithConcurrency([], 4, fn);
    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  test("an item that throws rejects the whole batch", async () => {
    // Promise.all semantics: one rejection causes the outer promise to
    // reject. The score job catches per-item upstream of this helper;
    // pin the behavior so a refactor doesn't quietly swallow errors.
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  test("each item is processed exactly once (no cursor double-advance)", async () => {
    const seen = new Set<number>();
    const items = Array.from({ length: 50 }, (_, i) => i);
    await runWithConcurrency(items, 8, async (i) => {
      if (seen.has(i)) throw new Error(`duplicate: ${i}`);
      seen.add(i);
      return i;
    });
    expect(seen.size).toBe(50);
  });
});
