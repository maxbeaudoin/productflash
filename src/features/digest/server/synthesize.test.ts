import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SynthesisInput, SynthesisInputItem } from "./synthesize";

const anthropicMock = vi.hoisted(() => ({
  messages: { create: vi.fn() },
}));
vi.mock("~/shared/server/anthropic", () => ({
  getAnthropic: () => anthropicMock,
  SONNET_MODEL: "claude-sonnet-4-6",
  HAIKU_MODEL: "claude-haiku-4-5-20251001",
}));
vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { synthesizeDigest } = await import("./synthesize");

function inputItem(
  rawItemId: string,
  overrides: Partial<SynthesisInputItem> = {},
): SynthesisInputItem {
  return {
    rawItemId,
    competitorName: "Acme Corp",
    source: "rss",
    url: `https://example.com/${rawItemId}`,
    title: `title ${rawItemId}`,
    body: "body",
    publishedAt: new Date("2026-05-16T00:00:00Z"),
    category: "launch",
    score: 80,
    why: "because",
    ...overrides,
  };
}

function sonnetResponse(toolInput: unknown, usage?: Partial<Anthropic.Usage>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 2000, output_tokens: 800, ...usage },
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "record_digest",
        input: toolInput,
      },
    ],
  } as Anthropic.Message;
}

const BASE_INPUT: SynthesisInput = {
  userName: "Beta User",
  reader: null,
  items: [inputItem("raw-1"), inputItem("raw-2")],
};

beforeEach(() => {
  anthropicMock.messages.create.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("synthesizeDigest — short-circuit", () => {
  test("empty input → empty items, no SDK call (saves a $0.02 Sonnet hit)", async () => {
    const result = await synthesizeDigest({ ...BASE_INPUT, items: [] });
    expect(result).toEqual({ items: [], usage: null });
    expect(anthropicMock.messages.create).not.toHaveBeenCalled();
  });
});

describe("synthesizeDigest — happy path parsing", () => {
  test("valid tool_use produces SynthesizedItem array, rawItemId preserved verbatim", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [
          {
            rawItemId: "raw-1",
            headline: "Acme launches new pricing tier",
            snippet: "Acme today introduced a new $99/mo professional plan.",
            impactNote: "Direct competition with our Pro plan.",
          },
          {
            rawItemId: "raw-2",
            headline: "Acme acquires WidgetCo",
            snippet: "All-stock deal closed yesterday.",
            impactNote: "Expands their adjacent surface area.",
          },
        ],
      }),
    );
    const result = await synthesizeDigest(BASE_INPUT);
    expect(result.items.map((i) => i.rawItemId)).toEqual(["raw-1", "raw-2"]);
    expect(result.items[0]!.headline).toBe("Acme launches new pricing tier");
    expect(result.usage).not.toBeNull();
  });

  test("trims headline / snippet / impactNote", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [
          {
            rawItemId: "raw-1",
            headline: "  trimmed headline  ",
            snippet: "   trimmed snippet   ",
            impactNote: "   trimmed impact   ",
          },
          {
            rawItemId: "raw-2",
            headline: "h2",
            snippet: "s2",
            impactNote: "i2",
          },
        ],
      }),
    );
    const result = await synthesizeDigest(BASE_INPUT);
    expect(result.items[0]).toMatchObject({
      headline: "trimmed headline",
      snippet: "trimmed snippet",
      impactNote: "trimmed impact",
    });
  });

  test("captures Anthropic usage envelope on success", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse(
        {
          items: [
            { rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "i" },
            { rawItemId: "raw-2", headline: "h", snippet: "s", impactNote: "i" },
          ],
        },
        { input_tokens: 1234, output_tokens: 567 },
      ),
    );
    const result = await synthesizeDigest(BASE_INPUT);
    expect(result.usage).toMatchObject({
      model: "claude-sonnet-4-6",
      inputTokens: 1234,
      outputTokens: 567,
    });
  });
});

