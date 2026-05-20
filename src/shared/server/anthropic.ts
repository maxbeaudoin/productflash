import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";

// Lazy singleton — defer construction until first call so env validation
// errors surface at use-time, not import-time (matches getDb / getPool).
//
// OTEL instrumentation: the AnthropicInstrumentation from OpenInference is
// wired upfront in src/shared/server/otel.ts (Langfuse's canonical pattern,
// see https://langfuse.com/integrations/model-providers/anthropic-js). No
// per-client patching needed here.

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";
