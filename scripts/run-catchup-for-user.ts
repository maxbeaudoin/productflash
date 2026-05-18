import { eq } from "drizzle-orm";
import { users as usersTable } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { runSynthesisForUser } from "~/jobs/synthesize";
import { shutdownPosthog } from "~/shared/server/posthog";

// One-off: run the catch-up synthesis path for a single user, in-process,
// with the same params fast-path uses. Useful for previewing what a fresh
// FTE confirmation would produce without enqueueing a pg-boss job (which
// would route through a possibly-stale worker).
//
//   pnpm tsx scripts/run-catchup-for-user.ts [email]

async function main() {
  const email = process.argv[2] ?? "beaudoin.maxime@gmail.com";
  const db = getDb();
  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (!user) {
    logger.error({ email }, "no user with that email");
    return;
  }
  const metrics = await runSynthesisForUser(user.id, {
    lookbackHours: 24 * 7,
    maxItemsPerDigest: 10,
    maxItemsPerCompetitor: 3,
  });
  logger.info({ ...metrics, email: user.email }, "catch-up synthesis done");
}

main()
  .catch((err) => {
    console.error("catch-up run failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
