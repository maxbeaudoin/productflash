import { competitors } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { scrapePricingPagesForCompetitors } from "~/sources/firecrawl";
import { loadLatestPricingSnapshots, saveLatestPricingSnapshot } from "~/sources/firecrawl-store";
import type { CompetitorRef } from "~/sources/types";

// End-to-end probe for the Firecrawl pricing-page adapter.
//
//  pnpm tsx scripts/test-source-firecrawl.ts
//     -> Scrape every seeded competitor with a pricing_url. First run for a
//        competitor stores a snapshot but emits no item. Subsequent runs
//        emit a normalized item with a unified diff IFF the page changed.
//
//  pnpm tsx scripts/test-source-firecrawl.ts --reset
//     -> Wipe stored snapshots before scraping (forces "first snapshot" path
//        on this run; second run with no flag should be a no-diff hit).
//
//  pnpm tsx scripts/test-source-firecrawl.ts --tamper
//     -> After scraping, mutate the stored snapshot in-place so the NEXT
//        run will emit a synthetic diff. Use this to verify the diff path
//        without waiting for a real pricing change.

async function main() {
  const reset = process.argv.includes("--reset");
  const tamper = process.argv.includes("--tamper");
  const db = getDb();

  const rows = await db.select().from(competitors);
  const refs: CompetitorRef[] = rows
    .filter((r) => r.pricingUrl)
    .map((r) => ({
      id: r.id,
      name: r.name,
      homepageUrl: r.homepageUrl,
      rssUrl: r.rssUrl,
      phSlug: r.phSlug,
      pricingUrl: r.pricingUrl,
    }));

  logger.info({ count: refs.length }, "firecrawl probe: competitors with pricingUrl");

  if (reset) {
    const { competitorPricingSnapshots } = await import("~/db/schema");
    await db.delete(competitorPricingSnapshots);
    logger.warn("firecrawl probe: cleared all stored snapshots (--reset)");
  }

  const previous = await loadLatestPricingSnapshots(
    db,
    refs.map((r) => r.id),
  );
  logger.info(
    { stored: previous.size, willScrape: refs.length },
    "firecrawl probe: loaded prior snapshots",
  );

  const started = Date.now();
  const results = await scrapePricingPagesForCompetitors(refs, previous);
  logger.info(
    { durationMs: Date.now() - started, scraped: results.size },
    "firecrawl probe: batch done",
  );

  let changed = 0;
  for (const c of refs) {
    const r = results.get(c.id);
    if (!r) {
      logger.warn(
        { competitor: c.name, pricingUrl: c.pricingUrl },
        "firecrawl: no result (scrape failed)",
      );
      continue;
    }
    await saveLatestPricingSnapshot(db, c.id, r.newSnapshot);

    if (r.item) {
      changed++;
      logger.info(
        {
          competitor: c.name,
          title: r.item.title,
          url: r.item.url,
          sourceId: r.item.sourceId,
          diffPreview: r.item.body?.split("\n").slice(0, 12).join("\n"),
          totalDiffBytes: r.item.body?.length,
        },
        "firecrawl item (CHANGE)",
      );
    } else {
      logger.info(
        {
          competitor: c.name,
          contentBytes: r.newSnapshot.content.length,
          hash: r.newSnapshot.contentHash.slice(0, 12),
        },
        "firecrawl: snapshot stored, no change vs prior",
      );
    }
  }

  if (tamper) {
    for (const c of refs) {
      const r = results.get(c.id);
      if (!r) continue;
      await saveLatestPricingSnapshot(db, c.id, {
        content: r.newSnapshot.content + "\n<!-- tamper -->\n",
        contentHash: "tampered-" + r.newSnapshot.contentHash.slice(0, 24),
        scrapedAt: r.newSnapshot.scrapedAt,
      });
    }
    logger.warn(
      { count: results.size },
      "firecrawl probe: tampered stored snapshots — next run should emit diffs",
    );
  }

  logger.info(
    { competitors: refs.length, scraped: results.size, changed },
    "firecrawl probe: summary",
  );
}

main()
  .catch((err) => {
    logger.fatal({ err }, "firecrawl probe failed");
    process.exit(1);
  })
  .finally(() => getPool().end());
