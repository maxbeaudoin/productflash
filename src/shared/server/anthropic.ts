import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "./env";

// Lazy singleton — defer construction until first call so env validation
// errors surface at use-time, not import-time (matches getDb / getPool).

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";
