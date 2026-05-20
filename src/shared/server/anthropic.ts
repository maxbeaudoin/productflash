import Anthropic from "@anthropic-ai/sdk";
import * as anthropicSdk from "@anthropic-ai/sdk";
import { requireEnv } from "./env";
import { getAnthropicInstrumentation } from "./otel";

// Lazy singleton — defer construction until first call so env validation
// errors surface at use-time, not import-time (matches getDb / getPool).

let _client: Anthropic | undefined;

export function getAnthropic(): Anthropic {
  if (!_client) {
    patchAnthropicForLangfuse();
    _client = new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  }
  return _client;
}

let _patched = false;

/**
 * Apply OpenInference's manual patch to the Anthropic SDK so messages.create
 * calls produce rich Langfuse generation spans (input messages, output, tool
 * calls, tokens). OpenInference's auto-patch only fires under CJS require();
 * under ESM (tsx default for our worker + *:run scripts) we have to call
 * `manuallyInstrument` ourselves.
 *
 * **Gotcha (PF-103):** the patch replaces the original APIPromise return
 * value with a plain `Promise.then().catch()` chain, which drops APIPromise
 * methods including `.withResponse()`. `Messages.prototype.stream()` calls
 * `create({stream:true}).withResponse()` internally, so any streaming caller
 * (the FTE agent) throws `withResponse is not a function`. We fix that by
 * re-patching after OpenInference: for `stream:true` requests, delegate to
 * the saved-pre-patch original; otherwise route through OpenInference for the
 * rich span. Streaming calls fall back to raw HTTP POST spans — acceptable
 * loss for now (streaming is just FTE; everything else is non-streaming).
 */
function patchAnthropicForLangfuse(): void {
  if (_patched) return;
  const instr = getAnthropicInstrumentation();
  if (!instr) {
    _patched = true;
    return;
  }
  // Resolve Messages class the same way OpenInference's patch() does.
  const mod = anthropicSdk as Record<string, unknown>;
  const root = ((mod.default as Record<string, unknown> | undefined) ?? mod) as {
    Messages?: { prototype: { create: (...a: unknown[]) => unknown } };
  };
  const messagesProto = root.Messages?.prototype;
  if (!messagesProto) {
    _patched = true;
    return;
  }
  const originalCreate = messagesProto.create;
  instr.manuallyInstrument(anthropicSdk as never);
  const patchedCreate = messagesProto.create;
  messagesProto.create = function (...args: unknown[]) {
    const opts = args[0] as { stream?: boolean } | undefined;
    if (opts?.stream === true) {
      return originalCreate.apply(this, args);
    }
    return patchedCreate.apply(this, args);
  };
  _patched = true;
}

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-4-6";
