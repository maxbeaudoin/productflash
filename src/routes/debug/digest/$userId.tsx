import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { DigestItemCard, type DigestItemView } from "~/components/app/DigestItemCard";
import { digestItems, digests, feedback, rawItems, users } from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import { runScoringForUser } from "~/jobs/score";
import { runSynthesisForUser } from "~/jobs/synthesize";
import { requireAdminSession } from "~/lib/auth-server";
import { getDb } from "~/lib/db";
import { deriveDigestPeriod } from "~/lib/digest-period";
import { signFeedbackToken } from "~/lib/feedback-token";

// Admin-only digest preview (#25). Renders the most recent digest for any
// user_id via the same components as /app/digests/:id, so prompt-tuning
// iterations don't need to log in as the target user. `?refresh=1` re-runs
// score → synthesize against the last 24h of raw_items first — useful for
// replaying a batch after editing a prompt without waiting for the 05:00
// UTC cron. Was previously NODE_ENV-gated; an admin-session gate is more
// robust against a misconfigured deploy slot.

type DebugDigestView = {
  userId: string;
  userEmail: string;
  digestId: string;
  createdAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  itemCount: number;
  refreshed: boolean;
  items: DigestItemView[];
};

const inputSchema = z.object({
  userId: z.string().uuid(),
  refresh: z.boolean().default(false),
});

const loadDebugDigest = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => inputSchema.parse(data))
  .handler(async ({ data }): Promise<DebugDigestView> => {
    await requireAdminSession();

    const db = getDb();

    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, data.userId))
      .limit(1);
    if (!user) throw notFound();

    if (data.refresh) {
      await runScoringForUser(user.id);
      await runSynthesisForUser(user.id);
    }

    const [digest] = await db
      .select()
      .from(digests)
      .where(eq(digests.userId, user.id))
      .orderBy(desc(digests.createdAt))
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
          .select({ digestItemId: feedback.digestItemId, rating: feedback.rating })
          .from(feedback)
          .where(eq(feedback.userId, user.id))
      : [];
    const feedbackByItem = new Map(feedbackRows.map((f) => [f.digestItemId, f.rating] as const));

    return {
      userId: user.id,
      userEmail: user.email,
      digestId: digest.id,
      createdAt: digest.createdAt.toISOString(),
      periodStart: digest.periodStart ? digest.periodStart.toISOString() : null,
      periodEnd: digest.periodEnd ? digest.periodEnd.toISOString() : null,
      itemCount: digest.itemCount,
      refreshed: data.refresh,
      items: rows.map<DigestItemView>((r) => ({
        id: r.id,
        category: r.category as DigestTag,
        headline: r.headline,
        snippet: r.snippet,
        impactNote: r.impactNote,
        sourceUrl: r.sourceUrl,
        occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
        feedback: feedbackByItem.get(r.id) ?? null,
        feedbackUrls: {
          up: `/r/${r.id}/up?t=${signFeedbackToken(r.id, "up")}`,
          down: `/r/${r.id}/down?t=${signFeedbackToken(r.id, "down")}`,
        },
      })),
    };
  });

const searchSchema = z.object({
  refresh: z
    .union([z.literal("1"), z.literal("0"), z.literal("true"), z.literal("false")])
    .optional(),
});

const ensureAdmin = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdminSession();
});

export const Route = createFileRoute("/debug/digest/$userId")({
  beforeLoad: async () => {
    await ensureAdmin();
  },
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    refresh: search.refresh === "1" || search.refresh === "true",
  }),
  loader: ({ params, deps }) =>
    loadDebugDigest({ data: { userId: params.userId, refresh: deps.refresh } }),
  component: DebugDigestPage,
});

function DebugDigestPage() {
  const data = Route.useLoaderData();
  const period = deriveDigestPeriod({
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
  });
  const created = new Date(data.createdAt);
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
  const headerLabel = period.kind === "catchup" ? "catch-up brief" : "daily brief";
  const headerMetaLabel =
    period.rangeLabel?.toUpperCase() ?? `${fallbackDateLabel} · ${fallbackTimeLabel}`;

  return (
    <main className="min-h-screen bg-ink px-6 py-12 text-white antialiased">
      <div className="mx-auto max-w-[1100px]">
        <DebugBanner data={data} />

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
            {data.items.length === 0 ? (
              <EmptyDigestBody periodKind={period.kind} daysBack={period.daysBack} />
            ) : (
              <>
                <div className="mb-6 text-sm text-[#888]">
                  {greetingFor(data.items.length, period.kind, period.daysBack)}
                </div>
                {data.items.map((item, idx) => (
                  <DigestItemCard
                    key={item.id}
                    item={item}
                    isLast={idx === data.items.length - 1}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function DebugBanner({ data }: { data: DebugDigestView }) {
  const refreshHref = `/debug/digest/${data.userId}?refresh=1`;
  const plainHref = `/debug/digest/${data.userId}`;
  return (
    <div className="mb-8 rounded-card border border-coral/40 bg-coral/10 px-5 py-4 font-mono text-xs text-[#ffd9cf]">
      <div className="mb-1 font-semibold uppercase tracking-[0.15em] text-coral">
        Debug preview · auth bypassed
      </div>
      <div>
        user <span className="text-white">{data.userEmail}</span>{" "}
        <span className="text-[#a8a8b8]">({data.userId})</span> · digest{" "}
        <span className="text-white">{data.digestId}</span> · {data.itemCount} item
        {data.itemCount === 1 ? "" : "s"}
        {data.refreshed ? (
          <span className="text-accent"> · just re-ran score → synthesize</span>
        ) : null}
      </div>
      <div className="mt-2 flex gap-3 text-[11px]">
        <a
          href={refreshHref}
          className="rounded-pill border border-coral/40 px-3 py-1 text-coral hover:bg-coral/20"
        >
          ?refresh=1
        </a>
        <a
          href={plainHref}
          className="rounded-pill border border-[#2a2a38] px-3 py-1 text-[#a8a8b8] hover:text-white"
        >
          plain
        </a>
      </div>
    </div>
  );
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
