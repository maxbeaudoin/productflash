import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the Anthropic client + llm-cost recorder + logger so classify.ts
// never touches network, db, or pino. We inject Haiku responses through
// the holder and assert against the parsed Classification.
const anthropicMock = vi.hoisted(() => ({
  messages: { create: vi.fn() },
}));
vi.mock("./anthropic", () => ({
  getAnthropic: () => anthropicMock,
  HAIKU_MODEL: "claude-haiku-4-5-20251001",
  SONNET_MODEL: "claude-sonnet-4-6",
}));

const recordLlmUsage = vi.hoisted(() => vi.fn());
vi.mock("./llm-cost", () => ({ recordLlmUsage }));

// logger.ts constructs pino at module load — short-circuit it entirely.
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { classifyItem } = await import("./classify");

const BASE_INPUT = {
  competitorName: "Acme Corp",
  source: "rss:acme",
  title: "Acme launches new pricing tier",
  body: "Acme today introduced a new $99/mo professional plan.",
  publishedAt: new Date("2026-05-16T00:00:00Z"),
};

function haikuResponse(toolInput: unknown): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 40 },
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "record_classification",
        input: toolInput,
      },
    ],
  } as Anthropic.Message;
}

beforeEach(() => {
  anthropicMock.messages.create.mockReset();
  recordLlmUsage.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("classifyItem — happy path parsing", () => {
  test("valid tool_use produces a Classification", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "pricing", score: 78, why: "New paid tier directly above ours." }),
    );
    const result = await classifyItem(BASE_INPUT);
    expect(result).toEqual({
      category: "pricing",
      score: 78,
      why: "New paid tier directly above ours.",
    });
  });

  test("score above 100 is clamped to 100", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "launch", score: 999, why: "Major launch." }),
    );
    const result = await classifyItem(BASE_INPUT);
    expect(result.score).toBe(100);
  });

  test("score below 0 is clamped to 0", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "noise", score: -42, why: "Recap." }),
    );
    const result = await classifyItem(BASE_INPUT);
    expect(result.score).toBe(0);
  });

  test("decimal score is rounded", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "feature", score: 73.7, why: "Polish." }),
    );
    const result = await classifyItem(BASE_INPUT);
    expect(result.score).toBe(74);
  });

  test("why is trimmed", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "feature", score: 50, why: "   leading + trailing   " }),
    );
    const result = await classifyItem(BASE_INPUT);
    expect(result.why).toBe("leading + trailing");
  });
});

describe("classifyItem — malformed responses surface errors", () => {
  test("unknown category throws", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "rumor", score: 50, why: "Speculative." }),
    );
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/invalid category/);
  });

  test("non-number score throws", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "launch", score: "high" as unknown as number, why: "Big." }),
    );
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/invalid score/);
  });

  test("NaN score throws", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "launch", score: NaN, why: "Big." }),
    );
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/invalid score/);
  });

  test("empty why throws", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "launch", score: 80, why: "   " }),
    );
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/invalid why/);
  });

  test("tool input as null throws", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(haikuResponse(null));
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/tool input not an object/);
  });

  test("response with no tool_use block throws (text-only fallback)", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 40 },
      content: [{ type: "text", text: "I refuse to use tools" }],
    } as Anthropic.Message);
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/no tool_use block/);
  });
});

describe("classifyItem — retry policy", () => {
  test("retries on 429, succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("rate limited"), { status: 429 });
    anthropicMock.messages.create
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(haikuResponse({ category: "feature", score: 60, why: "Polish." }));

    const pending = classifyItem(BASE_INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.category).toBe("feature");
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(2);
  });

  test("retries on 5xx, succeeds on third attempt", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("server error"), { status: 503 });
    anthropicMock.messages.create
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(haikuResponse({ category: "launch", score: 90, why: "Big." }));

    const pending = classifyItem(BASE_INPUT);
    // First backoff: 500ms. Second backoff: 1000ms.
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.score).toBe(90);
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(3);
  });

  test("non-retriable 4xx (other than 408/429) surfaces immediately, no retries", async () => {
    const fatal = Object.assign(new Error("bad request"), { status: 400 });
    anthropicMock.messages.create.mockRejectedValueOnce(fatal);

    await expect(classifyItem(BASE_INPUT)).rejects.toBe(fatal);
    expect(anthropicMock.messages.create).toHaveBeenCalledOnce();
  });

  test("parse error (malformed tool input) is not retried — surfaces on first call", async () => {
    // Distinguishes "the model misbehaved" from "the network blipped".
    // Re-rolling the same prompt is unlikely to help and burns tokens.
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "made-up", score: 50, why: "x" }),
    );
    await expect(classifyItem(BASE_INPUT)).rejects.toThrow(/invalid category/);
    expect(anthropicMock.messages.create).toHaveBeenCalledOnce();
  });

  test("exhausts retries and throws the last transient error", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("still down"), { status: 502 });
    anthropicMock.messages.create.mockRejectedValue(transient);

    const pending = classifyItem(BASE_INPUT);
    pending.catch(() => {}); // prevent unhandled-rejection warning during timer advancement
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).rejects.toBe(transient);
    // MAX_RETRIES=2 → 3 total attempts (initial + 2 retries).
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(3);
  });

  test("APIConnectionError name is treated as retriable", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("connect ECONNRESET"), {
      name: "APIConnectionError",
    });
    anthropicMock.messages.create
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(haikuResponse({ category: "feature", score: 50, why: "ok." }));

    const pending = classifyItem(BASE_INPUT);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(2);
  });
});

describe("classifyItem — accounting", () => {
  test("usageContext provided → recordLlmUsage called with the tagging fields", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "feature", score: 50, why: "ok." }),
    );
    await classifyItem({
      ...BASE_INPUT,
      usageContext: { userId: "user-1", rawItemId: "item-1" },
    });
    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
    expect(recordLlmUsage.mock.calls[0]![0]).toMatchObject({
      kind: "classify",
      userId: "user-1",
      rawItemId: "item-1",
    });
  });

  test("no usageContext → recordLlmUsage is skipped (script-style call, uncounted by design)", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      haikuResponse({ category: "feature", score: 50, why: "ok." }),
    );
    await classifyItem(BASE_INPUT);
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });
});
