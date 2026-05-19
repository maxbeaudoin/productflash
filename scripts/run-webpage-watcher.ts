import { and, eq, inArray } from "drizzle-orm";
import { competitors as competitorsTable, competitorSources, rawItems } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownPosthog } from "~/shared/server/posthog";
import { fetchWebpageForSources, type WebpageSourceRef } from "~/sources/webpage";

// Manual trigger for the webpage watcher only (PF-97). Useful for iterating
// on Haiku prompts and cost-bounded testing without firing the full
// ingestion run.
//
//   pnpm webpage:run                       # all active webpage sources
//   pnpm webpage:run --competitor <uuid>   # restrict to one competitor
//   pnpm webpage:run --source <uuid>       # restrict to one source row

interface Args {
  competitorId: string | null;
  sourceId: string | null;
}

function parseArgs(argv: string[]): Args {
  let competitorId: string | null = null;
  let sourceId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--competitor" && i + 1 < argv.length) {
      competitorId = argv[++i];
    } else if (arg === "--source" && i + 1 < argv.length) {
      sourceId = argv[++i];
    }
  }
  return { competitorId, sourceId };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = getDb();

  const conditions = [
    eq(competitorSources.sourceType, "webpage"),
    eq(competitorSources.status, "active"),
  ];
  if (args.competitorId) conditions.push(eq(competitorSources.competitorId, args.competitorId));
  if (args.sourceId) conditions.push(eq(competitorSources.id, args.sourceId));

  const sourceRows = await db
    .select()
    .from(competitorSources)
    .where(and(...conditions));

  if (sourceRows.length === 0) {
    logger.warn({ args }, "webpage:run no active webpage sources match the filter");
    return;
  }

  const competitorIds = Array.from(new Set(sourceRows.map((r) => r.competitorId)));
  const competitorRows = await db
    .select()
    .from(competitorsTable)
    .where(inArray(competitorsTable.id, competitorIds));
  const nameById = new Map(competitorRows.map((c) => [c.id, c.name]));

  const refs: WebpageSourceRef[] = sourceRows.map((r) => ({
    id: r.id,
    competitorId: r.competitorId,
    competitorName: nameById.get(r.competitorId) ?? "(unknown)",
    url: r.urlOrHandle,
    extractionMode:
      r.extractionMode === "snapshot_diff" || r.extractionMode === "list_extract"
        ? r.extractionMode
        : null,
    lastContentHash: r.lastContentHash,
  }));

  logger.info({ count: refs.length }, "webpage:run starting");
  const results = await fetchWebpageForSources(refs);

  let inserted = 0;
  let updated = 0;
  for (const [sourceId, result] of results) {
    if (!result.errored) {
      const update: Partial<typeof competitorSources.$inferInsert> = {
        lastFetchedAt: result.fetchedAt,
      };
      if (result.inferredMode) update.extractionMode = result.inferredMode;
      if (result.newContentHash !== null) update.lastContentHash = result.newContentHash;
      await db.update(competitorSources).set(update).where(eq(competitorSources.id, sourceId));
      updated++;
    }

    if (result.items.length > 0) {
      const rows = await db
        .insert(rawItems)
        .values(
          result.items.map((item) => ({
            competitorId: result.competitorId,
            source: item.source,
            sourceId: item.sourceId,
            competitorSourceId: sourceId,
            url: item.url,
            title: item.title,
            body: item.body,
            publishedAt: item.publishedAt,
          })),
        )
        .onConflictDoNothing({ target: [rawItems.source, rawItems.sourceId] })
        .returning({ id: rawItems.id });
      inserted += rows.length;
    }

    logger.info(
      {
        sourceId,
        competitorId: result.competitorId,
        items: result.items.length,
        inferredMode: result.inferredMode,
        newContentHash: result.newContentHash?.slice(0, 12) ?? null,
        errored: result.errored,
      },
      "webpage:run source done",
    );
  }

  logger.info({ sources: results.size, updated, inserted }, "webpage:run complete");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "webpage:run failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
