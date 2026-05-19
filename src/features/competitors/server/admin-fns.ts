import { createServerFn } from "@tanstack/react-start";
import { desc, eq, sql } from "drizzle-orm";
import { competitors, rawItems, userCompetitors } from "~/db/schema";
import { requireAdminSession } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";

// /admin/competitors (PF-59). Cohort-wide view of every competitor row so we
// can spot sourceless feeds and popular targets at a glance. Two correlated
// subqueries collapse user_competitors + raw_items into per-competitor
// rollups in one round trip — same shape as /admin/users (PF-26).

import type { CompetitorAdminRow } from "../shared/types";

export const listCompetitorsForAdmin = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ rows: CompetitorAdminRow[] }> => {
    await requireAdminSession();
    const db = getDb();

    const trackedBy = db
      .select({
        competitorId: userCompetitors.competitorId,
        trackedBy: sql<number>`COUNT(${userCompetitors.userId})::int`.as("tracked_by"),
      })
      .from(userCompetitors)
      .groupBy(userCompetitors.competitorId)
      .as("tracked_by");

    const rawStats = db
      .select({
        competitorId: rawItems.competitorId,
        rawItems7d:
          sql<number>`COUNT(*) FILTER (WHERE ${rawItems.ingestedAt} >= NOW() - INTERVAL '7 days')::int`.as(
            "raw_items_7d",
          ),
        lastIngestedAt: sql<Date | null>`MAX(${rawItems.ingestedAt})`.as("last_ingested_at"),
      })
      .from(rawItems)
      .groupBy(rawItems.competitorId)
      .as("raw_stats");

    const rows = await db
      .select({
        id: competitors.id,
        name: competitors.name,
        homepageUrl: competitors.homepageUrl,
        rssUrl: competitors.rssUrl,
        phSlug: competitors.phSlug,
        pricingUrl: competitors.pricingUrl,
        createdAt: competitors.createdAt,
        trackedBy: trackedBy.trackedBy,
        rawItems7d: rawStats.rawItems7d,
        lastIngestedAt: rawStats.lastIngestedAt,
      })
      .from(competitors)
      .leftJoin(trackedBy, eq(competitors.id, trackedBy.competitorId))
      .leftJoin(rawStats, eq(competitors.id, rawStats.competitorId))
      .orderBy(desc(trackedBy.trackedBy), desc(competitors.createdAt));

    return {
      rows: rows.map<CompetitorAdminRow>((r) => ({
        id: r.id,
        name: r.name,
        homepageUrl: r.homepageUrl,
        rssUrl: r.rssUrl,
        phSlug: r.phSlug,
        pricingUrl: r.pricingUrl,
        createdAt: r.createdAt.toISOString(),
        trackedBy: r.trackedBy ?? 0,
        rawItems7d: r.rawItems7d ?? 0,
        lastIngestedAt: r.lastIngestedAt ? new Date(r.lastIngestedAt).toISOString() : null,
      })),
    };
  },
);
