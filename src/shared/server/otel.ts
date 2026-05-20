// OTEL + OpenInference bootstrap (PF-103).
//
// MUST be imported as the very first line of any server entry point
// (src/worker/index.ts and the TanStack Start server entry) — auto-
// instrumentation patches via require/import hooks, so any SDK loaded
// before this module runs ends up uninstrumented.
//
// Reads raw process.env directly rather than the Zod env module because
// env.ts is one of the first server modules to load and we want to keep
// the bootstrap free of any non-stdlib import that would itself need
// patching. The feature flag (OTEL_ENABLED) gates the entire side-effect
// so deploys without exporter credentials stay no-op.
//
// Backend: Langfuse Cloud (decision per project memory + PF-103 spec).
// Standard OTEL_EXPORTER_OTLP_* env vars drive endpoint + auth, which
// keeps us free to swap to Honeycomb / Phoenix / Grafana later by changing
// Railway variables, not code.

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { AnthropicInstrumentation } from "@arizeai/openinference-instrumentation-anthropic";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const flag = process.env.OTEL_ENABLED;
const enabled = flag === "1" || flag === "true";

let sdk: NodeSDK | undefined;

export function startOtel(opts: { serviceName?: string } = {}): void {
  if (!enabled) return;
  if (sdk) return; // idempotent — re-import safe

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    // No exporter configured — bail before NodeSDK starts a console exporter
    // by default. Loud about it so a misconfigured deploy doesn't silently
    // emit nothing.
    // eslint-disable-next-line no-console
    console.warn("[otel] OTEL_ENABLED=1 but OTEL_EXPORTER_OTLP_ENDPOINT is unset — disabling");
    return;
  }

  if (process.env.OTEL_DEBUG === "1") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  // NodeSDK auto-enables OTLP metrics + logs exporters whenever
  // OTEL_EXPORTER_OTLP_ENDPOINT is set. Langfuse Cloud only accepts traces,
  // so the auto-started metrics/logs exporters would just emit 401s every
  // interval. Pin them off unless the operator explicitly opts in.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";

  const serviceName = opts.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "productflash";

  // Langfuse routes traces under /api/public/otel/v1/traces; the
  // OTLPTraceExporter adds /v1/traces automatically when given the
  // collector root, so the endpoint env var should be the root URL.
  const headers = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  const traceExporter = new OTLPTraceExporter({
    url: endpoint.replace(/\/+$/, "") + "/v1/traces",
    headers,
  });

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.RAILWAY_GIT_COMMIT_SHA ?? "dev",
    }),
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    instrumentations: [
      // Auto: http, https, pg, fetch, fs (noise-suppressed below), express, etc.
      getNodeAutoInstrumentations({
        // fs spans are noise at PoC scale — drop them so traces stay readable.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // dns adds nothing actionable for our workload.
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
      // OpenInference: Anthropic spans carry input messages, output messages,
      // tool calls, and token counts (the whole point of OpenInference vs
      // generic OTEL HTTP spans).
      new AnthropicInstrumentation(),
    ],
  });

  sdk.start();

  // Best-effort flush on shutdown. Workers handle SIGTERM/SIGINT explicitly
  // (see src/worker/index.ts); web is process-managed by Nitro.
  process.on("beforeExit", () => {
    sdk?.shutdown().catch(() => {});
  });

  // eslint-disable-next-line no-console
  console.info(`[otel] started — service=${serviceName} endpoint=${endpoint}`);
}

function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// Side-effect: start when this module is imported. Callers that need to
// override the service name (worker vs web) should `import` this module
// first AND then call startOtel({ serviceName }) — the second call is a
// no-op if the SDK already started.
startOtel();
