import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DigestItemCard, type DigestItemView } from "~/features/digest/ui/DigestItemCard";
import { digestItems, digests, feedback, rawItems } from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import { requireSession } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";
import { deriveDigestPeriod } from "~/features/digest/shared/digest-period";
import { signFeedbackToken } from "~/shared/server/feedback-token";
import { captureServerEvent } from "~/shared/server/posthog";

type DigestView = {
  id: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  itemCount: number;
  items: DigestItemView[];
};

function buildFeedbackUrls(digestItemId: string) {
  return {
    up: `/r/${digestItemId}/up?t=${signFeedbackToken(digestItemId, "up")}`,
    down: `/r/${digestItemId}/down?t=${signFeedbackToken(digestItemId, "down")}`,
  };
}

const loadDigest = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ digestId: z.string().uuid() }).parse(data))
  .handler(async ({ data }): Promise<DigestView> => {
    const session = await requireSession();
    const db = getDb();

    const [digest] = await db
      .select()
      .from(digests)
      .where(and(eq(digests.id, data.digestId), eq(digests.userId, session.user.id)))
      .limit(1);
    if (!digest) throw notFound();

    const rows = await db
      .select({
        id: digestItems.id,
        category: digestItems.category,
        headline: digestItems.headline,
        snippet: digestItems.snippet,
        impactNote: digestItems.impactNote,
        score: digestItems.score,
        occurredAt: digestItems.occurredAt,
        sourceUrl: rawItems.url,
      })
      .from(digestItems)
      .innerJoin(rawItems, eq(digestItems.rawItemId, rawItems.id))
      .where(eq(digestItems.digestId, digest.id))
      .orderBy(desc(digestItems.score), asc(digestItems.createdAt));

    const feedbackRows = rows.length
      ? await db
          .select({
            digestItemId: feedback.digestItemId,
            rating: feedback.rating,
            comment: feedback.comment,
          })
          .from(feedback)
          .where(eq(feedback.userId, session.user.id))
      : [];
    const feedbackByItem = new Map(
      feedbackRows.map((f) => [f.digestItemId, { rating: f.rating, comment: f.comment }] as const),
    );

    captureServerEvent(session.user.id, "digest_rendered_in_app", {
      digest_id: digest.id,
      item_count: digest.itemCount,
      digest_created_at: digest.createdAt.toISOString(),
    });

    return {
      id: digest.id,
      createdAt: digest.createdAt.toISOString(),
      periodStart: digest.periodStart ? digest.periodStart.toISOString() : null,
      periodEnd: digest.periodEnd ? digest.periodEnd.toISOString() : null,
      itemCount: digest.itemCount,
      items: rows.map<DigestItemView>((r) => ({
        id: r.id,
        category: r.category as DigestTag,
        headline: r.headline,
        snippet: r.snippet,
        impactNote: r.impactNote,
        sourceUrl: r.sourceUrl,
        occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
        feedback: feedbackByItem.get(r.id)?.rating ?? null,
        feedbackComment: feedbackByItem.get(r.id)?.comment ?? null,
        feedbackUrls: buildFeedbackUrls(r.id),
      })),
    };
  });

const paramsSchema = z.object({ digestId: z.string().uuid() });

export const Route = createFileRoute("/app/digests/$digestId")({
  loader: async ({ params }) => {
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) throw notFound();
    return loadDigest({ data: parsed.data });
  },
  component: DigestDetailPage,
});

function DigestDetailPage() {
  const digest = Route.useLoaderData();
  const period = deriveDigestPeriod({
    periodStart: digest.periodStart,
    periodEnd: digest.periodEnd,
  });
  const created = new Date(digest.createdAt);
  const fallbackDateLabel = created
    .toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
  const fallbackTimeLabel = created.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const headerLabel = headerLabelFor(period.kind);
  const headerMetaLabel =
    period.rangeLabel?.toUpperCase() ?? `${fallbackDateLabel} · ${fallbackTimeLabel}`;

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-12">
      <Link
        to="/app/digests"
        className="mb-8 inline-flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-[#8a8a98] hover:text-white"
      >
        <span aria-hidden>←</span> All digests
      </Link>

      <div
        className="overflow-hidden rounded-card-lg border border-[#2a2a38] bg-ink-soft"
        style={{ boxShadow: "0 40px 80px rgba(0,0,0,0.4)" }}
      >
        <div className="flex items-center justify-between border-b border-[#2a2a38] bg-[#1a1a23] px-7 py-5">
          <div className="text-[13px] text-[#888]">
            <strong className="font-semibold text-white">Product Flash</strong> · {headerLabel}
          </div>
          <div className="font-mono text-xs text-[#666]">{headerMetaLabel}</div>
        </div>

        <div className="px-7 py-9">
          {digest.items.length === 0 ? (
            <EmptyDigestBody periodKind={period.kind} daysBack={period.daysBack} />
          ) : (
            <>
              <div className="mb-6 text-sm text-[#888]">
                {greetingFor(digest.items.length, period.kind, period.daysBack)}
              </div>
              {digest.items.map((item: DigestItemView, idx: number) => (
                <DigestItemCard
                  key={item.id}
                  item={item}
                  isLast={idx === digest.items.length - 1}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function headerLabelFor(kind: "catchup" | "daily" | "unknown"): string {
  if (kind === "catchup") return "catch-up brief";
  return "daily brief";
}

function greetingFor(
  count: number,
  kind: "catchup" | "daily" | "unknown",
  daysBack: number | null,
) {
  if (kind === "catchup") {
    const window = daysBack && daysBack >= 2 ? `the past ${daysBack} days` : "the past week";
    if (count === 1) return `Here's the one thing that mattered in ${window}.`;
    return `Here's what mattered in ${window} — ${countWord(count).toLowerCase()} items worth your attention.`;
  }
  if (count === 1) return "One thing mattered overnight.";
  return `${countWord(count)} things mattered overnight.`;
}

function countWord(n: number) {
  const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
  return words[n] ?? String(n);
}

function EmptyDigestBody({
  periodKind,
  daysBack,
}: {
  periodKind: "catchup" | "daily" | "unknown";
  daysBack: number | null;
}) {
  const isCatchup = periodKind === "catchup";
  const eyebrow = isCatchup ? "Nothing notable this past week" : "Nothing notable overnight";
  const window = isCatchup
    ? daysBack && daysBack >= 2
      ? `the past ${daysBack} days`
      : "the past week"
    : null;
  return (
    <div className="py-6 text-center">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.15em] text-[#666]">
        {eyebrow}
      </div>
      <p className="mx-auto max-w-[480px] text-[15px] text-[#a8a8b8]">
        {isCatchup
          ? `Your competitors went quiet across ${window}. We'd rather tell you nothing happened than invent something. We'll keep watching — your next brief lands tomorrow.`
          : "Your competitors went quiet. We'd rather tell you nothing happened than invent something. Back tomorrow."}
      </p>
    </div>
  );
}
