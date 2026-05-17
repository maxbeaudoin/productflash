import { getPool } from "~/lib/db";
import { logger } from "~/lib/logger";

// Intentionally empty after task #27: the FTE agent (#28) populates
// `competitors` + `user_competitors` per user on signup, so we no longer
// pre-seed a shared roster. Kept as a placeholder so `pnpm db:seed` stays
// a valid no-op and a future contributor has an obvious entry point if
// fixture data is needed again.
async function main() {
  logger.info("seed: nothing to seed — competitors are populated per user by the FTE agent");
  await getPool().end();
}

main().catch((err) => {
  logger.fatal({ err }, "seed failed");
  process.exit(1);
});
