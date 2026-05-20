import { describe, expect, test, vi } from "vitest";
import type { NormalizedItem } from "~/sources/types";

// ingest.ts pulls in source adapters + db at module load. Short-circuit
// the side-effectful imports; this suite only tests the pure aggregators.
vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shared/server/posthog", () => ({ captureServerEvent: vi.fn() }));
vi.mock("~/shared/server/db", () => ({ getDb: vi.fn() }));
vi.mock("~/sources/firecrawl", () => ({ scrapePricingPagesForCompetitors: vi.fn() }));
vi.mock("~/sources/firecrawl-store", () => ({
  loadLatestPricingSnapshots: vi.fn(),
  saveLatestPricingSnapshot: vi.fn(),
}));
vi.mock("~/sources/rss", () => ({ fetchRSSForCompetitors: vi.fn() }));

const { collectFanout, settleToFanoutMetrics } = await import("./ingest");

function rssItem(sourceId: string): NormalizedItem {
  return {
    source: "rss",
    sourceId,
    url: `https://example.com/${sourceId}`,
    title: `title-${sourceId}`,
    body: null,
    publishedAt: null,
  };
}

describe("settleToFanoutMetrics", () => {
  test("rejected settlement → errored=true, fetched=0", () => {
    const m = settleToFanoutMetrics({ status: "rejected", reason: new Error("vendor 5xx") }, "rss");
    expect(m).toEqual({ fetched: 0, inserted: 0, errored: true });
  });

  test("fulfilled settlement sums items across competitors", () => {
    const m = settleToFanoutMetrics(
      {
        status: "fulfilled",
        value: new Map([
          ["comp-a", [rssItem("1"), rssItem("2")]],
          ["comp-b", [rssItem("3")]],
        ]),
      },
      "rss",
    );
    expect(m).toEqual({ fetched: 3, inserted: 0, errored: false });
  });

  test("fulfilled but empty map → fetched=0, errored=false", () => {
    const m = settleToFanoutMetrics({ status: "fulfilled", value: new Map() }, "rss");
    expect(m).toEqual({ fetched: 0, inserted: 0, errored: false });
  });
});

describe("collectFanout", () => {
  test("flattens per-competitor items into NewRawItem rows tagged with competitorId", () => {
    const out: Parameters<typeof collectFanout>[1] = [];
    collectFanout(
      {
        status: "fulfilled",
        value: new Map([
          ["comp-a", [rssItem("1"), rssItem("2")]],
          ["comp-b", [rssItem("3")]],
        ]),
      },
      out,
    );
    expect(out).toHaveLength(3);
    expect(out.map((r) => ({ id: r.sourceId, c: r.competitorId }))).toEqual([
      { id: "1", c: "comp-a" },
      { id: "2", c: "comp-a" },
      { id: "3", c: "comp-b" },
    ]);
    expect(out[0]!.source).toBe("rss");
    expect(out[0]!.url).toBe("https://example.com/1");
  });

  test("rejected settlement is a no-op — leaves the accumulator untouched", () => {
    const out: Parameters<typeof collectFanout>[1] = [
      {
        competitorId: "pre",
        source: "rss",
        sourceId: "pre",
        url: "",
        title: "",
        body: null,
        publishedAt: null,
      },
    ];
    collectFanout({ status: "rejected", reason: new Error("boom") }, out);
    expect(out).toHaveLength(1); // pre-existing row untouched
    expect(out[0]!.sourceId).toBe("pre");
  });

  test("empty fulfilled map → no rows appended", () => {
    const out: Parameters<typeof collectFanout>[1] = [];
    collectFanout({ status: "fulfilled", value: new Map() }, out);
    expect(out).toEqual([]);
  });

  test("preserves publishedAt / body when present", () => {
    const item: NormalizedItem = {
      source: "rss",
      sourceId: "x",
      url: "https://example.com/x",
      title: "t",
      body: "b",
      publishedAt: new Date("2026-05-16T00:00:00Z"),
    };
    const out: Parameters<typeof collectFanout>[1] = [];
    collectFanout({ status: "fulfilled", value: new Map([["comp", [item]]]) }, out);
    expect(out[0]!.body).toBe("b");
    expect(out[0]!.publishedAt?.toISOString()).toBe("2026-05-16T00:00:00.000Z");
  });
});
