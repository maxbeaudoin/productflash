import { describe, expect, test } from "vitest";
import { formatUsd } from "./llm-cost-format";

// Used by the admin cost tables. The thresholds matter: at sub-cent we
// want 4 decimals so a $0.0008 classify call is visible, not collapsed
// to "$0.00".

describe("formatUsd", () => {
  test('zero is always "$0.00"', () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  test("sub-cent shows 4 decimals so per-call costs are visible", () => {
    // 800 µUSD = $0.0008.
    expect(formatUsd(800)).toBe("$0.0008");
  });

  test("cent-to-dollar range shows 3 decimals", () => {
    // 50,000 µUSD = $0.05.
    expect(formatUsd(50_000)).toBe("$0.050");
  });

  test("above $1 shows 2 decimals", () => {
    // 1,234,567 µUSD = $1.234567 → "$1.23".
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  test("exactly $0.01 lands in the 3-decimal bucket (< 1 USD)", () => {
    expect(formatUsd(10_000)).toBe("$0.010");
  });

  test("exactly $1.00 lands in the 2-decimal bucket", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
  });
});