describe("synthesizeDigest — output validation", () => {
  test("rawItemId not in expected set is rejected (model hallucinated an id)", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [
          { rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "i" },
          { rawItemId: "raw-FAKE", headline: "h", snippet: "s", impactNote: "i" },
        ],
      }),
    );
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/invalid or unexpected rawItemId/);
  });

  test("duplicate rawItemId is rejected (model emitted the same item twice)", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [
          { rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "i" },
          { rawItemId: "raw-1", headline: "h2", snippet: "s2", impactNote: "i2" },
        ],
      }),
    );
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/duplicate rawItemId/);
  });

  test("empty headline is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [{ rawItemId: "raw-1", headline: "   ", snippet: "s", impactNote: "i" }],
      }),
    );
    await expect(synthesizeDigest({ ...BASE_INPUT, items: [inputItem("raw-1")] })).rejects.toThrow(
      /invalid headline/,
    );
  });

  test("empty snippet is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [{ rawItemId: "raw-1", headline: "h", snippet: "", impactNote: "i" }],
      }),
    );
    await expect(synthesizeDigest({ ...BASE_INPUT, items: [inputItem("raw-1")] })).rejects.toThrow(
      /invalid snippet/,
    );
  });

  test("empty impactNote is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [{ rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "" }],
      }),
    );
    await expect(synthesizeDigest({ ...BASE_INPUT, items: [inputItem("raw-1")] })).rejects.toThrow(
      /invalid impactNote/,
    );
  });

  test("items field missing or not an array is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(sonnetResponse({ items: "string" }));
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/items field not an array/);
  });

  test("tool input null is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(sonnetResponse(null));
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/tool input not an object/);
  });

  test("response with no tool_use block is rejected", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 40 },
      content: [{ type: "text", text: "I refuse to use tools" }],
    } as Anthropic.Message);
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/no tool_use block/);
  });

  test("partial output (model returned 1 of 2 expected items) is accepted as-is", async () => {
    // The synthesizer's contract: out-of-set ids are rejected, but a short
    // result set isn't — the caller decides whether N-of-M output is OK.
    // This pins that to prevent a future "must match input length" check
    // from silently breaking the empty-digest path.
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [{ rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "i" }],
      }),
    );
    const result = await synthesizeDigest(BASE_INPUT);
    expect(result.items).toHaveLength(1);
  });
});

describe("synthesizeDigest — retry policy", () => {
  test("retries on 429, succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("rate limited"), { status: 429 });
    anthropicMock.messages.create.mockRejectedValueOnce(transient).mockResolvedValueOnce(
      sonnetResponse({
        items: [
          { rawItemId: "raw-1", headline: "h", snippet: "s", impactNote: "i" },
          { rawItemId: "raw-2", headline: "h", snippet: "s", impactNote: "i" },
        ],
      }),
    );
    const pending = synthesizeDigest(BASE_INPUT);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.items).toHaveLength(2);
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(2);
  });

  test("parse errors are not retried (re-rolling the same prompt is wasted spend)", async () => {
    anthropicMock.messages.create.mockResolvedValueOnce(
      sonnetResponse({
        items: [{ rawItemId: "raw-FAKE", headline: "h", snippet: "s", impactNote: "i" }],
      }),
    );
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toThrow(/invalid or unexpected rawItemId/);
    expect(anthropicMock.messages.create).toHaveBeenCalledOnce();
  });

  test("non-retriable 4xx surfaces immediately", async () => {
    const fatal = Object.assign(new Error("bad request"), { status: 400 });
    anthropicMock.messages.create.mockRejectedValueOnce(fatal);
    await expect(synthesizeDigest(BASE_INPUT)).rejects.toBe(fatal);
    expect(anthropicMock.messages.create).toHaveBeenCalledOnce();
  });

  test("exhausts retries then throws the last transient error", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("still down"), { status: 503 });
    anthropicMock.messages.create.mockRejectedValue(transient);
    const pending = synthesizeDigest(BASE_INPUT);
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).rejects.toBe(transient);
    // MAX_RETRIES=2 → 3 total attempts.
    expect(anthropicMock.messages.create).toHaveBeenCalledTimes(3);
  });
});
