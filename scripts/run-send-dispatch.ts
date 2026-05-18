import PgBoss from "pg-boss";
import { SEND_QUEUE } from "~/jobs/send";
import { runSendDispatch, SEND_DISPATCH_QUEUE } from "~/jobs/send-dispatch";
import { getPool } from "~/shared/server/db";
import { requireEnv } from "~/shared/server/env";
import { logger } from "~/shared/server/logger";
import { shutdownPosthog } from "~/shared/server/posthog";

// Manual trigger for the per-TZ send dispatcher (#17).
//
//   pnpm send:dispatch                  # enqueue sends for users whose
//                                       # local time matches the default
//                                       # 7am hour AND day is Mon-Fri.
//   pnpm send:dispatch --hour 13        # override target local hour
//   pnpm send:dispatch --include-weekends
//   pnpm send:dispatch --dry            # show what would enqueue; no writes

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry") || args.includes("--dry-run");
  const includeWeekends = args.includes("--include-weekends");
  const hourFlag = args.indexOf("--hour");
  const targetHour = hourFlag !== -1 ? Number(args[hourFlag + 1]) : undefined;
  if (targetHour !== undefined && Number.isNaN(targetHour)) {
    throw new Error("--hour requires a number");
  }

  const boss = dryRun
    ? null
    : await (async () => {
        const b = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
        await b.start();
        // Make sure the target queue exists — script may run before the
        // worker has booted in a fresh env.
        await b.createQueue(SEND_QUEUE, {
          name: SEND_QUEUE,
          retryLimit: 2,
          retryDelay: 300,
          retryBackoff: true,
        });
        await b.createQueue(SEND_DISPATCH_QUEUE, {
          name: SEND_DISPATCH_QUEUE,
          retryLimit: 1,
          retryDelay: 60,
        });
        return b;
      })();

  try {
    const metrics = await runSendDispatch(boss, {
      targetHour,
      includeWeekends,
      dryRun,
    });
    logger.info(metrics, "send-dispatch: result");
  } finally {
    if (boss) await boss.stop({ graceful: true, wait: true });
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, "send-dispatch: manual run failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog().catch(() => {});
    await getPool().end();
  });
