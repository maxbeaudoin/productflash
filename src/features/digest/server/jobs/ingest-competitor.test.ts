import { describe, expect, test, vi } from "vitest";
import type PgBoss from "pg-boss";

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

const runIngestionForCompetitorMock = vi.fn();
vi.mock("./ingest", () => ({
  runIngestionForCompetitor: runIngestionForCompetitorMock,
}));

const { INGEST_COMPETITOR_QUEUE, enqueueIngestCompetitor, handleIngestCompetitorJob } =
  await import("./ingest-competitor");

describe("enqueueIngestCompetitor — singleton per competitor", () => {
  test("sends with singletonKey=competitor:<id> so double-clicks are no-ops", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const boss = { send } as unknown as PgBoss;
    const competitorId = "c-123";

    const result = await enqueueIngestCompetitor(boss, competitorId);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      INGEST_COMPETITOR_QUEUE,
      { competitorId },
      { singletonKey: `competitor:${competitorId}` },
    );
    expect(result).toEqual({ enqueued: true });
  });

  test("returns enqueued=false when pg-boss collapses the singleton", async () => {
    const send = vi.fn().mockResolvedValue(null);
    const boss = { send } as unknown as PgBoss;

    const result = await enqueueIngestCompetitor(boss, "c-456");

    expect(result).toEqual({ enqueued: false });
  });
});

describe("handleIngestCompetitorJob — delegates to runIngestionForCompetitor", () => {
  test("forwards competitorId from job data", async () => {
    runIngestionForCompetitorMock.mockResolvedValueOnce({
      competitors: 1,
      durationMs: 42,
      perSource: {
        rss: { fetched: 0, inserted: 0, errored: false },
        ph: { fetched: 0, inserted: 0, errored: false },
        firehose: { fetched: 0, inserted: 0, errored: false },
        firecrawl: { fetched: 0, inserted: 0, errored: false },
        webpage: { fetched: 0, inserted: 0, errored: false },
      },
      totalFetched: 0,
      totalInserted: 0,
    });

    const job = {
      id: "job-1",
      data: { competitorId: "c-789" },
    } as PgBoss.Job<{ competitorId: string }>;

    await handleIngestCompetitorJob(job);

    expect(runIngestionForCompetitorMock).toHaveBeenCalledTimes(1);
    expect(runIngestionForCompetitorMock).toHaveBeenCalledWith("c-789");
  });
});
