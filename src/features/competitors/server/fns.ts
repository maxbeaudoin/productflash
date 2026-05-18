import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { competitors as competitorsTable, userCompetitors } from "~/db/schema";
import { requireSession } from "~/shared/server/auth-server";
import { getDb } from "~/shared/server/db";
import { addCompetitorFormSchema } from "~/features/competitors/schema";
import type { CompetitorView } from "~/features/competitors/shared/types";
import { autodetectRSSForHomepage } from "~/sources/rss";

export type { CompetitorView };

// Shared add/remove for /app/onboarding and /app/profile. The body of these
// fns was identical across the two routes — extracted here so that the
// per-route routes only carry their differing handlers (e.g. editProfile,
// which has divergent schemas + cache-invalidation semantics).

export const addCompetitor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => addCompetitorFormSchema.parse(data))
  .handler(async ({ data }): Promise<{ competitor: CompetitorView }> => {
    const session = await requireSession();
    const db = getDb();

    // Auto-detect RSS so the manually-added competitor matches what the
    // agent would have done. Failure is silent — a competitor without an
    // rss_url is still usable (Firehose + Firecrawl still cover it).
    let rssUrl: string | null = null;
    try {
      rssUrl = await autodetectRSSForHomepage(data.homepageUrl);
    } catch {
      rssUrl = null;
    }

    // First-writer-wins on the competitors row: insert if the URL is new,
    // do nothing if it already exists. User-facing add MUST NOT overwrite
    // name/rss_url on an existing row — otherwise an authed user can
    // mutate every other user's view of "Notion" or repoint the shared
    // RSS feed at an attacker-controlled URL. The link from this user to
    // the (existing or newly-inserted) row goes through user_competitors.
    await db
      .insert(competitorsTable)
      .values({
        name: data.name,
        homepageUrl: data.homepageUrl,
        rssUrl,
      })
      .onConflictDoNothing({ target: competitorsTable.homepageUrl });

    const [c] = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
      })
      .from(competitorsTable)
      .where(eq(competitorsTable.homepageUrl, data.homepageUrl))
      .limit(1);
    if (!c) throw new Error("competitor_upsert_failed");

    await db
      .insert(userCompetitors)
      .values({ userId: session.user.id, competitorId: c.id })
      .onConflictDoNothing();

    return { competitor: c };
  });

const removeCompetitorSchema = z.object({
  competitorId: z.string().uuid(),
});

export const removeCompetitor = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => removeCompetitorSchema.parse(data))
  .handler(async ({ data }) => {
    const session = await requireSession();
    const db = getDb();
    await db
      .delete(userCompetitors)
      .where(
        and(
          eq(userCompetitors.userId, session.user.id),
          eq(userCompetitors.competitorId, data.competitorId),
        ),
      );
    return { ok: true as const };
  });
