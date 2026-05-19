import { eq } from "drizzle-orm";
import { adminAudit, competitorSources } from "~/db/schema";
import type { JsonValue } from "~/features/admin-audit/shared/types";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { normalizeUrl } from "~/shared/iso/url";

// Per-competitor-source admin mutations (PF-93 phase 3 / PF-96). Extracted
// from the createServerFn handlers in `./admin-fns.ts` so the contract can
// be integration-tested without booting TanStack Start's runtime — same
// pattern as `~/shared/server/feedback-rating.ts`. The createServerFn
// wrappers in admin-fns.ts handle `requireAdminSession` + input validation
// and then delegate to these helpers.
//
// All three audit-target the *competitor* (not the source) so the rows land
// in the existing Audit tab on the same detail page next to `competitor_edit`.

export async function applySourceStatus(opts: {
  actorId: string;
  actorEmail: string;
  sourceId: string;
  status: "active" | "disabled";
}): Promise<{ changed: boolean }> {
  const db = getDb();
  const [before] = await db
    .select()
    .from(competitorSources)
    .where(eq(competitorSources.id, opts.sourceId))
    .limit(1);
  if (!before) throw new Error("source_not_found");
  if (before.status === opts.status) return { changed: false };

  await db
    .update(competitorSources)
    .set({ status: opts.status })
    .where(eq(competitorSources.id, opts.sourceId));

  try {
    await db.insert(adminAudit).values({
      actorId: opts.actorId,
      targetKind: "competitor",
      targetId: before.competitorId,
      action: opts.status === "disabled" ? "competitor_source_disable" : "competitor_source_enable",
      payload: {
        sourceId: before.id,
        sourceType: before.sourceType,
        urlOrHandle: before.urlOrHandle,
        before: before.status,
        after: opts.status,
      } as { [key: string]: JsonValue },
    });
  } catch (err) {
    logger.error({ err, target: before.competitorId }, "admin_audit_write_failed");
  }

  logger.info(
    {
      admin: opts.actorEmail,
      target: before.competitorId,
      source: before.id,
      before: before.status,
      after: opts.status,
    },
    "admin: competitor source status changed",
  );

  return { changed: true };
}

export async function applySourceRemove(opts: {
  actorId: string;
  actorEmail: string;
  sourceId: string;
}): Promise<{ removed: boolean }> {
  const db = getDb();
  const [before] = await db
    .select()
    .from(competitorSources)
    .where(eq(competitorSources.id, opts.sourceId))
    .limit(1);
  if (!before) throw new Error("source_not_found");

  // raw_items.competitor_source_id is ON DELETE SET NULL — items the user
  // has already seen stay in their history. The user-visible row
  // disappears from /admin/competitors/[id]; that's the intended blast
  // radius.
  await db.delete(competitorSources).where(eq(competitorSources.id, opts.sourceId));

  try {
    await db.insert(adminAudit).values({
      actorId: opts.actorId,
      targetKind: "competitor",
      targetId: before.competitorId,
      action: "competitor_source_remove",
      payload: {
        sourceId: before.id,
        sourceType: before.sourceType,
        urlOrHandle: before.urlOrHandle,
        status: before.status,
      } as { [key: string]: JsonValue },
    });
  } catch (err) {
    logger.error({ err, target: before.competitorId }, "admin_audit_write_failed");
  }

  logger.info(
    {
      admin: opts.actorEmail,
      target: before.competitorId,
      source: before.id,
      sourceType: before.sourceType,
    },
    "admin: competitor source removed",
  );

  return { removed: true };
}

export async function applySourceUrlUpdate(opts: {
  actorId: string;
  actorEmail: string;
  sourceId: string;
  urlOrHandle: string;
}): Promise<{ changed: boolean }> {
  const db = getDb();
  const [before] = await db
    .select()
    .from(competitorSources)
    .where(eq(competitorSources.id, opts.sourceId))
    .limit(1);
  if (!before) throw new Error("source_not_found");

  // rss/webpage must be http(s) URLs; socials accept @handle or URL. Mirrors
  // the discovery agent's `record_source` validation so admin edits can't
  // bypass what the agent enforces.
  const next = opts.urlOrHandle.trim();
  const isSocial =
    before.sourceType === "x" ||
    before.sourceType === "linkedin" ||
    before.sourceType === "youtube";

  let normalized: string;
  if (isSocial) {
    if (!next.startsWith("@") && !/^https?:\/\//i.test(next)) {
      throw new Error("invalid_handle");
    }
    normalized = next;
  } else {
    const candidate = normalizeUrl(next);
    if (!candidate) throw new Error("invalid_url");
    normalized = candidate;
  }

  if (normalized === before.urlOrHandle) return { changed: false };

  await db
    .update(competitorSources)
    .set({ urlOrHandle: normalized, lastFetchedAt: null, lastContentHash: null })
    .where(eq(competitorSources.id, opts.sourceId));

  try {
    await db.insert(adminAudit).values({
      actorId: opts.actorId,
      targetKind: "competitor",
      targetId: before.competitorId,
      action: "competitor_source_edit_url",
      payload: {
        sourceId: before.id,
        sourceType: before.sourceType,
        before: before.urlOrHandle,
        after: normalized,
      } as { [key: string]: JsonValue },
    });
  } catch (err) {
    logger.error({ err, target: before.competitorId }, "admin_audit_write_failed");
  }

  logger.info(
    {
      admin: opts.actorEmail,
      target: before.competitorId,
      source: before.id,
      before: before.urlOrHandle,
      after: normalized,
    },
    "admin: competitor source url edited",
  );

  return { changed: true };
}
