import { eq } from "drizzle-orm";
import { getDb, getPool } from "~/shared/server/db";
import {
  competitors,
  digestItems,
  digests,
  feedback,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";

// One-off smoke test: round-trip an insert through every table to verify FKs,
// enums, defaults, and unique constraints behave as expected. Cleans up after
// itself. Run with: pnpm tsx scripts/smoke-schema.ts

async function main() {
  const db = getDb();

  const email = `smoke+${Date.now()}@productflash.test`;
  const [user] = await db
    .insert(users)
    .values({ email, name: "Smoke Test", tz: "Europe/Paris" })
    .returning();
  if (!user) throw new Error("user insert returned no row");

  const [comp] = await db.select().from(competitors).limit(1);
  if (!comp) throw new Error("expected at least one seeded competitor");

  await db.insert(userCompetitors).values({ userId: user.id, competitorId: comp.id });

  const [item] = await db
    .insert(rawItems)
    .values({
      competitorId: comp.id,
      source: "rss",
      sourceId: `smoke-${Date.now()}`,
      url: "https://example.com/smoke",
      title: "Smoke test item",
      body: "Body text",
      publishedAt: new Date(),
    })
    .returning();
  if (!item) throw new Error("raw_item insert returned no row");

  const [digest] = await db.insert(digests).values({ userId: user.id, itemCount: 1 }).returning();
  if (!digest) throw new Error("digest insert returned no row");

  const [di] = await db
    .insert(digestItems)
    .values({
      userId: user.id,
      digestId: digest.id,
      rawItemId: item.id,
      category: "launch",
      headline: "Headline",
      snippet: "Snippet",
      impactNote: "Impact",
      score: 87,
    })
    .returning();
  if (!di) throw new Error("digest_item insert returned no row");

  await db.insert(feedback).values({
    digestItemId: di.id,
    userId: user.id,
    rating: "up",
  });

  const fetched = await db.select().from(users).where(eq(users.id, user.id));
  if (fetched.length !== 1 || fetched[0]!.status !== "pending") {
    throw new Error("user select did not return expected row");
  }

  // raw_items.competitor_id, not user_id — so user cascade doesn't reach it.
  // Delete the row we inserted explicitly to keep the table clean for #8.
  await db.delete(rawItems).where(eq(rawItems.id, item.id));
  await db.delete(users).where(eq(users.id, user.id));

  const remaining = await db.select().from(users).where(eq(users.id, user.id));
  if (remaining.length !== 0) throw new Error("cascade delete left rows behind");

  console.log("OK: insert + select + cascade delete all round-tripped");
  await getPool().end();
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
