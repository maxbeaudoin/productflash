// OTEL bootstrap must come first — see src/shared/server/otel.ts (PF-103).
import "~/shared/server/otel";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runFteAgent, type FteSignupHints } from "~/agents/fte/agent";
import { users as usersTable } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownOtel } from "~/shared/server/otel";
import { shutdownPosthog } from "~/shared/server/posthog";
import { withSpan } from "~/shared/server/tracer";

// Manual trigger for the FTE agent. Bypasses pg-boss so we can iterate on the
// agent loop and prompt without the queue in the way.
//
// Usage:
//   pnpm tsx scripts/run-fte.ts <user_email>
//
// The script reads the user row, builds FteSignupHints from `email`,
// `companyUrl`, `position`, `ultimateGoal`, then runs the agent inline and
// prints the result. Use this for solo dogfooding (#13) before #29 wires the
// signup form.

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: pnpm tsx scripts/run-fte.ts <email>");
    process.exit(1);
  }

  const db = getDb();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (!user) {
    console.error(`No user with email=${email}. Run /signup first.`);
    process.exit(1);
  }

  const signup: FteSignupHints = {
    email: user.email,
    companyUrl: user.companyUrl,
    position: user.position,
    ultimateGoal: user.ultimateGoal,
  };

  const runId = randomUUID();
  logger.info({ userId: user.id, runId, signup }, "fte: starting manual run");
  const result = await withSpan("fte-run", () => runFteAgent({ userId: user.id, runId, signup }), {
    "trigger.source": "manual",
    "fte.user_id": user.id,
    "fte.run_id": runId,
  });
  logger.info(result, "fte: manual run complete");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "fte manual run failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownOtel();
    await shutdownPosthog();
    await getPool().end();
  });
