// OTEL + Langfuse v5 SDK bootstrap (PF-103).
//
// MUST be imported as the very first line of any server entry point
// (src/worker/index.ts and the TanStack Start server entry via
// server/plugins/otel.ts) — auto-instrumentation patches via require/import
// hooks, so any SDK loaded before this module runs ends up uninstrumented.
//
// Reads raw process.env directly rather than the Zod env module to keep the
// bootstrap free of non-stdlib imports that would themselves need patching.
// The feature flag (OTEL_ENABLED) gates the entire side-effect so deploys
// without Langfuse credentials stay no-op.
//
// Stack:
//   - @opentelemetry/sdk-node — base OTEL SDK
//   - @opentelemetry/auto-instrumentations-node — pg/http/fetch auto-spans
//   - @arizeai/openinference-instrumentation-anthropic — captures Haiku /
//     Sonnet input messages, output messages, tool calls, token counts as
//     OTEL spans (Langfuse SDK v5 has openai + langchain auto-tracers but
//     no first-party Anthropic instrumentation; OpenInference fills that gap
//     and emits OTEL-spec spans that LangfuseSpanProcessor exports normally)
//   - @langfuse/otel — LangfuseSpanProcessor replaces the generic
//     OTLPTraceExporter so traces land in Langfuse with the right shape
//
// Backend: self-hosted Langfuse on Railway. LANGFUSE_BASE_URL points at the
// self-host; auth uses the public/secret key pair from the Langfuse project.

// Side-effect import: env.ts triggers dotenv loading, so subsequent
// process.env.* reads see .env values. env.ts itself imports no SDKs that
// need OTEL patching, so loading it before the NodeSDK starts is safe.
import "./env";

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const flag = process.env.OTEL_ENABLED;
const enabled = flag === "1" || flag === "true";

let sdk: NodeSDK | undefined;
let anthropicInstr: AnthropicInstrumentation | undefined;

/**
 * Expose the AnthropicInstrumentation instance so `src/shared/server/anthropic.ts`
 * can call `manuallyInstrument(Anthropic)` on it. The auto-patch via
 * require/import hooks does NOT fire under tsx + ESM (which is how all our
 * `*:run` scripts and the dev worker execute), so without manual patching we'd
 * only see raw HTTP POST spans from auto-instrumentation, not the rich
 * generation spans (input messages, output, tool calls, tokens).
 *
 * Returns undefined when OTEL is disabled — caller skips patching cleanly.
 */
export function getAnthropicInstrumentation(): AnthropicInstrumentation | undefined {
  return anthropicInstr;
}

