// Nitro plugin — boots OTEL + OpenInference on web server startup (PF-103).
//
// Nitro runs plugins once at app initialization, before the first request.
// Side-effect-importing src/shared/server/otel.ts here starts the SDK so
// the Anthropic SDK (lazy-loaded via getAnthropic) + pg/http/fetch auto-
// instrumentations are wired up before any handler fires.
//
// Worker has its own first-line bootstrap in src/worker/index.ts; this is
// the equivalent for the TanStack Start server build.

import { definePlugin } from "nitro";
import { startOtel } from "../../src/shared/server/otel";

export default definePlugin(() => {
  startOtel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "productflash-web" });
});
