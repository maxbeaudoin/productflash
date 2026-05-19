import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, SONNET_MODEL } from "~/shared/server/anthropic";
import { recordLlmUsage } from "~/shared/server/llm-cost";
import { logger } from "~/shared/server/logger";
import {
  DISCOVERY_TOOLS,
  type DiscoveryToolContext,
  type DiscoveryToolExecutionResult,
  executeTool as defaultExecuteTool,
} from "./tools";

// Per-competitor source-discovery agent (PF-95 / PF-93 phase 2).
//
// Sonnet drives a tool-use loop. Tools:
//   - Server: web_search_20250305 — Anthropic-hosted, mirrors FTE agent.
//   - Client: fetch_page (Firecrawl), fetch_sitemap, probe_rss, record_source,
//             finish. Each `record_source` writes a `competitor_sources` row
//             immediately (active, no admin gate).
//
// Termination:
//   - `finish` called → finishedReason = 'finish'.
//   - MAX_TOOL_CALLS or MAX_ITERATIONS tripped → finishedReason names which.
//   - NO_PROGRESS_TURNS consecutive iterations without a new source recorded
//     → finishedReason = 'no_progress'. Guards against the agent looping on
//     duplicate record_source calls or wandering off-task.

const MAX_ITERATIONS = 18;
const MAX_TOOL_CALLS = 25;
const MAX_OUTPUT_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 4;
const NO_PROGRESS_TURNS = 3;

export interface DiscoveryInput {
  competitorId: string;
  competitorName: string;
  homepageUrl: string;
  runId: string;
}

export type DiscoveryFinishedReason =
  | "finish"
  | "max_iterations"
  | "max_tool_calls"
  | "no_progress"
  | "end_turn"
  | "error"
  | "unknown";

export interface DiscoveryResult {
  iterations: number;
  clientToolCalls: number;
  serverToolCalls: number;
  sourcesRecorded: number;
  finishedReason: DiscoveryFinishedReason;
  finishSummary: string | null;
}

export type DiscoveryEvent =
  | { kind: "iteration"; n: number }
  | { kind: "planner_text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      payload: Record<string, unknown>;
    }
  | { kind: "server_tool_use"; id: string; name: string; input: unknown }
  | { kind: "server_tool_result"; id: string; summary: { count: number; urls: string[] } }
  | { kind: "error"; message: string }
  | { kind: "run_started"; input: DiscoveryInput }
  | { kind: "run_finished"; result: DiscoveryResult };

// Anthropic SDK 0.40 doesn't type the web_search server tool's response
// blocks. Treat them as opaque pass-throughs.
interface UnknownBlock {
  type: string;
  [key: string]: unknown;
}

type AnyContentBlock = Anthropic.ContentBlock | UnknownBlock;

interface MessagesCreateClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface DiscoveryRunOptions {
  // Optional Anthropic client override — primarily for tests. Defaults to the
  // module-level singleton.
  client?: MessagesCreateClient;
  // Optional tool executor override — also for tests. Defaults to executeTool
  // from ./tools, which talks to Firecrawl + the DB.
  executeTool?: typeof defaultExecuteTool;
  // Optional usage recorder override. Defaults to recordLlmUsage; set to a
  // noop to skip the per-iteration DB write in tests.
  recordUsage?: typeof recordLlmUsage;
}