export function startOtel(opts: { serviceName?: string } = {}): void {
  if (!enabled) return;
  if (sdk) return; // idempotent — re-import safe

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) {
    // eslint-disable-next-line no-console
    console.warn(
      "[otel] OTEL_ENABLED=1 but LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASEURL} not all set — disabling",
    );
    return;
  }

  if (process.env.OTEL_DEBUG === "1") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  // NodeSDK auto-enables OTLP metrics + logs exporters whenever
  // OTEL_EXPORTER_OTLP_ENDPOINT is set. We don't use those endpoints (Langfuse
  // only ingests traces), and pinning these off keeps misconfigured deploys
  // from emitting export errors every interval.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";

  const serviceName = opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "productflash";

  // LangfuseSpanProcessor's default `isDefaultExportSpan` filter keeps only
  // Langfuse-tracer / gen_ai / known-LLM-scope spans — too narrow for us
  // since we want full tracing (pg-boss handlers, source fetches, pg queries,
  // outbound HTTP). We export everything EXCEPT noise that adds zero debug
  // value: connection-pool setup (pg-pool.connect, generic-pool acquire).
  const NOISE_SPAN_NAMES = new Set(["pg-pool.connect", "pg.connect", "pool.acquire"]);
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV ?? "development",
    shouldExportSpan: ({ otelSpan }) => !NOISE_SPAN_NAMES.has(otelSpan.name),
  });

  sdk = new NodeSDK({
    // PF-103 #4: NodeSDK's default resource detectors auto-populate
    // host.name / host.arch / process.pid / process.command_args / ... on
    // every span. ~600 bytes × hundreds of spans of identical noise. Disable
    // auto-detection and pass only what's actually useful for filtering.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev",
    }),
    spanProcessors: [processor],
    instrumentations: [
      // Auto: http, https, pg, fetch, express, etc. fs / dns / net are noise
      // at PoC scale — keep them off so traces stay readable.
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        // PF-103 #5: rename pg.query spans to include the target table so the
        // trace tree reads `pg.query: update competitor_sources` instead of
        // just `pg.query:UPDATE neondb`. SQL still lives in db.statement
        // attribute for full inspection.
        "@opentelemetry/instrumentation-pg": {
          requestHook: (span, { query }) => {
            const op = parsePgOp(query.text);
            if (op) span.updateName(`pg.query: ${op}`);
          },
        },
        // PF-103 #5b: rename outbound HTTP spans from `POST` / `GET` to
        // `POST api.anthropic.com/v1/messages` so the URL is visible without
        // expanding the span. Strips query strings to keep names short and
        // groupable across calls. Two clients matter:
        //   - `http`/`https` core modules (instrumentation-http)
        //   - undici (Node's global `fetch`, used by Firecrawl/RSS adapters)
        "@opentelemetry/instrumentation-http": {
          requestHook: (span, request) => {
            const r = request as { method?: string; host?: string; path?: string };
            const method = r.method ?? "HTTP";
            const host = r.host ?? "";
            const path = (r.path ?? "").split("?")[0];
            if (host || path) span.updateName(`${method} ${host}${path}`);
          },
        },
        "@opentelemetry/instrumentation-undici": {
          requestHook: (span, request) => {
            const origin = (request.origin ?? "").replace(/^https?:\/\//, "");
            const path = (request.path ?? "").split("?")[0];
            span.updateName(`${request.method} ${origin}${path}`);
          },
        },
      }),
      // OpenInference: Anthropic spans carry input messages, output messages,
      // tool calls, and token counts — the whole point of OpenInference vs
      // generic OTEL HTTP spans for the Haiku/Sonnet path. The auto-patch only
      // works under CJS require(); under ESM (tsx default) we ALSO call
      // `anthropicInstr.manuallyInstrument(Anthropic)` from anthropic.ts.
      (anthropicInstr = new AnthropicInstrumentation()),
    ],
  });

  sdk.start();

  // eslint-disable-next-line no-console
  console.info(`[otel] started — service=${serviceName} langfuse=${baseUrl}`);
}

/**
 * Best-effort SQL parser: pulls `<verb> <table>` out of common drizzle/pg
 * query shapes. Falls back to the verb alone when the table is buried in
 * a CTE / subquery / DDL. Returns null if nothing useful matches.
 */
function parsePgOp(sql: string): string | null {
  const trimmed = sql.trim().replace(/\s+/g, " ");
  // INSERT INTO "foo" (...) VALUES (...)
  // UPDATE "foo" SET ...
  // DELETE FROM "foo" WHERE ...
  // SELECT ... FROM "foo" ...
  const insert = trimmed.match(/^INSERT\s+INTO\s+"?(\w+)"?/i);
  if (insert) return `insert ${insert[1]}`;
  const update = trimmed.match(/^UPDATE\s+"?(\w+)"?/i);
  if (update) return `update ${update[1]}`;
  const del = trimmed.match(/^DELETE\s+FROM\s+"?(\w+)"?/i);
  if (del) return `delete ${del[1]}`;
  const select = trimmed.match(/^SELECT\s.+\sFROM\s+"?(\w+)"?/i);
  if (select) return `select ${select[1]}`;
  // Fallback: just the verb so we don't render generic 'pg.query'
  const verb = trimmed.match(/^(\w+)/);
  return verb ? verb[1].toLowerCase() : null;
}

/**
 * Force-flush + shut down the OTEL SDK. Scripts that exit (run-*.ts) MUST
 * await this before closing the pg pool, otherwise BatchSpanProcessor's
 * pending span queue is dropped on process exit and traces silently never
 * reach Langfuse. Worker uses its own SIGTERM/SIGINT handler.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort — don't block process exit on a shutdown error
  }
}

// Side-effect: start when this module is imported. Callers that need to
// override the service name (worker vs web) should `import` this module
// first AND then call startOtel({ serviceName }) — the second call is a
// no-op if the SDK already started.
startOtel();
