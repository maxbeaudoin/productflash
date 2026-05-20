import { describe, expect, it } from "vitest";
import type { CompetitorAdminRow } from "./types";
import { STALE_THRESHOLD_DAYS, classifyHealthFlags } from "./health-flags";

const NOW = Date.parse("2026-05-18T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<CompetitorAdminRow>): CompetitorAdminRow {
  return {
    id: "c-1",
    name: "Acme",
    homepageUrl: "https://acme.test",
    rssUrl: "https://acme.test/rss",
    createdAt: new Date(NOW - 5 * DAY).toISOString(),
    trackedBy: 1,
    rawItems7d: 3,
    lastIngestedAt: new Date(NOW - 1 * DAY).toISOString(),
    ...overrides,
  };
}

describe("classifyHealthFlags", () => {
  it("flags orphans when trackedBy is zero", () => {
    const orphan = row({ id: "orphan", trackedBy: 0 });
    const tracked = row({ id: "tracked", trackedBy: 2 });
    const result = classifyHealthFlags([orphan, tracked], NOW);
    expect(result.orphans.rows.map((r) => r.id)).toEqual(["orphan"]);
  });

  it("flags sourceless when rssUrl is null", () => {
    const sourceless = row({ id: "sourceless", rssUrl: null });
    const hasRss = row({ id: "has-rss", rssUrl: "https://x/rss" });
    const result = classifyHealthFlags([sourceless, hasRss], NOW);
    expect(result.sourceless.rows.map((r) => r.id)).toEqual(["sourceless"]);
  });

  it("does not double-flag sourceless rows as stale", () => {
    // A sourceless row trivially has no ingestion — surfacing it twice is noise.
    const sourceless = row({ id: "sourceless", rssUrl: null, lastIngestedAt: null });
    const result = classifyHealthFlags([sourceless], NOW);
    expect(result.sourceless.rows).toHaveLength(1);
    expect(result.stale.rows).toHaveLength(0);
  });

  it("flags stale when source is configured but last ingest is older than 30d", () => {
    const stale = row({
      id: "stale",
      lastIngestedAt: new Date(NOW - (STALE_THRESHOLD_DAYS + 1) * DAY).toISOString(),
    });
    const fresh = row({ id: "fresh", lastIngestedAt: new Date(NOW - 2 * DAY).toISOString() });
    const result = classifyHealthFlags([stale, fresh], NOW);
    expect(result.stale.rows.map((r) => r.id)).toEqual(["stale"]);
  });

  it("flags stale when source is configured but ingestion has never happened", () => {
    const neverIngested = row({ id: "never", rssUrl: "https://x/rss", lastIngestedAt: null });
    const result = classifyHealthFlags([neverIngested], NOW);
    expect(result.stale.rows.map((r) => r.id)).toEqual(["never"]);
  });

  it("returns empty buckets when every row is healthy", () => {
    const healthy = row({});
    const result = classifyHealthFlags([healthy], NOW);
    expect(result.orphans.rows).toHaveLength(0);
    expect(result.sourceless.rows).toHaveLength(0);
    expect(result.stale.rows).toHaveLength(0);
  });
});