const SYSTEM_PROMPT = [
  "You are the source-discovery agent for Product Flash, a daily competitive-intel digest. Your job: given one competitor's name + homepage, discover the typed sources that will feed our pipeline.",
  "",
  "You record 0..N sources per competitor via record_source. Source types:",
  "  • rss      — RSS or Atom feed URL. Verify with probe_rss before recording.",
  "  • webpage  — A page that signals new product moves (e.g. /blog, /changelog, /news, /releases). Static or list-style — the watcher decides at first fetch.",
  "  • x / linkedin / youtube — Recorded inert (URL captured, no fetcher yet). Use these for social handles found in the homepage footer/header.",
  "",
  "Method:",
  "  1. fetch_page the homepage. Note the navigation, the footer, and any 'Resources'/'Company' panels.",
  "  2. As soon as you spot a /blog or /changelog or /news URL that fetches successfully (any plausible signal page), call record_source with source_type='webpage' for it. Don't wait until the end — record incrementally.",
  "  3. Look for 'Subscribe' / 'RSS' links, or candidate paths (/feed, /rss, /blog/feed, /changelog.rss). Use probe_rss to confirm before recording as rss. probe_rss returning is_feed:false means skip — don't record.",
  "  4. Sweep the footer for social links — X/Twitter, LinkedIn, YouTube. Record each as the matching social source_type the moment you see it.",
  "  5. If you can't find a blog/changelog on the homepage, try fetch_sitemap on the homepage origin. The sitemap usually lists every blog/changelog post.",
  "  6. If still nothing, use web_search for '<competitor name> changelog' or '<competitor name> blog rss'.",
  "  7. When you have everything meaningful, call finish.",
  "",
  "Rules:",
  "  • Record incrementally, not in a batch. Every fetch_page that returns content for a plausible signal page (blog/changelog/news/releases) should be followed by record_source for that URL — same turn if possible.",
  "  • Never record_source a URL you haven't seen evidence of (footer link, sitemap entry, search result, probe). No guesses.",
  "  • Always include a one-line rationale ('changelog page linked in footer', 'X handle from homepage footer').",
  "  • record_source is idempotent — duplicate calls are no-ops, don't retry on duplicate hits.",
  "  • You have a budget of about 25 tool calls. Use them well; finish early if you've covered the obvious sources.",
  "  • If three iterations go by without you recording a new source, the run will be terminated as 'no_progress'. Don't stall — if you have one verified source, record it before doing more exploration.",
  "  • Cards (text blocks you emit) are observations, not narration. ≤ 1 sentence each. Never lead with filler; never narrate tool calls. Often emit nothing and just call the next tool.",
].join("\n");

