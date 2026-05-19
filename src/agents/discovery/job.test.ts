import type PgBoss from "pg-boss";
import { describe, expect, test, vi } from "vitest";
import { DISCOVERY_QUEUE, enqueueDiscovery } from "./job";

// enqueueDiscovery is a thin send wrapper, but two contracts matter to
// callers: (a) the singletonKey uses the `competitor:<id>` prefix so future
// per-competitor queue work won't collide with any other singleton scheme,
// and (b) `enqueued: false` when pg-boss returns null so call sites can log
// the no-op path without crashing.

function makeBossStub(sendReturns: string | null) {
  const send = vi.fn().mockResolvedValue(sendReturns);
  return { boss: { send } as unknown as PgBoss, send };
}

describe("enqueueDiscovery", () => {
  test("sends to DISCOVERY_QUEUE with competitor-scoped singletonKey + a fresh runId", async () => {
    const { boss, send } = makeBossStub("job-1");
    const competitorId = "00000000-0000-0000-0000-00000000abcd";

    const result = await enqueueDiscovery(boss, competitorId);

    expect(send).toHaveBeenCalledTimes(1);
    const [queue, data, opts] = send.mock.calls[0];
    expect(queue).toBe(DISCOVERY_QUEUE);
    expect(data).toMatchObject({ competitorId });
    expect(typeof (data as { runId: string }).runId).toBe("string");
    expect((data as { runId: string }).runId).toHaveLength(36);
    expect(opts).toEqual({ singletonKey: `competitor:${competitorId}` });
    expect(result).toEqual({ runId: (data as { runId: string }).runId, enqueued: true });
  });

  test("returns enqueued=false when pg-boss returns null (singleton hit)", async () => {
    const { boss } = makeBossStub(null);
    const result = await enqueueDiscovery(boss, "00000000-0000-0000-0000-00000000abcd");
    expect(result.enqueued).toBe(false);
    expect(result.runId).toHaveLength(36);
  });
});
