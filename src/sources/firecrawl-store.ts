import { inArray } from 'drizzle-orm'
import { competitorPricingSnapshots } from '~/db/schema'
import type { getDb } from '~/lib/db'
import type { PricingSnapshot } from './firecrawl'

type Db = ReturnType<typeof getDb>

export async function loadLatestPricingSnapshots(
  db: Db,
  competitorIds: string[],
): Promise<Map<string, PricingSnapshot>> {
  const out = new Map<string, PricingSnapshot>()
  if (competitorIds.length === 0) return out

  const rows = await db
    .select()
    .from(competitorPricingSnapshots)
    .where(inArray(competitorPricingSnapshots.competitorId, competitorIds))

  for (const row of rows) {
    out.set(row.competitorId, {
      content: row.content,
      contentHash: row.contentHash,
      scrapedAt: row.scrapedAt,
    })
  }
  return out
}

export async function saveLatestPricingSnapshot(
  db: Db,
  competitorId: string,
  snapshot: PricingSnapshot,
): Promise<void> {
  await db
    .insert(competitorPricingSnapshots)
    .values({
      competitorId,
      content: snapshot.content,
      contentHash: snapshot.contentHash,
      scrapedAt: snapshot.scrapedAt,
    })
    .onConflictDoUpdate({
      target: competitorPricingSnapshots.competitorId,
      set: {
        content: snapshot.content,
        contentHash: snapshot.contentHash,
        scrapedAt: snapshot.scrapedAt,
      },
    })
}
