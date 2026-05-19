import { describe, expect, test, vi } from "vitest";
import type PgBoss from "pg-boss";

// Mock the side-effectful neighbors so the unit suite stays DB-/API-free.
vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

const runScoringForUserMock = vi.fn();
const runSynthesisForUserMock = vi.fn();

vi.mock("./score", () => ({
  runScoringForUser: runScoringForUserMock,
}));
vi.mock("./synthesize", () => ({
  runSynthesisForUser: runSynthesisForUserMock,
}));

const { DAILY_REGEN_QUEUE, enqueueDailyRegen, handleDailyRegenJob } = await import("./daily-regen");

describe("enqueueDailyRegen — singleton per user", () => {
  test("sends with singletonKey=userId so double-clicks are no-ops", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const boss = { send } as unknown as PgBoss;
    const userId = "u-123";

    const result = await enqueueDailyRegen(boss, userId);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(DAILY_REGEN_QUEUE, { userId }, { singletonKey: userId });
    expect(result).toEqual({ enqueued: true });
  });

  test("returns enqueued=false when pg-boss collapses the singleton", async () => {
    // pg-boss returns null when a singleton job already exists for the key.
    const send = vi.fn().mockResolvedValue(null);
    const boss = { send } as unknown as PgBoss;

    const result = await enqueueDailyRegen(boss, "u-456");

    expect(result).toEqual({ enqueued: false });
  });
});

describe("handleDailyRegenJob — orchestration", () => {
  test("runs score with defaults, then synthesize with defaults, no ingest", async () => {
    const order: string[] = [];
    runScoringForUserMock.mockImplementation(async () => {
      order.push("score");
      return { userId: "u-1", candidates: 12, classified: 12, skipped: 0, errored: 0 };
    });
    runSynthesisForUserMock.mockImplementation(async () => {
      order.push("synth");
      return { userId: "u-1", candidates: 5, synthesized: 5, empty: false, errored: false };
    });

    const job = { id: "j-1", data: { userId: "u-1" } } as PgBoss.Job<{ userId: string }>;
    const metrics = await handleDailyRegenJob(job);

    // Order matters: synth reads item_scores written by score.
    expect(order).toEqual(["score", "synth"]);

    // Score + synth both invoked with NO options — daily defaults apply
    // (24h lookback, 5 items, cap-2, no published_at cap at score level).
    // Catch-up params are the explicit overrides in fast-path; absence of
    // options here is the contract.
    expect(runScoringForUserMock).toHaveBeenCalledWith("u-1");
    expect(runSynthesisForUserMock).toHaveBeenCalledWith("u-1");

    expect(metrics.score).toEqual({ candidates: 12, classified: 12 });
    expect(metrics.synthesize).toEqual({ candidates: 5, synthesized: 5, empty: false });
    expect(metrics.userId).toBe("u-1");
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
  });
});
