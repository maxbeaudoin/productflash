import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  adminAudit,
  competitorPricingSnapshots,
  competitors,
  digestItems,
  feedback,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import type {
  AdminAuditPayload,
  AdminAuditRow,
  JsonValue,
} from "~/features/admin-audit/shared/types";
import { requireAdminSession } from "~/features/auth/server/session";
import { competitorEditFormSchema } from "~/features/competitors/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";

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

// /admin/competitors/:id (PF-66). Single fat loader instead of one server
// fn per tab so the page renders in one DB round-trip — admin volume is low
// and the tab switch is purely client-side. Same pattern as
// loadUserDetail in routes/admin/users/$userId.tsx.

export type CompetitorDetailRow = {
  id: string;
  name: string;
  homepageUrl: string;
  rssUrl: string | null;
  phSlug: string | null;
  pricingUrl: string | null;
  createdAt: string;
};

export type CompetitorUserRow = {
  userId: string;
  email: string;
  addedAt: string;
};

export type CompetitorIngestionRow = {
  source: "rss" | "ph" | "firehose" | "firecrawl";
  count24h: number;
  count7d: number;
  count30d: number;
  lastIngestedAt: string | null;
};

export type CompetitorRawItemRow = {
  id: string;
  title: string;
  source: "rss" | "ph" | "firehose" | "firecrawl";
  publishedAt: string | null;
  ingestedAt: string;
  url: string;
};

export type CompetitorPricingView = {
  content: string;
  contentHash: string;
  scrapedAt: string;
};

export type CompetitorFeedbackRatio = {
  up: number;
  down: number;
};

export type CompetitorDetailData = {
  competitor: CompetitorDetailRow;
  trackedBy: number;
  usersTracking: CompetitorUserRow[];
  ingestion: CompetitorIngestionRow[];
  // Signal-to-noise window: how many of this competitor's raw_items (last
  // 30d) the synthesizer actually picked up into a digest. Aggregated
  // across all users so it answers "is this competitor worth keeping in
  // the ingestion pool?" not "did one user see anything?".
  digestHitRate: { rawCount30d: number; digestCount30d: number };
  recentItems: CompetitorRawItemRow[];
  pricing: CompetitorPricingView | null;
  feedback: CompetitorFeedbackRatio;
  auditRows: AdminAuditRow[];
};

const RAW_ITEM_LIMIT = 50;
const PER_TARGET_AUDIT_LIMIT = 50;
const SOURCES_ORDER: CompetitorIngestionRow["source"][] = ["rss", "ph", "firecrawl", "firehose"];

