import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { type DiscoveryEvent, type DiscoveryInput, runDiscoveryAgent } from "./agent";
import type { DiscoveryToolExecutionResult } from "./tools";

// Agent-loop tests. The Anthropic client and tool executor are both stubbed
// so the loop is exercised in isolation — no Firecrawl, no Postgres, no
// network. Each test scripts a sequence of canned model responses and a
// canned tool-result envelope.

const INPUT: DiscoveryInput = {
  competitorId: "11111111-1111-1111-1111-111111111111",
  competitorName: "Acme",
  homepageUrl: "https://acme.example",
  runId: "22222222-2222-2222-2222-222222222222",
};

// A minimal Anthropic.Message shape — enough for the loop to walk content
// blocks, push them into history, and inspect stop_reason. We don't need the
// real SDK types here because the loop reads `response.content`,
// `response.stop_reason`, and `response.usage` only.
function buildResponse(opts: {
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  stopReason?: Anthropic.Message["stop_reason"];
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (opts.text) {
    content.push({
      type: "text",
      text: opts.text,
      citations: [],
    } as Anthropic.TextBlock);
  }
  for (const tu of opts.toolUses ?? []) {
    content.push({
      type: "tool_use",
      id: tu.id,
      name: tu.name,
      input: tu.input,
    } as Anthropic.ToolUseBlock);
  }
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content,
    stop_reason: opts.stopReason ?? (opts.toolUses?.length ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    } as Anthropic.Usage,
    container: null,
  } as unknown as Anthropic.Message;
}

function stubClient(responses: Anthropic.Message[]): {
  client: { messages: { create: () => Promise<Anthropic.Message> } };
  calls: number;
} {
  let i = 0;
  const calls = { n: 0 };
  const client = {
    messages: {
      create: async (): Promise<Anthropic.Message> => {
        calls.n++;
        const r = responses[i++];
        if (!r) throw new Error(`stub: no canned response at index ${i - 1}`);
        return r;
      },
    },
  };
  return {
    client,
    get calls() {
      return calls.n;
    },
  } as never;
}

describe("discovery agent loop", () => {
  test("finish() terminates the loop and records summary", async () => {
    const events: DiscoveryEvent[] = [];
    const { client } = stubClient([
      buildResponse({
        text: "Scanning Acme's homepage.",
        toolUses: [{ id: "t1", name: "finish", input: { summary: "found nothing" } }],
      }),
    ]);

    const result = await runDiscoveryAgent(INPUT, (e) => events.push(e), {
      client,
      executeTool: async (_ctx, name, _input): Promise<DiscoveryToolExecutionResult> => {
        if (name === "finish") {
          return {
            content: "ok",
            isError: false,
            finished: true,
            finishSummary: "found nothing",
            payload: { summary: "found nothing" },
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
      recordUsage: async () => {},
    });

    expect(result.finishedReason).toBe("finish");
    expect(result.finishSummary).toBe("found nothing");
    expect(result.iterations).toBe(1);
    expect(result.clientToolCalls).toBe(1);
    expect(result.sourcesRecorded).toBe(0);
    expect(events[0]?.kind).toBe("run_started");
    expect(events.at(-1)?.kind).toBe("run_finished");
  });

  test("sourcesRecorded counts only new (non-duplicate) record_source results", async () => {
    const { client } = stubClient([
      buildResponse({
        toolUses: [
          {
            id: "t1",
            name: "record_source",
            input: { source_type: "rss", url_or_handle: "https://a/feed", rationale: "x" },
          },
        ],
      }),
      buildResponse({
        toolUses: [
          {
            id: "t2",
            name: "record_source",
            input: { source_type: "rss", url_or_handle: "https://a/feed", rationale: "x" },
          },
        ],
      }),
      buildResponse({
        toolUses: [{ id: "t3", name: "finish", input: { summary: "done" } }],
      }),
    ]);

    let call = 0;
    const result = await runDiscoveryAgent(INPUT, undefined, {
      client,
      executeTool: async (_ctx, name): Promise<DiscoveryToolExecutionResult> => {
        if (name === "finish") {
          return {
            content: "ok",
            isError: false,
            finished: true,
            finishSummary: "done",
            payload: {},
          };
        }
        if (name === "record_source") {
          call++;
          // First call: new row. Second call: duplicate (same url_or_handle).
          const isNew = call === 1;
          return {
            content: isNew ? "Recorded." : "Already recorded.",
            isError: false,
            recordedNewSource: isNew,
            payload: { duplicate: !isNew },
          };
        }
        throw new Error(`unexpected ${name}`);
      },
      recordUsage: async () => {},
    });

    expect(result.sourcesRecorded).toBe(1);
    expect(result.clientToolCalls).toBe(3);
    expect(result.finishedReason).toBe("finish");
  });

  test("no_progress trips after 3 consecutive turns with no new source", async () => {
    // Three identical record_source calls (all duplicates) → no progress for
    // 3 turns → loop bails with no_progress.
    const { client } = stubClient([
      buildResponse({
        toolUses: [
          {
            id: "t1",
            name: "record_source",
            input: { source_type: "rss", url_or_handle: "https://a/feed", rationale: "x" },
          },
        ],
      }),
      buildResponse({
        toolUses: [
          {
            id: "t2",
            name: "record_source",
            input: { source_type: "rss", url_or_handle: "https://a/feed", rationale: "x" },
          },
        ],
      }),
      buildResponse({
        toolUses: [
          {
            id: "t3",
            name: "record_source",
            input: { source_type: "rss", url_or_handle: "https://a/feed", rationale: "x" },
          },
        ],
      }),
    ]);

    const result = await runDiscoveryAgent(INPUT, undefined, {
      client,
      executeTool: async (): Promise<DiscoveryToolExecutionResult> => ({
        content: "dup",
        isError: false,
        recordedNewSource: false,
        payload: { duplicate: true },
      }),
      recordUsage: async () => {},
    });

    expect(result.finishedReason).toBe("no_progress");
    expect(result.sourcesRecorded).toBe(0);
    expect(result.clientToolCalls).toBe(3);
    expect(result.iterations).toBe(3);
  });

  test("end_turn with zero tool_uses terminates immediately", async () => {
    const { client } = stubClient([
      buildResponse({ text: "Nothing to do.", stopReason: "end_turn" }),
    ]);
    const result = await runDiscoveryAgent(INPUT, undefined, {
      client,
      executeTool: async (): Promise<DiscoveryToolExecutionResult> => {
        throw new Error("should not be called");
      },
      recordUsage: async () => {},
    });
    expect(result.finishedReason).toBe("end_turn");
    expect(result.clientToolCalls).toBe(0);
  });

  test("tool executor throw is captured as an in-band error result", async () => {
    const events: DiscoveryEvent[] = [];
    const { client } = stubClient([
      buildResponse({
        toolUses: [{ id: "t1", name: "fetch_page", input: { url: "https://x" } }],
      }),
      buildResponse({ text: "stopping", stopReason: "end_turn" }),
    ]);

    const result = await runDiscoveryAgent(INPUT, (e) => events.push(e), {
      client,
      executeTool: async () => {
        throw new Error("network exploded");
      },
      recordUsage: async () => {},
    });

    expect(result.finishedReason).toBe("end_turn");
    const toolResults = events.filter((e) => e.kind === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.kind === "tool_result" && toolResults[0].isError).toBe(true);
  });
});
