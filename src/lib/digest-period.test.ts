import { describe, expect, test } from "vitest";
import { deriveDigestPeriod } from "./digest-period";

describe("deriveDigestPeriod", () => {
  test("null start or end returns kind=unknown with no fields", () => {
    expect(deriveDigestPeriod({ periodStart: null, periodEnd: null })).toEqual({
      kind: "unknown",
      rangeLabel: null,
      daysBack: null,
    });
    expect(deriveDigestPeriod({ periodStart: "2026-05-15T00:00:00Z", periodEnd: null })).toEqual({
      kind: "unknown",
      rangeLabel: null,
      daysBack: null,
    });
    expect(deriveDigestPeriod({ periodStart: null, periodEnd: "2026-05-15T00:00:00Z" })).toEqual({
      kind: "unknown",
      rangeLabel: null,
      daysBack: null,
    });
  });

  test("24h span is classified as daily", () => {
    const result = deriveDigestPeriod({
      periodStart: "2026-05-15T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(result.kind).toBe("daily");
    expect(result.daysBack).toBeNull();
    expect(result.rangeLabel).not.toBeNull();
  });

  test("48h span is classified as daily (boundary inclusive)", () => {
    const result = deriveDigestPeriod({
      periodStart: "2026-05-14T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(result.kind).toBe("daily");
  });

  test("72h span flips to catchup with daysBack=3", () => {
    const result = deriveDigestPeriod({
      periodStart: "2026-05-13T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(result.kind).toBe("catchup");
    expect(result.daysBack).toBe(3);
    expect(result.rangeLabel).toMatch(/→/);
  });

  test("7-day span yields daysBack=7", () => {
    const result = deriveDigestPeriod({
      periodStart: "2026-05-09T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(result.kind).toBe("catchup");
    expect(result.daysBack).toBe(7);
  });

  test("non-integer day span is ceiled (49h → catchup, daysBack=3)", () => {
    // 49h = 1h past the daily threshold. ceil(49 / 24) = 3.
    const result = deriveDigestPeriod({
      periodStart: "2026-05-13T23:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(result.kind).toBe("catchup");
    expect(result.daysBack).toBe(3);
  });

  test("catchup label includes both endpoints, daily label includes only end", () => {
    const catchup = deriveDigestPeriod({
      periodStart: "2026-05-09T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(catchup.rangeLabel).toContain("→");

    const daily = deriveDigestPeriod({
      periodStart: "2026-05-15T00:00:00Z",
      periodEnd: "2026-05-16T00:00:00Z",
    });
    expect(daily.rangeLabel).not.toContain("→");
  });
});
