// Thin OTEL tracer helpers (PF-103).
//
// Used to wrap pg-boss job handlers and source-adapter fetches in top-level
// spans so Langfuse shows a meaningful hierarchy:
//
//   ingest-run                       (worker handler span)
//     ingest.competitor              (per-competitor span)
//       rss.fetch                    (source-adapter span)
//       webpage.fetch                (source-adapter span)
//       firecrawl.scrape             (source-adapter span)
//   score-run
//     anthropic.messages.create      (auto-added by OpenInference)
//
// All spans live on the `productflash` tracer. The OTEL SDK itself is
// initialized in src/shared/server/otel.ts — importing this file alone
// does NOT start tracing (it just grabs a tracer handle which is a no-op
// when no SDK is registered).

import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

const tracer = trace.getTracer("productflash");

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