export async function runDiscoveryAgent(
  input: DiscoveryInput,
  onEvent?: (event: DiscoveryEvent) => void,
  options: DiscoveryRunOptions = {},
): Promise<DiscoveryResult> {
  const { competitorId, competitorName, homepageUrl, runId } = input;
  const client: MessagesCreateClient = options.client ?? getAnthropic();
  const execute = options.executeTool ?? defaultExecuteTool;
  const recordUsage = options.recordUsage ?? recordLlmUsage;
  const emit = onEvent ?? (() => {});

  emit({ kind: "run_started", input });

  const tools: Anthropic.Tool[] = [
    ...DISCOVERY_TOOLS,
    // Same shape FTE uses for the server-hosted web_search tool.
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: WEB_SEARCH_MAX_USES,
    } as unknown as Anthropic.Tool,
  ];

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: renderInitialUserMessage({ competitorName, homepageUrl }),
    },
  ];

  const ctx: DiscoveryToolContext = { competitorId, competitorName, homepageUrl };

  let iterations = 0;
  let clientToolCalls = 0;
  let serverToolCalls = 0;
  let sourcesRecorded = 0;
  let consecutiveNoProgress = 0;
  let finishedReason: DiscoveryFinishedReason = "unknown";
  let finishSummary: string | null = null;

  try {
    outer: while (iterations < MAX_ITERATIONS) {
      iterations++;
      emit({ kind: "iteration", n: iterations });

      const response = await client.messages.create({
        model: SONNET_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      // Best-effort cost accounting. Failures here should never break the run.
      // `runId` correlates every iteration's usage rows (llm_usage has no
      // competitor column — keeping the schema unchanged for phase 2).
      try {
        await recordUsage({ kind: "discovery", model: SONNET_MODEL, runId }, response.usage);
      } catch (err) {
        logger.warn({ err, competitorId, runId }, "discovery: recordUsage failed");
      }

      const blocks = response.content as AnyContentBlock[];
      messages.push({
        role: "assistant",
        content: blocks as unknown as Anthropic.ContentBlockParam[],
      });

      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      for (const block of blocks) {
        if (block.type === "text") {
          const text = (block as Anthropic.TextBlock).text.trim();
          if (text.length > 0) emit({ kind: "planner_text", text });
        } else if (block.type === "tool_use") {
          const tu = block as Anthropic.ToolUseBlock;
          toolUses.push({ id: tu.id, name: tu.name, input: tu.input });
          emit({ kind: "tool_use", id: tu.id, name: tu.name, input: tu.input });
        } else if (block.type === "server_tool_use") {
          serverToolCalls++;
          const b = block as UnknownBlock;
          emit({
            kind: "server_tool_use",
            id: String(b.id),
            name: String(b.name),
            input: b.input,
          });
        } else if (block.type === "web_search_tool_result") {
          const b = block as UnknownBlock;
          emit({
            kind: "server_tool_result",
            id: String(b.tool_use_id),
            summary: summarizeWebSearchResult(b.content),
          });
        }
        // Other block types are ignored — discovery doesn't need thinking
        // blocks (extended thinking is off) and we don't surface unknown
        // shapes to the transcript.
      }

      if (response.stop_reason === "end_turn" && toolUses.length === 0) {
        finishedReason = "end_turn";
        break outer;
      }

      if (clientToolCalls + toolUses.length > MAX_TOOL_CALLS) {
        finishedReason = "max_tool_calls";
        break outer;
      }

      let progressedThisIteration = false;
      const resultBlocks: Anthropic.ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        clientToolCalls++;
        let result: DiscoveryToolExecutionResult;
        try {
          result = await execute(ctx, tu.name, tu.input);
        } catch (err) {
          // executeTool is supposed to return errors in-band; defend against
          // an unhandled throw so the loop can keep going.
          result = {
            content: `tool '${tu.name}' threw: ${describeError(err)}`,
            isError: true,
            payload: { name: tu.name, error: describeError(err) },
          };
        }
        emit({
          kind: "tool_result",
          id: tu.id,
          name: tu.name,
          isError: result.isError,
          payload: result.payload,
        });
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.content,
          is_error: result.isError,
        });

        if (result.recordedNewSource) {
          sourcesRecorded++;
          progressedThisIteration = true;
        }
        if (result.finished) {
          finishedReason = "finish";
          finishSummary = result.finishSummary ?? null;
          // Drain remaining tool uses into result blocks before exiting so
          // the conversation stays well-formed, then break.
        }
      }

      // The model can interleave a finish() with other tool calls; if it
      // did, we still want the conversation to close cleanly after we
      // resolve every result. Push the user-role tool_result turn so the
      // model's last assistant message has a partner, then break.
      messages.push({ role: "user", content: resultBlocks });

      if (finishedReason === "finish") break outer;

      consecutiveNoProgress = progressedThisIteration ? 0 : consecutiveNoProgress + 1;
      if (consecutiveNoProgress >= NO_PROGRESS_TURNS) {
        finishedReason = "no_progress";
        break outer;
      }

      if (iterations >= MAX_ITERATIONS) {
        finishedReason = "max_iterations";
        break outer;
      }
    }

    if (finishedReason === "unknown" && iterations >= MAX_ITERATIONS) {
      finishedReason = "max_iterations";
    }
  } catch (err) {
    finishedReason = "error";
    logger.error({ err, competitorId, runId }, "discovery: agent loop threw");
    emit({ kind: "error", message: describeError(err) });
  }

  const result: DiscoveryResult = {
    iterations,
    clientToolCalls,
    serverToolCalls,
    sourcesRecorded,
    finishedReason,
    finishSummary,
  };
  emit({ kind: "run_finished", result });
  logger.info(
    {
      competitorId,
      runId,
      iterations,
      clientToolCalls,
      serverToolCalls,
      sourcesRecorded,
      finishedReason,
    },
    "discovery: run complete",
  );
  return result;
}

function renderInitialUserMessage(input: { competitorName: string; homepageUrl: string }): string {
  return [
    "Discover the sources for one competitor.",
    "",
    `  name: ${input.competitorName}`,
    `  homepage: ${input.homepageUrl}`,
    "",
    "Start by fetching the homepage. Record every meaningful source you verify (rss / webpage / x / linkedin / youtube), then call finish.",
  ].join("\n");
}

function summarizeWebSearchResult(content: unknown): { count: number; urls: string[] } {
  if (!Array.isArray(content)) return { count: 0, urls: [] };
  const urls: string[] = [];
  for (const entry of content) {
    if (entry && typeof entry === "object") {
      const url = (entry as Record<string, unknown>).url;
      if (typeof url === "string") urls.push(url);
    }
  }
  return { count: content.length, urls: urls.slice(0, 10) };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
