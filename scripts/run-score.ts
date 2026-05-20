// OTEL bootstrap must come first — see src/shared/server/otel.ts (PF-103).
import "~/shared/server/otel";

import { runScoring } from "~/features/digest/server/jobs/score";
import { getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownOtel } from "~/shared/server/otel";
import { shutdownPosthog } from "~/shared/server/posthog";
import { withSpan } from "~/shared/server/tracer";

// Manual trigger for the scoring job. Mirrors what the pg-boss scheduled
// worker does at 05:00 UTC — useful for iterating on the classify prompt or
// for validating a fresh ingestion run end-to-end without waiting for cron.
//
//   pnpm score:run

async function main() {
  // Wrap in the same top-level span the pg-boss handler uses so manual
  // triggers show up as a single trace in Langfuse with all LLM + pg
  // child spans nested underneath.
  const metrics = await withSpan("score-run", () => runScoring(), {
    "trigger.source": "manual",
  });
  logger.info(metrics, "manual scoring done");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "manual scoring failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    // Flush OTEL spans BEFORE closing the pg pool (see run-ingest.ts).
    await shutdownOtel();
    await shutdownPosthog();
    await getPool().end();
  });