export const loadCompetitorDetail = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ competitorId: z.string().uuid() }).parse(data))
  .handler(async ({ data }): Promise<CompetitorDetailData> => {
    await requireAdminSession();
    const db = getDb();

    const [competitor] = await db
      .select()
      .from(competitors)
      .where(eq(competitors.id, data.competitorId))
      .limit(1);
    if (!competitor) throw notFound();

    const usersTrackingRows = await db
      .select({
        userId: users.id,
        email: users.email,
        addedAt: userCompetitors.createdAt,
      })
      .from(userCompetitors)
      .innerJoin(users, eq(users.id, userCompetitors.userId))
      .where(eq(userCompetitors.competitorId, competitor.id))
      .orderBy(desc(userCompetitors.createdAt));

    const ingestionRows = await db
      .select({
        source: rawItems.source,
        count24h:
          sql<number>`COUNT(*) FILTER (WHERE ${rawItems.ingestedAt} >= NOW() - INTERVAL '24 hours')::int`.as(
            "count_24h",
          ),
        count7d:
          sql<number>`COUNT(*) FILTER (WHERE ${rawItems.ingestedAt} >= NOW() - INTERVAL '7 days')::int`.as(
            "count_7d",
          ),
        count30d:
          sql<number>`COUNT(*) FILTER (WHERE ${rawItems.ingestedAt} >= NOW() - INTERVAL '30 days')::int`.as(
            "count_30d",
          ),
        lastIngestedAt: sql<Date | null>`MAX(${rawItems.ingestedAt})`.as("last_ingested_at"),
      })
      .from(rawItems)
      .where(eq(rawItems.competitorId, competitor.id))
      .groupBy(rawItems.source);
    const ingestionBySource = new Map<string, (typeof ingestionRows)[number]>();
    for (const r of ingestionRows) ingestionBySource.set(r.source, r);
    const ingestion: CompetitorIngestionRow[] = SOURCES_ORDER.map((src) => {
      const row = ingestionBySource.get(src);
      return {
        source: src,
        count24h: row?.count24h ?? 0,
        count7d: row?.count7d ?? 0,
        count30d: row?.count30d ?? 0,
        lastIngestedAt: row?.lastIngestedAt ? new Date(row.lastIngestedAt).toISOString() : null,
      };
    });

    const recentItemRows = await db
      .select({
        id: rawItems.id,
        title: rawItems.title,
        source: rawItems.source,
        publishedAt: rawItems.publishedAt,
        ingestedAt: rawItems.ingestedAt,
        url: rawItems.url,
      })
      .from(rawItems)
      .where(eq(rawItems.competitorId, competitor.id))
      .orderBy(desc(rawItems.ingestedAt))
      .limit(RAW_ITEM_LIMIT);

    const [rawCountAgg] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(rawItems)
      .where(
        and(
          eq(rawItems.competitorId, competitor.id),
          sql`${rawItems.ingestedAt} >= NOW() - INTERVAL '30 days'`,
        ),
      );

    const [digestCountAgg] = await db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(digestItems)
      .innerJoin(rawItems, eq(digestItems.rawItemId, rawItems.id))
      .where(
        and(
          eq(rawItems.competitorId, competitor.id),
          sql`${rawItems.ingestedAt} >= NOW() - INTERVAL '30 days'`,
        ),
      );

    const [pricingRow] = await db
      .select({
        content: competitorPricingSnapshots.content,
        contentHash: competitorPricingSnapshots.contentHash,
        scrapedAt: competitorPricingSnapshots.scrapedAt,
      })
      .from(competitorPricingSnapshots)
      .where(eq(competitorPricingSnapshots.competitorId, competitor.id))
      .limit(1);

    const feedbackAgg = await db
      .select({
        rating: feedback.rating,
        c: sql<number>`COUNT(*)::int`,
      })
      .from(feedback)
      .innerJoin(digestItems, eq(digestItems.id, feedback.digestItemId))
      .innerJoin(rawItems, eq(rawItems.id, digestItems.rawItemId))
      .where(eq(rawItems.competitorId, competitor.id))
      .groupBy(feedback.rating);
    const feedbackRatio: CompetitorFeedbackRatio = { up: 0, down: 0 };
    for (const r of feedbackAgg) {
      if (r.rating === "up") feedbackRatio.up = r.c;
      else if (r.rating === "down") feedbackRatio.down = r.c;
    }

    // Inlined per the same constraint that drove the user-detail loader:
    // a plain helper that imports `~/db/*` would leak pg into the client
    // bundle. listAuditForTarget is a serverFn — calling it from inside
    // another serverFn would add an HTTP hop, so we re-issue the SELECT.
    const auditRaw = await db
      .select({
        id: adminAudit.id,
        actorId: adminAudit.actorId,
        actorEmail: users.email,
        targetKind: adminAudit.targetKind,
        targetId: adminAudit.targetId,
        action: adminAudit.action,
        payload: adminAudit.payload,
        createdAt: adminAudit.createdAt,
      })
      .from(adminAudit)
      .leftJoin(users, eq(users.id, adminAudit.actorId))
      .where(and(eq(adminAudit.targetKind, "competitor"), eq(adminAudit.targetId, competitor.id)))
      .orderBy(desc(adminAudit.createdAt))
      .limit(PER_TARGET_AUDIT_LIMIT);
    const auditRows: AdminAuditRow[] = auditRaw.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      actorEmail: r.actorEmail,
      targetKind: r.targetKind,
      targetId: r.targetId,
      // Every row targets this same competitor; the per-target list hides
      // the target column anyway.
      targetLabel: competitor.name,
      action: r.action,
      payload: (r.payload ?? {}) as AdminAuditPayload,
      createdAt: r.createdAt.toISOString(),
    }));

    return {
      competitor: {
        id: competitor.id,
        name: competitor.name,
        homepageUrl: competitor.homepageUrl,
        rssUrl: competitor.rssUrl,
        phSlug: competitor.phSlug,
        pricingUrl: competitor.pricingUrl,
        createdAt: competitor.createdAt.toISOString(),
      },
      trackedBy: usersTrackingRows.length,
      usersTracking: usersTrackingRows.map((u) => ({
        userId: u.userId,
        email: u.email,
        addedAt: u.addedAt.toISOString(),
      })),
      ingestion,
      digestHitRate: {
        rawCount30d: rawCountAgg?.c ?? 0,
        digestCount30d: digestCountAgg?.c ?? 0,
      },
      recentItems: recentItemRows.map((r) => ({
        id: r.id,
        title: r.title,
        source: r.source,
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
        ingestedAt: r.ingestedAt.toISOString(),
        url: r.url,
      })),
      pricing: pricingRow
        ? {
            content: pricingRow.content,
            contentHash: pricingRow.contentHash,
            scrapedAt: pricingRow.scrapedAt.toISOString(),
          }
        : null,
      feedback: feedbackRatio,
      auditRows,
    };
  });

