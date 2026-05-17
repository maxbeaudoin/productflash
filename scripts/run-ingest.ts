import { runIngestion } from "~/jobs/ingest";
import { getPool } from "~/lib/db";
import { logger } from "~/lib/logger";
import { shutdownPosthog } from "~/lib/posthog";

// Manual trigger for the ingestion orchestrator. Mirrors what the pg-boss
// scheduled worker does at 04:00 UTC — useful for one-shot validation and
// for iterating on adapter changes without waiting for the cron tick.
//
//   pnpm ingest:run

async function main() {
  const metrics = await runIngestion();
  logger.info(metrics, "manual ingestion done");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "manual ingestion failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
