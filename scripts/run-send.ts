import { eq } from "drizzle-orm";
import { digests, users } from "~/db/schema";
import { runSendForDigest, runSendForUnsent } from "~/features/digest/server/jobs/send";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownPosthog } from "~/shared/server/posthog";

// Manual trigger for the digest send.
//
//   pnpm send:run                     # send every unsent digest for an
//                                     # active user, inline (idempotent)
//   pnpm send:run <digestId>          # send one specific digest
//   pnpm send:run --email <address>   # send the newest digest for the user
//                                     # with that email (handy for dogfood)
//   pnpm send:run --dry               # render but don't send (combine with
//                                     # either of the above)
//   pnpm send:run --force             # bypass digests.sent_at idempotency
//                                     # (combine with a digestId)

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry") || args.includes("--dry-run");
  const force = args.includes("--force");

  const emailFlag = args.indexOf("--email");
  if (emailFlag !== -1) {
    const email = args[emailFlag + 1];
    if (!email) throw new Error("--email requires a value");
    const digestId = await resolveLatestDigestFor(email);
    const result = await runSendForDigest(digestId, { dryRun, force });
    logger.info(result, "send: result");
    return;
  }

  // First positional non-flag arg is treated as a digest id.
  const positional = args.find((a) => !a.startsWith("--"));
  if (positional) {
    const result = await runSendForDigest(positional, { dryRun, force });
    logger.info(result, "send: result");
    return;
  }

  const batch = await runSendForUnsent({ dryRun, force });
  logger.info(batch, "send: batch result");
}

async function resolveLatestDigestFor(email: string): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ id: digests.id })
    .from(digests)
    .innerJoin(users, eq(users.id, digests.userId))
    .where(eq(users.email, email))
    .orderBy(digests.createdAt);
  if (rows.length === 0) throw new Error(`no digest found for ${email}`);
  // orderBy ascending — last is the newest
  return rows[rows.length - 1].id;
}

main()
  .catch((err) => {
    logger.fatal({ err }, "send: manual run failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog().catch(() => {});
    await getPool().end();
  });
