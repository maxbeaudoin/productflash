import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  adminAudit,
  competitorPricingSnapshots,
  competitorSources,
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
import {
  applySourceRemove,
  applySourceStatus,
  applySourceUrlUpdate,
} from "~/features/competitors/server/source-actions";
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

// Per-competitor source row (PF-93 phase 3). Replaces the legacy
// `CompetitorIngestionRow` (grouped by `raw_items.source`) with the
// `competitor_sources`-driven shape: one row per discovered source, even if
// it has never ingested an item yet.
export type CompetitorSourceRow = {
  id: string;
  sourceType: "rss" | "webpage" | "x" | "linkedin" | "youtube";
  extractionMode: "feed_poll" | "snapshot_diff" | "list_extract" | "post_stream" | null;
  urlOrHandle: string;
  status: "active" | "failing" | "disabled";
  lastFetchedAt: string | null;
  agentRationale: string | null;
  createdAt: string;
  itemCount30d: number;
};

// One-line ingestion roll-up rendered above the per-source list — answers
// "is this competitor producing signal at all?" without the operator
// scanning every row.
export type CompetitorSourcesRollup = {
  activeCount: number;
  totalItems30d: number;
  lastIngestedAt: string | null;
};

export type CompetitorRawItemRow = {
  id: string;
  title: string;
  source: "rss" | "ph" | "firehose" | "firecrawl" | "webpage";
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
  sources: CompetitorSourceRow[];
  sourcesRollup: CompetitorSourcesRollup;
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

    // Per-source rows (PF-93 phase 3). One row per `competitor_sources`
    // entry — surfaces sources with zero ingest history (newly-discovered
    // or inert socials) which the old per-`raw_items.source` aggregation
    // could never show. items-in-30d is a correlated subquery so we keep
    // the query to a single round trip and still get a row per source
    // regardless of whether raw_items references it yet.
    const sourceRows = await db
      .select({
        id: competitorSources.id,
        sourceType: competitorSources.sourceType,
        extractionMode: competitorSources.extractionMode,
        urlOrHandle: competitorSources.urlOrHandle,
        status: competitorSources.status,
        lastFetchedAt: competitorSources.lastFetchedAt,
        agentRationale: competitorSources.agentRationale,
        createdAt: competitorSources.createdAt,
        itemCount30d: sql<number>`(
          SELECT COUNT(*)::int FROM ${rawItems}
          WHERE ${rawItems.competitorSourceId} = ${competitorSources.id}
            AND ${rawItems.ingestedAt} >= NOW() - INTERVAL '30 days'
        )`.as("item_count_30d"),
      })
      .from(competitorSources)
      .where(eq(competitorSources.competitorId, competitor.id))
      .orderBy(asc(competitorSources.createdAt));

    const sources: CompetitorSourceRow[] = sourceRows.map((r) => ({
      id: r.id,
      sourceType: r.sourceType,
      extractionMode: r.extractionMode,
      urlOrHandle: r.urlOrHandle,
      status: r.status,
      lastFetchedAt: r.lastFetchedAt ? new Date(r.lastFetchedAt).toISOString() : null,
      agentRationale: r.agentRationale,
      createdAt: r.createdAt.toISOString(),
      itemCount30d: r.itemCount30d ?? 0,
    }));

    // Overall ingestion roll-up — across ALL raw_items rows for this
    // competitor, not just those pointing at a competitor_source. Keeps
    // the legacy ingestion (rss adapter still groups by `source='rss'`)
    // visible at the top until phase-4 watchers migrate emitters.
    const [overallStats] = await db
      .select({
        totalItems30d:
          sql<number>`COUNT(*) FILTER (WHERE ${rawItems.ingestedAt} >= NOW() - INTERVAL '30 days')::int`.as(
            "total_items_30d",
          ),
        lastIngestedAt: sql<Date | null>`MAX(${rawItems.ingestedAt})`.as("last_ingested_at"),
      })
      .from(rawItems)
      .where(eq(rawItems.competitorId, competitor.id));
    const sourcesRollup: CompetitorSourcesRollup = {
      activeCount: sources.filter((s) => s.status === "active").length,
      totalItems30d: overallStats?.totalItems30d ?? 0,
      lastIngestedAt: overallStats?.lastIngestedAt
        ? new Date(overallStats.lastIngestedAt).toISOString()
        : null,
    };

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
      sources,
      sourcesRollup,
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

// --- competitor_sources mutations (PF-93 phase 3) --------------------------
// Three thin wrappers — auth + input validation here, all SQL + audit lives
// in `./source-actions.ts` so the contract can be integration-tested without
// booting TanStack Start. Same split as `~/shared/server/feedback-rating.ts`.

const sourceStatusInput = z.object({
  sourceId: z.string().uuid(),
  status: z.enum(["active", "disabled"]),
});

export const setCompetitorSourceStatus = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sourceStatusInput.parse(raw))
  .handler(async ({ data }): Promise<{ changed: boolean }> => {
    const session = await requireAdminSession();
    return applySourceStatus({
      actorId: session.user.id,
      actorEmail: session.user.email,
      sourceId: data.sourceId,
      status: data.status,
    });
  });

const sourceRemoveInput = z.object({ sourceId: z.string().uuid() });

export const removeCompetitorSource = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sourceRemoveInput.parse(raw))
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const session = await requireAdminSession();
    return applySourceRemove({
      actorId: session.user.id,
      actorEmail: session.user.email,
      sourceId: data.sourceId,
    });
  });

const sourceUrlInput = z.object({
  sourceId: z.string().uuid(),
  urlOrHandle: z
    .string()
    .trim()
    .min(1, { message: "URL or @handle is required." })
    .max(500, { message: "URL is too long." }),
});

export const updateCompetitorSourceUrl = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => sourceUrlInput.parse(raw))
  .handler(async ({ data }): Promise<{ changed: boolean }> => {
    const session = await requireAdminSession();
    return applySourceUrlUpdate({
      actorId: session.user.id,
      actorEmail: session.user.email,
      sourceId: data.sourceId,
      urlOrHandle: data.urlOrHandle,
    });
  });
