// Langfuse-aware span helper (PF-103).
//
// Wraps `startActiveObservation` from @langfuse/tracing so our custom spans
// (pg-boss job handlers, source-adapter fetches) are emitted under the
// Langfuse tracer scope. That matters because LangfuseSpanProcessor's default
// `isDefaultExportSpan` filter keeps only Langfuse-tracer / gen_ai-tagged /
// known-LLM-scope spans — generic OTEL spans from `@opentelemetry/api`
// would be dropped. (We also override `shouldExportSpan: () => true` in
// otel.ts so pg/http auto-instrumented spans surface for full tracing, but
// Langfuse-native spans render with proper input/output/asType in the UI.)
//
// API kept compatible with the previous OTEL-based `withSpan` so callers
// don't need to change. The optional `input` argument maps to Langfuse's
// observation input field (shown side-by-side with output in the UI).

import { trace } from "@opentelemetry/api";
import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
  type LangfuseSpan,
  type LangfuseTool,
} from "@langfuse/tracing";

type SpanMetadata = Record<string, string | number | boolean | undefined>;

export async function withSpan<T>(
  name: string,
  fn: (span: LangfuseSpan) => Promise<T>,
  metadata?: SpanMetadata,
): Promise<T> {
  // When this is the FIRST withSpan in the call stack (no active span yet),
  // we're starting a new trace — propagate `traceName` so Langfuse renders
  // the top-level trace with a useful name instead of "<unnamed>". For
  // nested withSpan calls we let the parent's trace name flow through.
  const isRoot = trace.getActiveSpan() === undefined;

  async function runObservation(span: LangfuseSpan): Promise<T> {
    // Render metadata as the observation `input` (prominent top-of-detail
    // panel) instead of nested `metadata` (which requires drilling). Same
    // values, much faster to scan when triaging a trace. PF-103 #6.
    if (metadata) span.update({ input: metadata, metadata });
    // Mirror onto the trace itself so the Langfuse trace landing page shows
    // the trigger/job context without opening the root observation.
    if (isRoot && metadata) setActiveTraceIO({ input: metadata });
    try {
      const result = await fn(span);
      if (result !== undefined && isPlainSerializable(result)) {
        span.update({ output: result });
        if (isRoot) setActiveTraceIO({ output: result });
      }
      return result;
    } catch (err) {
      span.update({
        level: "ERROR",
        statusMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  const run = () => startActiveObservation(name, runObservation);
  if (isRoot) {
    return propagateAttributes({ traceName: name }, run);
  }
  return run();
}

/**
 * Wrap an agent tool execution as a Langfuse `tool` observation. Renders with
 * the tool icon in the trace tree and pairs input ↔ output side-by-side in the
 * detail panel. Used by FTE + discovery agent tool dispatchers.
 */
export async function withToolSpan<T>(
  name: string,
  input: unknown,
  fn: (span: LangfuseTool) => Promise<T>,
): Promise<T> {
  return startActiveObservation(
    `tool: ${name}`,
    async (tool) => {
      tool.update({ input });
      try {
        const result = await fn(tool);
        if (result !== undefined && isPlainSerializable(result)) {
          tool.update({ output: result });
        }
        return result;
      } catch (err) {
        tool.update({
          level: "ERROR",
          statusMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
    { asType: "tool" },
  );
}

function isPlainSerializable(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(value)) return true;
  if (t === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return true;
  }
  return false;
}
