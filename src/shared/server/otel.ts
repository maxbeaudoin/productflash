// OTEL + Langfuse bootstrap (PF-103). Canonical Langfuse JS pattern, see
// https://langfuse.com/integrations/model-providers/anthropic-js.
//
// MUST be imported as the very first line of any server entry point (the
// worker entry, the TanStack Start server entry via server/plugins/otel.ts,
// each manual *:run script). Instrumentation patches must run before any
// instrumented SDK is loaded.
//
// What we trace, by design:
//   - The 5 production workflows, wrapped explicitly in withSpan / withToolSpan
//     (ingest-run, score-run, synthesize-run, fte-run, discovery-run).
//   - Anthropic SDK calls inside those workflows — captured as rich
//     generation spans (model, input/output messages, tool calls, tokens,
//     cost) by @arizeai/openinference-instrumentation-anthropic.
//
// What we deliberately DON'T trace:
//   - Auto-instrumented http / pg / undici. They flood the trace tree with
//     noise (every `SELECT ... FROM pgboss.job` poll, every internal HTTP
//     retry, etc.) and obscure the workflow story. If a specific call is
//     worth tracing, wrap it explicitly.
//   - Background work outside a workflow (pg-boss polling, health checks).
//
// Known limitation: OpenInference's Anthropic patch breaks `messages.stream()`
// (it wraps `messages.create` such that the SDK's internal `.withResponse()`
// call fails). The FTE agent uses streaming and would crash if instrumented.
// We disable Anthropic instrumentation entirely until OpenInference fixes it;
// re-enable via OTEL_TRACE_ANTHROPIC=1 once the upstream gap closes.

// Side-effect import: env.ts triggers dotenv loading, so subsequent
// process.env.* reads see .env values. env.ts itself imports no SDKs that
// need OTEL patching, so loading it before the NodeSDK starts is safe.
import "./env";

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import Anthropic from "@anthropic-ai/sdk";

const flag = process.env.OTEL_ENABLED;
const enabled = flag === "1" || flag === "true";
const traceAnthropic =
  process.env.OTEL_TRACE_ANTHROPIC === "1" || process.env.OTEL_TRACE_ANTHROPIC === "true";

let sdk: NodeSDK | undefined;

export function startOtel(opts: { serviceName?: string } = {}): void {
  if (!enabled) return;
  if (sdk) return; // idempotent — re-import safe

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) {
    // eslint-disable-next-line no-console
    console.warn(
      "[otel] OTEL_ENABLED=1 but LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL} not all set — disabling",
    );
    return;
  }

  if (process.env.OTEL_DEBUG === "1") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  // Langfuse only ingests traces. Pin metric/log exporters off so a misconfig
  // doesn't emit 401s every interval to a non-existent collector.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";

  const serviceName = opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "productflash";

  // LangfuseSpanProcessor's default `isDefaultExportSpan` keeps only
  // Langfuse-tracer / GenAI / known-LLM-scope spans. That's exactly what we
  // want: our explicit `withSpan` roots (langfuse tracer scope) + OpenInference
  // Anthropic generation spans pass through, everything else is dropped at
  // source. No filter override needed.
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV ?? "development",
  });

  // OpenInference Anthropic instrumentation. The Langfuse canonical pattern
  // calls `manuallyInstrument(Anthropic)` before sdk.start(); we follow it
  // verbatim except behind a feature flag (see streaming limitation in the
  // module header).
  const instrumentations = [];
  if (traceAnthropic) {
    const anthropicInstr = new AnthropicInstrumentation();
    anthropicInstr.manuallyInstrument(Anthropic);
    instrumentations.push(anthropicInstr);
  }

  sdk = new NodeSDK({
    // Don't pollute every span with host.name / process.pid / command_args.
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev",
    }),
    spanProcessors: [processor],
    instrumentations,
  });

  sdk.start();

  // eslint-disable-next-line no-console
  console.info(
    `[otel] started — service=${serviceName} langfuse=${baseUrl} anthropic=${traceAnthropic ? "on" : "off"}`,
  );
}

/**
 * Force-flush + shut down the OTEL SDK. Scripts that exit (run-*.ts) MUST
 * await this before closing the pg pool — BatchSpanProcessor's pending queue
 * is dropped on process exit and traces silently never reach Langfuse. The
 * worker uses its own SIGTERM/SIGINT handler.
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
