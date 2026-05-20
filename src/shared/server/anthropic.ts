import Anthropic from "@anthropic-ai/sdk";
import * as anthropicSdk from "@anthropic-ai/sdk";
import { requireEnv } from "./env";
import { getAnthropicInstrumentation } from "./otel";

// Lazy singleton — defer construction until first call so env validation
// errors surface at use-time, not import-time (matches getDb / getPool).

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    // PF-103: OpenInference's auto-patch only fires under CJS require(); when
    // the codebase runs as ESM (tsx default for `pnpm worker` / `pnpm *:run`
    // scripts), we manually instrument the Anthropic SDK so its messages
    // calls land as rich generation spans (input/output/tool-calls/tokens)
    // in Langfuse instead of raw HTTP POSTs. Pass the module namespace —
    // patch() resolves `.default` first then walks to `.Messages.prototype`.
    // Idempotent + no-op when OTEL is disabled.
    const instr = getAnthropicInstrumentation();
    if (instr) instr.manuallyInstrument(anthropicSdk as never);

    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";
