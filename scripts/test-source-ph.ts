import { competitors } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { fetchPHForCompetitors } from "~/sources/ph";
import type { CompetitorRef } from "~/sources/types";

// End-to-end probe for the PH adapter.
//
//  pnpm tsx scripts/test-source-ph.ts
//     -> Run the batch fetch against ALL seeded competitors, lookback 30d.
//        Print per-competitor counts and item details.
//
//  pnpm tsx scripts/test-source-ph.ts --inject
//     -> Same as above, plus inject a synthetic CompetitorRef whose phSlug
//        is taken from the most recent post in the PH firehose. This proves
//        the matcher works on live data even when no seeded competitor is
//        launching in the lookback window.

async function main() {
  const inject = process.argv.includes("--inject");
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

  let synthetic: CompetitorRef | undefined;
  if (inject) {
    synthetic = await buildSyntheticCompetitor();
    if (synthetic) {
      logger.info({ synthetic }, "ph probe: injecting synthetic competitor for live matcher check");
      refs.push(synthetic);
    }
  }

  const started = Date.now();
  const results = await fetchPHForCompetitors(refs, { lookbackDays: 7, maxPages: 5 });
  logger.info({ durationMs: Date.now() - started, competitors: refs.length }, "ph batch done");

  for (const c of refs) {
    const items = results.get(c.id) ?? [];
    logger.info({ competitor: c.name, phSlug: c.phSlug, count: items.length }, "ph result");
    for (const item of items.slice(0, 5)) {
      logger.info(
        {
          competitor: c.name,
          title: item.title,
          url: item.url,
          publishedAt: item.publishedAt?.toISOString(),
        },
        "ph item",
      );
    }
  }

  if (synthetic) {
    const items = results.get(synthetic.id) ?? [];
    if (items.length === 0) {
      logger.error({ synthetic }, "ph probe: matcher FAILED to find injected synthetic competitor");
      process.exitCode = 1;
    } else {
      logger.info({ matched: items.length }, "ph probe: matcher OK on synthetic competitor");
    }
  }
}

async function buildSyntheticCompetitor(): Promise<CompetitorRef | undefined> {
  const token = process.env.PRODUCT_HUNT_TOKEN;
  if (!token) return undefined;
  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: `query { posts(first: 1, order: NEWEST) { edges { node { name url } } } }`,
    }),
  });
  const json: any = await res.json();
  const node = json?.data?.posts?.edges?.[0]?.node;
  if (!node) return undefined;
  const u = new URL(node.url);
  const m = u.pathname.match(/^\/products\/([^/]+)\/?$/);
  const slug = m ? m[1] : null;
  if (!slug) return undefined;
  return {
    id: "synthetic-injected",
    name: node.name,
    homepageUrl: "https://example.invalid",
    rssUrl: null,
    phSlug: slug,
    pricingUrl: null,
  };
}

main()
  .catch((err) => {
    logger.fatal({ err }, "ph probe failed");
    process.exit(1);
  })
  .finally(() => getPool().end());
