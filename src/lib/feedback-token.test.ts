import { describe, expect, test } from "vitest";
import { signFeedbackToken, verifyFeedbackToken } from "./feedback-token";

describe("feedback-token", () => {
  const id = "11111111-1111-1111-1111-111111111111";

  test("verify accepts a freshly signed token", () => {
    const token = signFeedbackToken(id, "up");
    expect(verifyFeedbackToken(id, "up", token)).toBe(true);
  });

  test("signature is bound to the rating — flipping up→down invalidates", () => {
    const token = signFeedbackToken(id, "up");
    expect(verifyFeedbackToken(id, "down", token)).toBe(false);
  });

  test("signature is bound to the digest item id", () => {
    const token = signFeedbackToken(id, "up");
    const otherId = "22222222-2222-2222-2222-222222222222";
    expect(verifyFeedbackToken(otherId, "up", token)).toBe(false);
  });

  test("tampered single byte invalidates the signature", () => {
    const token = signFeedbackToken(id, "up");
    const mid = Math.floor(token.length / 2);
    const flipped = token.slice(0, mid) + (token[mid] === "A" ? "B" : "A") + token.slice(mid + 1);
    expect(verifyFeedbackToken(id, "up", flipped)).toBe(false);
  });

  test("different-length token is rejected without throwing", () => {
    expect(verifyFeedbackToken(id, "up", "short")).toBe(false);
    expect(verifyFeedbackToken(id, "up", "")).toBe(false);
  });

  test("up and down tokens differ", () => {
    const up = signFeedbackToken(id, "up");
    const down = signFeedbackToken(id, "down");
    expect(up).not.toBe(down);
  });
});
