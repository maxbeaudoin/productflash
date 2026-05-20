// OTEL bootstrap must come first — see src/shared/server/otel.ts (PF-103).
import "~/shared/server/otel";

import { runIngestion } from "~/features/digest/server/jobs/ingest";
import { getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownOtel } from "~/shared/server/otel";
import { shutdownPosthog } from "~/shared/server/posthog";
import { withSpan } from "~/shared/server/tracer";

// Manual trigger for the ingestion orchestrator. Mirrors what the pg-boss
// scheduled worker does at 04:00 UTC — useful for one-shot validation and
// for iterating on adapter changes without waiting for the cron tick.
//
//   pnpm ingest:run

async function main() {
  const metrics = await withSpan("ingest-run", () => runIngestion(), {
    "trigger.source": "manual",
  });
  logger.info(metrics, "manual ingestion done");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "manual ingestion failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    // Flush OTEL spans BEFORE closing the pg pool — auto-instrumented pg
    // spans hold references to the pool; tearing it down first races the
    // exporter and silently drops in-flight traces.
    await shutdownOtel();
    await shutdownPosthog();
    await getPool().end();
  });
