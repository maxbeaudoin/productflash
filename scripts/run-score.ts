import { runScoring } from "~/features/digest/server/jobs/score";
import { getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownPosthog } from "~/shared/server/posthog";

// Manual trigger for the scoring job. Mirrors what the pg-boss scheduled
// worker does at 05:00 UTC — useful for iterating on the classify prompt or
// for validating a fresh ingestion run end-to-end without waiting for cron.
//
//   pnpm score:run

async function main() {
  const metrics = await runScoring();
  logger.info(metrics, "manual scoring done");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "manual scoring failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
