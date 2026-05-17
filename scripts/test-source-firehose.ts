import { competitors } from "~/db/schema";
import { getDb, getPool } from "~/lib/db";
import { logger } from "~/lib/logger";
import { fetchFirehoseForCompetitors } from "~/sources/firehose";
import type { CompetitorRef, NormalizedItem } from "~/sources/types";

// End-to-end probe for the Firehose adapter.
//
//   pnpm tsx scripts/test-source-firehose.ts
//     -> Run a short stream (timeout=30s, limit=500, since=24h) against all
//        seeded competitors. Print per-competitor counts + first 3 items.
//
//   pnpm tsx scripts/test-source-firehose.ts --twice
//     -> Run twice back-to-back, the second with since=1h. Assert overlap
//        of sourceIds across runs (proves dedupe key is stable). With
//        Firehose the buffer keeps moving so we look for any overlap, not
//        a high overlap ratio.
//
// Zero events is a WARNING, not a failure: rules only match events going
// forward from creation time, and competitors may simply be quiet. Exit 1
// only on stream connection failures (auth error, 5xx, error frame).

async function main() {
  const twice = process.argv.includes("--twice");
  const db = getDb();

  const rows = await db.select().from(competitors);
  const refs: CompetitorRef[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    homepageUrl: r.homepageUrl,
    rssUrl: r.rssUrl,
    phSlug: r.phSlug,
    pricingUrl: r.pricingUrl,
  }));

  const first = await runOnce(refs, { sinceWindow: "24h", timeoutSec: 30, limit: 500 });
  reportRun("first", refs, first);

  if (twice) {
    const second = await runOnce(refs, { sinceWindow: "1h", timeoutSec: 30, limit: 500 });
    reportRun("second", refs, second);
    assertOverlap(first, second);
  }

  const totalFirst = sumItems(first);
  if (totalFirst === 0) {
    logger.warn(
      { competitors: refs.length },
      "firehose probe: stream returned 0 events. If rules were created recently, " +
        "this is expected — Firehose only buffers events that arrive AFTER a rule is created. " +
        "Re-probe in a few hours.",
    );
  }
}

interface RunOptions {
  sinceWindow: string;
  timeoutSec: number;
  limit: number;
}

async function runOnce(
  refs: CompetitorRef[],
  options: RunOptions,
): Promise<Map<string, NormalizedItem[]>> {
  const started = Date.now();
  logger.info({ ...options, competitors: refs.length }, "firehose probe: starting run");
  const map = await fetchFirehoseForCompetitors(refs, options);
  logger.info({ durationMs: Date.now() - started }, "firehose probe: run done");
  return map;
}

function reportRun(label: string, refs: CompetitorRef[], map: Map<string, NormalizedItem[]>) {
  for (const c of refs) {
    const items = map.get(c.id) ?? [];
    logger.info({ run: label, competitor: c.name, count: items.length }, "firehose result");
    for (const item of items.slice(0, 3)) {
      logger.info(
        {
          run: label,
          competitor: c.name,
          title: item.title,
          url: item.url,
          sourceId: item.sourceId,
          publishedAt: item.publishedAt?.toISOString() ?? null,
          bodyBytes: item.body?.length ?? 0,
        },
        "firehose item",
      );
    }
  }
  logger.info({ run: label, total: sumItems(map) }, "firehose run total");
}

function sumItems(map: Map<string, NormalizedItem[]>): number {
  let n = 0;
  for (const arr of map.values()) n += arr.length;
  return n;
}

function assertOverlap(
  first: Map<string, NormalizedItem[]>,
  second: Map<string, NormalizedItem[]>,
) {
  const firstIds = new Set<string>();
  const secondIds = new Set<string>();
  for (const arr of first.values()) for (const it of arr) firstIds.add(it.sourceId);
  for (const arr of second.values()) for (const it of arr) secondIds.add(it.sourceId);

  if (firstIds.size === 0 && secondIds.size === 0) {
    logger.warn("firehose probe: both runs returned 0 events — overlap check skipped");
    return;
  }

  let overlap = 0;
  for (const id of secondIds) if (firstIds.has(id)) overlap++;

  if (overlap === 0 && firstIds.size > 0 && secondIds.size > 0) {
    logger.error(
      { firstCount: firstIds.size, secondCount: secondIds.size },
      "firehose probe: NO sourceId overlap across two runs — dedupe key may be unstable",
    );
    process.exitCode = 1;
    return;
  }

  logger.info(
    { firstCount: firstIds.size, secondCount: secondIds.size, overlap },
    "firehose probe: dedupe check OK",
  );
}

main()
  .catch((err) => {
    logger.fatal({ err }, "firehose probe failed");
    process.exit(1);
  })
  .finally(() => getPool().end());