const updateInput = z.object({
  competitorId: z.string().uuid(),
  values: competitorEditFormSchema,
});

type FieldDiff = { before: string | null; after: string | null };

export const updateCompetitorFields = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => updateInput.parse(raw))
  .handler(async ({ data }): Promise<{ changed: boolean }> => {
    const session = await requireAdminSession();
    const db = getDb();

    const [before] = await db
      .select()
      .from(competitors)
      .where(eq(competitors.id, data.competitorId))
      .limit(1);
    if (!before) throw new Error("competitor_not_found");

    const next = {
      name: data.values.name,
      homepageUrl: data.values.homepageUrl,
      rssUrl: data.values.rssUrl ?? null,
      phSlug: data.values.phSlug ?? null,
      pricingUrl: data.values.pricingUrl ?? null,
    };

    const diff: { [field: string]: FieldDiff } = {};
    if (before.name !== next.name) diff.name = { before: before.name, after: next.name };
    if (before.homepageUrl !== next.homepageUrl)
      diff.homepageUrl = { before: before.homepageUrl, after: next.homepageUrl };
    if (before.rssUrl !== next.rssUrl) diff.rssUrl = { before: before.rssUrl, after: next.rssUrl };
    if (before.phSlug !== next.phSlug) diff.phSlug = { before: before.phSlug, after: next.phSlug };
    if (before.pricingUrl !== next.pricingUrl)
      diff.pricingUrl = { before: before.pricingUrl, after: next.pricingUrl };

    if (Object.keys(diff).length === 0) return { changed: false };

    await db.update(competitors).set(next).where(eq(competitors.id, data.competitorId));

    try {
      await db.insert(adminAudit).values({
        actorId: session.user.id,
        targetKind: "competitor",
        targetId: data.competitorId,
        action: "competitor_edit",
        payload: diff as { [key: string]: JsonValue },
      });
    } catch (err) {
      logger.error({ err, target: data.competitorId }, "admin_audit_write_failed");
    }

    logger.info(
      { admin: session.user.email, target: data.competitorId, fields: Object.keys(diff) },
      "admin: competitor edited",
    );

    return { changed: true };
  });
