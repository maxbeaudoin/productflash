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

  // LangfuseSpanProcessor applies "default smart filtering" that only exports
  // spans the Langfuse SDK explicitly tagged or GenAI-marked spans. Our
  // custom pg-boss job + source-fetch spans are plain OTEL spans, so we
  // override the filter to export everything in the productflash tracer
  // hierarchy. OpenInference's Anthropic spans pass through either way since
  // they carry the GenAI semantic conventions Langfuse looks for.
  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment: process.env.NODE_ENV ?? "development",
    shouldExportSpan: () => true,
  });

  sdk = new NodeSDK({
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
      }),
      // OpenInference: Anthropic spans carry input messages, output messages,
      // tool calls, and token counts — the whole point of OpenInference vs
      // generic OTEL HTTP spans for the Haiku/Sonnet path.
      new AnthropicInstrumentation(),
    ],
  });

  sdk.start();

  process.on("beforeExit", () => {
    sdk?.shutdown().catch(() => {});
  });

  // eslint-disable-next-line no-console
  console.info(`[otel] started — service=${serviceName} langfuse=${baseUrl}`);
}

// Side-effect: start when this module is imported. Callers that need to
// override the service name (worker vs web) should `import` this module
// first AND then call startOtel({ serviceName }) — the second call is a
// no-op if the SDK already started.
startOtel();
