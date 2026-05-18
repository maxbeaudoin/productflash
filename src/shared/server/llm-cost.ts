import type Anthropic from "@anthropic-ai/sdk";
import { llmUsage, type NewLlmUsage } from "~/db/schema";
import { HAIKU_MODEL, SONNET_MODEL } from "./anthropic";
import { getDb } from "./db";
import { logger } from "./logger";

// Per-call accounting for every Anthropic API hit. Records token counts +
// frozen USD cost into llm_usage so the admin UI can roll up:
//   - per FTE run (kind='fte', filter by runId)
//   - per digest (kind='synthesize', filter by digestId)
//   - lifetime per user (filter by userId)
//
// Pricing is frozen at insert time as `cost_micro_usd` (1e-6 USD). That way
// historical totals stay accurate when Anthropic's published rates move; we
// still keep the raw token columns so we could re-price retroactively.
//
// Errors writing the row are logged but never thrown — accounting must not
// break a successful classify/synthesize/agent call.

export type LlmUsageKind = "fte" | "classify" | "synthesize";

// Per-million-token rates in USD, sourced from Anthropic's public pricing.
// Cache rates: writes at 1.25x base input, reads at 0.1x base input.
// Web search server tool: $10 per 1000 requests.
interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  [SONNET_MODEL]: {
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    cacheWritePerMillion: 3.75,
    cacheReadPerMillion: 0.3,
  },
  [HAIKU_MODEL]: {
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheWritePerMillion: 1.25,
    cacheReadPerMillion: 0.1,
  },
};

const WEB_SEARCH_PER_REQUEST = 10 / 1000;

// Anthropic's 0.40 SDK doesn't type server_tool_use on Usage yet; the API
// returns it for requests that invoked the web_search server tool. Treat
// the field as an opaque opt-in.
interface UsageWithServerTools extends Anthropic.Usage {
  server_tool_use?: {
    web_search_requests?: number | null;
  } | null;
}

export interface UsageContext {
  kind: LlmUsageKind;
  model: string;
  userId?: string | null;
  runId?: string | null;
  digestId?: string | null;
  rawItemId?: string | null;
}

export function computeCostMicroUsd(model: string, usage: UsageWithServerTools): number {
  const pricing = PRICING[model];
  if (!pricing) {
    logger.warn({ model }, "llm-cost: unknown model — recording usage with zero cost");
    return 0;
  }
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const webSearch = usage.server_tool_use?.web_search_requests ?? 0;

  const usd =
    (inputTokens / 1_000_000) * pricing.inputPerMillion +
    (outputTokens / 1_000_000) * pricing.outputPerMillion +
    (cacheWrite / 1_000_000) * pricing.cacheWritePerMillion +
    (cacheRead / 1_000_000) * pricing.cacheReadPerMillion +
    webSearch * WEB_SEARCH_PER_REQUEST;

  return Math.round(usd * 1_000_000);
}

export async function recordLlmUsage(
  ctx: UsageContext,
  usage: UsageWithServerTools | null | undefined,
): Promise<void> {
  if (!usage) return;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const webSearch = usage.server_tool_use?.web_search_requests ?? 0;
  const costMicroUsd = computeCostMicroUsd(ctx.model, usage);

  const row: NewLlmUsage = {
    userId: ctx.userId ?? null,
    kind: ctx.kind,
    model: ctx.model,
    inputTokens,
    outputTokens,
    cacheCreationTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    webSearchRequests: webSearch,
    costMicroUsd,
    runId: ctx.runId ?? null,
    digestId: ctx.digestId ?? null,
    rawItemId: ctx.rawItemId ?? null,
  };

  try {
    await getDb().insert(llmUsage).values(row);
  } catch (err) {
    // Accounting failures must never propagate to the caller — a missed
    // row is a reporting bug, not a pipeline failure.
    logger.warn({ err, ctx, costMicroUsd }, "llm-cost: failed to persist usage row");
  }
}
