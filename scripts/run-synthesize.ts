import { runSynthesis } from "~/features/digest/server/jobs/synthesize";
import { getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownPosthog } from "~/shared/server/posthog";

// Manual trigger for the synthesis job. Mirrors what the pg-boss scheduled
// worker does at 05:30 UTC — useful for iterating on the Sonnet prompt or
// for validating a fresh score run end-to-end without waiting for cron.
//
//   pnpm synthesize:run

async function main() {
  const metrics = await runSynthesis();
  logger.info(metrics, "manual synthesis done");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "manual synthesis failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
