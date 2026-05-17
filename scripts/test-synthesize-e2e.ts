import { and, eq, gte, sql } from "drizzle-orm";
import {
  competitors as competitorsTable,
  digestItems,
  digests,
  itemScores,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import { runSynthesis } from "~/jobs/synthesize";
import { getDb, getPool } from "~/lib/db";
import { logger } from "~/lib/logger";
import { shutdownPosthog } from "~/lib/posthog";

// End-to-end DB validation for the synthesis job.
//
// Creates a transient active user, links them to the three most-active
// competitors in the seed set, manually seeds a small spread of item_scores
// pulled from real raw_items (sidestepping a full Haiku run across 1600+
// items), then runs the synthesis job and asserts that a digest + N
// digest_items land in the DB. Re-runs to verify idempotency. Tears
// everything down on the way out so the dev DB is left as we found it.
//
//   ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... \
//     pnpm tsx scripts/test-synthesize-e2e.ts

const TARGET_COMPETITORS = ["PostHog", "Resend", "Amplitude"];
const ITEMS_PER_COMPETITOR = 3;

interface SeedItemPlan {
  rawItemId: string;
  category: "launch" | "pricing" | "feature" | "positioning" | "noise";
  score: number;
  why: string;
}

async function main() {
  const db = getDb();
  const userId = await createUser(db);
  logger.info({ userId }, "e2e: created test user");

  try {
    const competitorIds = await linkCompetitors(db, userId);
    logger.info({ userId, competitorIds }, "e2e: linked competitors");

    const seeded = await seedScores(db, userId, competitorIds);
    logger.info({ count: seeded }, "e2e: seeded item_scores");

    if (seeded === 0) {
      throw new Error("e2e: no real raw_items available to seed scores — abort");
    }

    const metrics = await runSynthesis();
    logger.info(metrics, "e2e: first synthesize complete");

    const after = await readDigest(db, userId);
    assert(after.digestCount === 1, `expected 1 digest, got ${after.digestCount}`);
    assert(after.itemCount >= 1, `expected ≥1 digest_items, got ${after.itemCount}`);
    assert(
      after.itemCount === after.digestItemCountField,
      `digest.item_count (${after.digestItemCountField}) must match actual rows (${after.itemCount})`,
    );
    logger.info(after, "e2e: digest state after first run");

    // Re-run: should reuse the same digest row, replace items in place.
    const beforeDigestId = after.digestId;
    await runSynthesis();
    const after2 = await readDigest(db, userId);
    assert(after2.digestCount === 1, `re-run: expected 1 digest, got ${after2.digestCount}`);
    assert(after2.digestId === beforeDigestId, "re-run: digest row should be reused");
    assert(
      after2.itemCount === after.itemCount,
      `re-run: digest_items count should be stable (${after.itemCount} → ${after2.itemCount})`,
    );
    logger.info(after2, "e2e: idempotency confirmed");

    logger.info("e2e: ✅ synthesize end-to-end passes");
  } finally {
    await cleanup(db, userId);
    logger.info({ userId }, "e2e: cleaned up test user");
  }
}

async function createUser(db: ReturnType<typeof getDb>): Promise<string> {
  const email = `e2e-synth-${Date.now()}@example.test`;
  const rows = await db
    .insert(users)
    .values({ email, name: "E2E Synth Tester", tz: "UTC", status: "active" })
    .returning({ id: users.id });
  return rows[0].id;
}

async function linkCompetitors(db: ReturnType<typeof getDb>, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: competitorsTable.id, name: competitorsTable.name })
    .from(competitorsTable);
  const ids = rows.filter((r) => TARGET_COMPETITORS.includes(r.name)).map((r) => r.id);
  if (ids.length === 0) {
    throw new Error(`e2e: none of target competitors ${TARGET_COMPETITORS.join(", ")} exist`);
  }
  await db.insert(userCompetitors).values(ids.map((competitorId) => ({ userId, competitorId })));
  return ids;
}

async function seedScores(
  db: ReturnType<typeof getDb>,
  userId: string,
  competitorIds: string[],
): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const plans: SeedItemPlan[] = [];

  // Pre-defined category/score spread per competitor so the Sonnet input
  // covers the non-noise category space.
  const profile: Array<{ category: SeedItemPlan["category"]; score: number; why: string }> = [
    { category: "launch", score: 90, why: "Major new product surface for category leader." },
    { category: "feature", score: 65, why: "Meaningful shipped feature with cross-tier reach." },
    {
      category: "positioning",
      score: 75,
      why: "Marketing/strategy shift visible on the home page.",
    },
  ];

  for (const competitorId of competitorIds) {
    const candidates = await db
      .select({ id: rawItems.id })
      .from(rawItems)
      .where(and(eq(rawItems.competitorId, competitorId), gte(rawItems.ingestedAt, cutoff)))
      .orderBy(sql`ingested_at desc`)
      .limit(ITEMS_PER_COMPETITOR);

    candidates.forEach((row, i) => {
      const p = profile[i % profile.length];
      plans.push({ rawItemId: row.id, category: p.category, score: p.score, why: p.why });
    });
  }

  if (plans.length === 0) return 0;
  await db.insert(itemScores).values(plans.map((p) => ({ userId, ...p })));
  return plans.length;
}

interface DigestState {
  digestCount: number;
  digestId: string | null;
  digestItemCountField: number;
  itemCount: number;
}

async function readDigest(db: ReturnType<typeof getDb>, userId: string): Promise<DigestState> {
  const allDigests = await db.select().from(digests).where(eq(digests.userId, userId));
  const digestCount = allDigests.length;
  if (digestCount === 0) {
    return { digestCount: 0, digestId: null, digestItemCountField: 0, itemCount: 0 };
  }
  const d = allDigests[0];
  const items = await db
    .select({ id: digestItems.id })
    .from(digestItems)
    .where(eq(digestItems.digestId, d.id));
  return {
    digestCount,
    digestId: d.id,
    digestItemCountField: d.itemCount,
    itemCount: items.length,
  };
}

async function cleanup(db: ReturnType<typeof getDb>, userId: string): Promise<void> {
  // FKs cascade from users → user_competitors / item_scores / digests, and
  // from digests → digest_items, so deleting the user wipes everything we
  // created in this run.
  await db.delete(users).where(eq(users.id, userId));
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

main()
  .catch((err) => {
    logger.fatal({ err }, "e2e: failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
    await getPool().end();
  });
