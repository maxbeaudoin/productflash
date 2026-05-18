import PgBoss from "pg-boss";
import { FTE_QUEUE } from "~/agents/fte/job";
import { FAST_PATH_QUEUE } from "~/features/digest/server/jobs/fast-path";
import { requireEnv } from "./env";
import { logger } from "./logger";

// Web-side pg-boss client used by server fns to enqueue jobs. The
// long-running worker (src/worker/index.ts) is what actually runs them; this
// client only calls `boss.send()`. We never `boss.work()` here — that would
// steal jobs away from the worker.
//
// `createQueue` is idempotent on the queue name, so calling it from both the
// worker and the web is safe. We do it here so the first signup after a
// fresh deploy doesn't race the worker's startup hook.

let _boss: PgBoss | undefined;
let _starting: Promise<PgBoss> | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;
  if (_starting) return _starting;
  _starting = (async () => {
    const boss = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
    boss.on("error", (err) => logger.error({ err }, "pg-boss (web) error"));
    await boss.start();
    await boss.createQueue(FTE_QUEUE, {
      name: FTE_QUEUE,
      retryLimit: 1,
      retryDelay: 60,
    });
    await boss.createQueue(FAST_PATH_QUEUE, {
      name: FAST_PATH_QUEUE,
      retryLimit: 1,
      retryDelay: 60,
    });
    _boss = boss;
    logger.info("pg-boss (web) client started");
    return boss;
  })();
  return _starting;
}
