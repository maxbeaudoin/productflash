import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  competitors as competitorsTable,
  digestItems,
  digests,
  itemScores,
  rawItems,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import { getDb, getPool } from "~/lib/db";

// One-off probe: why is Maxime's digest all-Lattice?
//
//   pnpm tsx scripts/probe-digest-diversity.ts [email]
//
// Walks the data backwards from the most recent digest:
//   1. Identify the target user.
//   2. List their tracked competitors.
//   3. Count raw_items per competitor in the last 7 days (the catch-up window).
//   4. Count scored, non-noise items per competitor (the synthesis pool).
//   5. Dump the most recent digest's items with their competitor + score.
//   6. Re-run the diversity-cap selection against the live pool and compare.

async function main() {
  const email = process.argv[2] ?? "beaudoin.maxime@gmail.com";
  const db = getDb();

  console.log(`\n=== Probing digest diversity for ${email} ===\n`);

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (!user) {
    console.error(`No user found with email ${email}`);
    return;
  }
  console.log(`User: ${user.email}  id=${user.id}  status=${user.status}\n`);

  const competitors = await db
    .select({
      id: competitorsTable.id,
      name: competitorsTable.name,
      homepageUrl: competitorsTable.homepageUrl,
      rssUrl: competitorsTable.rssUrl,
    })
    .from(userCompetitors)
    .innerJoin(competitorsTable, eq(userCompetitors.competitorId, competitorsTable.id))
    .where(eq(userCompetitors.userId, user.id))
    .orderBy(competitorsTable.name);
  console.log(`--- Tracked competitors (${competitors.length}) ---`);
  for (const c of competitors) {
    console.log(`  • ${c.name.padEnd(30)} ${c.rssUrl ? "(rss)" : "     "}  ${c.homepageUrl}`);
  }
  console.log();

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rawByCompetitor = await db
    .select({
      competitorId: rawItems.competitorId,
      competitorName: competitorsTable.name,
      n: sql<number>`count(*)::int`,
    })
    .from(rawItems)
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(gte(rawItems.ingestedAt, since7d))
    .groupBy(rawItems.competitorId, competitorsTable.name)
    .orderBy(desc(sql`count(*)`));
  console.log(`--- raw_items per competitor (last 7d) ---`);
  for (const row of rawByCompetitor) {
    console.log(`  • ${row.competitorName.padEnd(30)} ${row.n}`);
  }
  if (rawByCompetitor.length === 0) console.log("  (none)");
  console.log();

  const rawTracked = await db
    .select({
      competitorName: competitorsTable.name,
      n: sql<number>`count(*)::int`,
    })
    .from(rawItems)
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .innerJoin(userCompetitors, eq(userCompetitors.competitorId, competitorsTable.id))
    .where(and(eq(userCompetitors.userId, user.id), gte(rawItems.ingestedAt, since7d)))
    .groupBy(competitorsTable.name)
    .orderBy(desc(sql`count(*)`));
  console.log(`--- raw_items per TRACKED competitor (last 7d) ---`);
  for (const row of rawTracked) {
    console.log(`  • ${row.competitorName.padEnd(30)} ${row.n}`);
  }
  if (rawTracked.length === 0) console.log("  (none)");
  console.log();

  const scoredByCompetitor = await db
    .select({
      competitorName: competitorsTable.name,
      category: itemScores.category,
      n: sql<number>`count(*)::int`,
      avgScore: sql<number>`round(avg(${itemScores.score}))::int`,
      maxScore: sql<number>`max(${itemScores.score})::int`,
    })
    .from(itemScores)
    .innerJoin(rawItems, eq(rawItems.id, itemScores.rawItemId))
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(and(eq(itemScores.userId, user.id), gte(rawItems.ingestedAt, since7d)))
    .groupBy(competitorsTable.name, itemScores.category)
    .orderBy(competitorsTable.name, itemScores.category);
  console.log(`--- item_scores by (competitor, category) — last 7d ---`);
  let lastCompetitor = "";
  for (const row of scoredByCompetitor) {
    if (row.competitorName !== lastCompetitor) {
      console.log(`  ${row.competitorName}`);
      lastCompetitor = row.competitorName;
    }
    console.log(
      `    ${row.category.padEnd(14)} n=${String(row.n).padEnd(4)} avg=${row.avgScore} max=${row.maxScore}`,
    );
  }
  if (scoredByCompetitor.length === 0) console.log("  (none)");
  console.log();

  // The actual synthesis pool query (mirrors src/jobs/synthesize.ts runForUser)
  // but with NO limit so we see every non-noise scored item for the user in
  // the catch-up window. Helps answer: would the diversity cap have anything
  // to pick from, or is Lattice genuinely the only competitor with material?
  const pool = await db
    .select({
      rawItemId: rawItems.id,
      competitorName: competitorsTable.name,
      source: rawItems.source,
      url: rawItems.url,
      title: rawItems.title,
      category: itemScores.category,
      score: itemScores.score,
      publishedAt: rawItems.publishedAt,
      ingestedAt: rawItems.ingestedAt,
    })
    .from(itemScores)
    .innerJoin(rawItems, eq(rawItems.id, itemScores.rawItemId))
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(
      and(
        eq(itemScores.userId, user.id),
        sql`${itemScores.category} != 'noise'`,
        gte(rawItems.ingestedAt, since7d),
      ),
    )
    .orderBy(desc(itemScores.score));
  console.log(`--- synthesis pool (non-noise, last 7d), top 30 by score ---`);
  for (const row of pool.slice(0, 30)) {
    console.log(
      `  [${row.category.padEnd(11)} ${String(row.score).padStart(3)}] ${row.competitorName.padEnd(20)} ${row.title.slice(0, 70)}`,
    );
  }
  if (pool.length === 0) console.log("  (empty pool)");
  console.log(`  total non-noise items in window: ${pool.length}`);
  console.log();

  const poolByCompetitor = new Map<string, number>();
  for (const row of pool) {
    poolByCompetitor.set(row.competitorName, (poolByCompetitor.get(row.competitorName) ?? 0) + 1);
  }
  console.log(`--- pool composition by competitor (non-noise, last 7d) ---`);
  for (const [name, n] of [...poolByCompetitor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  • ${name.padEnd(30)} ${n}`);
  }
  console.log();

  // Simulate the diversity selection (mirrors selectDiverseCandidates).
  const MAX_PER = 2;
  const TARGET = 5;
  const simSelected: typeof pool = [];
  const used = new Set<string>();
  const perComp = new Map<string, number>();
  for (const item of pool) {
    if (simSelected.length >= TARGET) break;
    const count = perComp.get(item.competitorName) ?? 0;
    if (count >= MAX_PER) continue;
    simSelected.push(item);
    used.add(item.rawItemId);
    perComp.set(item.competitorName, count + 1);
  }
  if (simSelected.length < TARGET) {
    for (const item of pool) {
      if (simSelected.length >= TARGET) break;
      if (used.has(item.rawItemId)) continue;
      simSelected.push(item);
      used.add(item.rawItemId);
    }
  }
  console.log(`--- simulated diverse selection (cap 2 per competitor, target 5) ---`);
  for (const row of simSelected) {
    console.log(
      `  [${row.category.padEnd(11)} ${String(row.score).padStart(3)}] ${row.competitorName.padEnd(20)} ${row.title.slice(0, 70)}`,
    );
  }
  console.log();

  // Latest digest — what actually got persisted.
  const [latestDigest] = await db
    .select({
      id: digests.id,
      createdAt: digests.createdAt,
      itemCount: digests.itemCount,
      periodStart: digests.periodStart,
      periodEnd: digests.periodEnd,
    })
    .from(digests)
    .where(eq(digests.userId, user.id))
    .orderBy(desc(digests.createdAt))
    .limit(1);
  if (!latestDigest) {
    console.log("(no digests yet)");
    return;
  }
  console.log(`--- latest digest ---`);
  console.log(`  id=${latestDigest.id}`);
  console.log(`  created_at=${latestDigest.createdAt.toISOString()}`);
  console.log(`  item_count=${latestDigest.itemCount}`);
  console.log(`  period_start=${latestDigest.periodStart?.toISOString() ?? "(null)"}`);
  console.log(`  period_end=${latestDigest.periodEnd?.toISOString() ?? "(null)"}`);
  console.log();

  const items = await db
    .select({
      id: digestItems.id,
      category: digestItems.category,
      headline: digestItems.headline,
      score: digestItems.score,
      competitorName: competitorsTable.name,
      rawSource: rawItems.source,
      rawIngestedAt: rawItems.ingestedAt,
    })
    .from(digestItems)
    .innerJoin(rawItems, eq(rawItems.id, digestItems.rawItemId))
    .innerJoin(competitorsTable, eq(competitorsTable.id, rawItems.competitorId))
    .where(eq(digestItems.digestId, latestDigest.id))
    .orderBy(desc(digestItems.score));
  console.log(`--- digest items as persisted (${items.length}) ---`);
  for (const it of items) {
    console.log(
      `  [${it.category.padEnd(11)} ${String(it.score).padStart(3)}] ${it.competitorName.padEnd(20)} via ${it.rawSource.padEnd(10)} ingested=${it.rawIngestedAt.toISOString().slice(0, 19)}  ${it.headline.slice(0, 60)}`,
    );
  }
  console.log();

  // Summarize whether the diversity fix would have changed anything.
  const persistedComps = new Set(items.map((i) => i.competitorName));
  const simulatedComps = new Set(simSelected.map((i) => i.competitorName));
  console.log(
    `Persisted digest spans ${persistedComps.size} competitor(s): ${[...persistedComps].join(", ")}`,
  );
  console.log(
    `Simulated diverse selection would span ${simulatedComps.size} competitor(s): ${[...simulatedComps].join(", ")}`,
  );
  if (persistedComps.size === simulatedComps.size && persistedComps.size <= 1) {
    console.log(
      "\nDiagnosis: pool is genuinely single-competitor — diversity cap has nothing to swap in. Issue is upstream (ingestion / scoring), not the selection.",
    );
  } else if (persistedComps.size < simulatedComps.size) {
    console.log(
      "\nDiagnosis: diversity cap would have produced a more diverse digest. The persisted digest predates the fix (created before the synth job restarted with the new code) OR the synth job is running stale code.",
    );
  }
}

main()
  .catch((err) => {
    console.error("probe failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPool().end();
  });
