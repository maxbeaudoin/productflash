import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { requireEnv } from "~/shared/server/env";
import { logger } from "~/shared/server/logger";

// Runtime migrator used in both dev (`pnpm db:migrate`) and Railway's
// preDeployCommand on the web service. Uses drizzle-orm (a runtime dep)
// rather than drizzle-kit (dev-only) so it runs in pruned prod installs.

async function main() {
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 1 });
  try {
    const db = drizzle(pool);
    const started = Date.now();
    await migrate(db, { migrationsFolder: "./drizzle" });
    logger.info({ durationMs: Date.now() - started }, "migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "migration failed");
  process.exit(1);
});
