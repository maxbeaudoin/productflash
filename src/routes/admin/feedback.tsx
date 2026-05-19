import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq, sql } from "drizzle-orm";
import type { ReactNode } from "react";
import { useState } from "react";
import { z } from "zod";
import { FilterChipRow } from "~/components/admin/FilterChipRow";
import { FilterSearchInput } from "~/components/admin/FilterSearchInput";
import { FilterSelect } from "~/components/admin/FilterSelect";
import { digestItems, digests, feedback, rawItems, users } from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import { requireAdminSession } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";

// /admin/feedback (#PF-56). Cross-user feed of recently rated digest_items so
// we can spot curation regressions while the cohort is small. The workhorse
// query is "👎 in the last 7 days" — anything that pattern surfaces is a
// synthesis-prompt or scoring problem to chase. Sorted newest-first; the
// PoC volume is low enough that we load up to 500 rows and filter
// client-side, matching the /admin/waitlist convention.

type FeedbackRating = "up" | "down";

type SourceType = "rss" | "ph" | "firehose" | "firecrawl";

type FeedbackRow = {
  id: string;
  rating: FeedbackRating;
  ratedAt: string;
  digestItemId: string;
  digestId: string;
  category: DigestTag;
  headline: string;
  snippet: string;
  occurredAt: string | null;
  source: SourceType;
  sourceUrl: string;
  userId: string;
  userEmail: string;
  comment: string | null;
  commentedAt: string | null;
};

type RollupRow<K extends string> = {
  key: K;
  up: number;
  total: number;
};

type LoaderData = {
  rows: FeedbackRow[];
  rollups: {
    bySource: RollupRow<SourceType>[];
    byCategory: RollupRow<DigestTag>[];
  };
};

// PoC scale — one or two ratings on a source/tag tells us nothing. Hide
// rollup rows below this threshold so the card doesn't read like signal.
const ROLLUP_MIN_N = 5;

const RANGE_DAYS: Record<"7d" | "30d", number> = { "7d": 7, "30d": 30 };

const ROW_LIMIT = 500;

const CATEGORY_VALUES = [
  "launch",
  "pricing",
  "feature",
  "positioning",
  "funding",
  "acquisition",
  "noise",
] as const;

const SOURCE_VALUES = ["rss", "ph", "firehose", "firecrawl"] as const;

const filterSchema = z.object({
  rating: z.enum(["all", "up", "down"]).catch("all"),
  range: z.enum(["all", "7d", "30d"]).catch("all"),
  source: z.enum(["all", ...SOURCE_VALUES]).catch("all"),
  category: z.enum(["all", ...CATEGORY_VALUES]).catch("all"),
  q: z.string().trim().max(120).optional().catch(undefined),
});

type Filters = z.infer<typeof filterSchema>;

const listFeedback = createServerFn({ method: "GET" }).handler(async (): Promise<LoaderData> => {
  await requireAdminSession();
  const db = getDb();

  const rows = await db
    .select({
      id: feedback.id,
      rating: feedback.rating,
      ratedAt: feedback.createdAt,
      digestItemId: digestItems.id,
      digestId: digests.id,
      category: digestItems.category,
      headline: digestItems.headline,
      snippet: digestItems.snippet,
      occurredAt: digestItems.occurredAt,
      source: rawItems.source,
      sourceUrl: rawItems.url,
      userId: users.id,
      userEmail: users.email,
      comment: feedback.comment,
      commentedAt: feedback.commentedAt,
    })
    .from(feedback)
    .innerJoin(digestItems, eq(digestItems.id, feedback.digestItemId))
    .innerJoin(digests, eq(digests.id, digestItems.digestId))
    .innerJoin(rawItems, eq(rawItems.id, digestItems.rawItemId))
    .innerJoin(users, eq(users.id, feedback.userId))
    .orderBy(desc(feedback.createdAt))
    .limit(ROW_LIMIT);

  // PF-61. Cross-cohort rollups: "which input produces signal vs noise?" —
  // grouped over the same join topology as the feed so rates line up with
  // what you see when you filter the list. Aggregated in SQL (not from
  // `rows`) so the 500-row cap on the feed doesn't quietly truncate counts.
  const sourceAgg = await db
    .select({
      source: rawItems.source,
      up: sql<number>`COUNT(*) FILTER (WHERE ${feedback.rating} = 'up')::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(feedback)
    .innerJoin(digestItems, eq(digestItems.id, feedback.digestItemId))
    .innerJoin(rawItems, eq(rawItems.id, digestItems.rawItemId))
    .groupBy(rawItems.source);

  const categoryAgg = await db
    .select({
      category: digestItems.category,
      up: sql<number>`COUNT(*) FILTER (WHERE ${feedback.rating} = 'up')::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(feedback)
    .innerJoin(digestItems, eq(digestItems.id, feedback.digestItemId))
    .groupBy(digestItems.category);

  const bySource = sourceAgg
    .filter((r) => r.total >= ROLLUP_MIN_N)
    .map<RollupRow<SourceType>>((r) => ({
      key: r.source as SourceType,
      up: r.up,
      total: r.total,
    }))
    .sort((a, b) => b.total - a.total);

  const byCategory = categoryAgg
    .filter((r) => r.total >= ROLLUP_MIN_N)
    .map<RollupRow<DigestTag>>((r) => ({
      key: r.category as DigestTag,
      up: r.up,
      total: r.total,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    rows: rows.map<FeedbackRow>((r) => ({
      id: r.id,
      rating: r.rating,
      ratedAt: r.ratedAt.toISOString(),
      digestItemId: r.digestItemId,
      digestId: r.digestId,
      category: r.category as DigestTag,
      headline: r.headline,
      snippet: r.snippet,
      occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
      source: r.source as SourceType,
      sourceUrl: r.sourceUrl,
      userId: r.userId,
      userEmail: r.userEmail,
      comment: r.comment,
      commentedAt: r.commentedAt ? r.commentedAt.toISOString() : null,
    })),
    rollups: { bySource, byCategory },
  };
});

export const Route = createFileRoute("/admin/feedback")({
  validateSearch: filterSchema,
  loader: () => listFeedback(),
  component: AdminFeedbackPage,
});

const RATING_FILTERS: { value: Filters["rating"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "up", label: "👍 Liked" },
  { value: "down", label: "👎 Disliked" },
];

const RANGE_FILTERS: { value: Filters["range"]; label: string }[] = [
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
  { value: "all", label: "All time" },
];

const SOURCE_LABEL: Record<SourceType, string> = {
  rss: "RSS",
  ph: "PH",
  firehose: "Firehose",
  firecrawl: "Firecrawl",
};

const CATEGORY_LABEL: Record<DigestTag, string> = {
  launch: "Launch",
  pricing: "Pricing",
  feature: "Feature",
  positioning: "Positioning",
  funding: "Funding",
  acquisition: "Acquisition",
  noise: "Noise",
};

const CATEGORY_TONE: Record<DigestTag, string> = {
  launch: "bg-accent/15 text-accent",
  pricing: "bg-coral/15 text-coral",
  feature: "bg-[#78b4ff]/15 text-[#78b4ff]",
  positioning: "bg-accent-warm/15 text-accent-warm",
  funding: "bg-[#4ade80]/15 text-[#4ade80]",
  acquisition: "bg-[#a78bfa]/15 text-[#a78bfa]",
  noise: "bg-text-muted/15 text-text-muted",
};

function AdminFeedbackPage() {
  const { rows, rollups } = Route.useLoaderData();
  const filters = Route.useSearch();
  const router = useRouter();

  const filtered = applyFilters(rows, filters);
  const counts = {
    all: applyFilters(rows, { ...filters, rating: "all" }).length,
    up: applyFilters(rows, { ...filters, rating: "up" }).length,
    down: applyFilters(rows, { ...filters, rating: "down" }).length,
  };

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    router.navigate({
      to: "/admin/feedback",
      search: { ...filters, [key]: value },
      replace: true,
    });
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Feedback</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? "rating" : "ratings"} captured · newest first
            </p>
          </div>
        </header>

        <RollupCards bySource={rollups.bySource} byCategory={rollups.byCategory} />

        <div className="mb-6 space-y-3">
          <FilterChipRow
            ariaLabel="Filter by rating"
            active={filters.rating}
            onChange={(v) => updateFilter("rating", v)}
            options={RATING_FILTERS.map((f) => ({
              value: f.value,
              label: f.label,
              count: counts[f.value],
            }))}
          />

          <FilterChipRow
            ariaLabel="Filter by date range"
            active={filters.range}
            onChange={(v) => updateFilter("range", v)}
            options={RANGE_FILTERS}
          />

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <FilterSelect
              label="Source"
              value={filters.source}
              onChange={(v) => updateFilter("source", v)}
              options={[
                { value: "all" as const, label: "All sources" },
                ...SOURCE_VALUES.map((s) => ({ value: s, label: SOURCE_LABEL[s] })),
              ]}
            />
            <FilterSelect
              label="Category"
              value={filters.category}
              onChange={(v) => updateFilter("category", v)}
              options={[
                { value: "all" as const, label: "All categories" },
                ...CATEGORY_VALUES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] })),
              ]}
            />
            <FilterSearchInput
              label="User"
              placeholder="email"
              value={filters.q}
              onChange={(v) => updateFilter("q", v)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            {rows.length === 0
              ? "No feedback yet. Rate items in /app/digests/* (dogfood!) to seed this view."
              : "No ratings match these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
            {filtered.map((row) => (
              <FeedbackRowItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function FeedbackRowItem({ row }: { row: FeedbackRow }) {
  const ratedAgo = relativeLabel(new Date(row.ratedAt), new Date());
  const ratedDate = new Date(row.ratedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const [expanded, setExpanded] = useState(false);
  const hasComment = Boolean(row.comment);

  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <RatingChip rating={row.rating} />
            <Link
              to="/admin/users/$userId"
              params={{ userId: row.userId }}
              className="font-mono text-text hover:underline"
            >
              {row.userEmail}
            </Link>
            <span aria-hidden>·</span>
            <span>
              {ratedDate}
              {ratedAgo ? ` · ${ratedAgo}` : ""}
            </span>
          </div>
          <div className="mt-1 truncate text-sm font-medium text-text">{row.headline}</div>
          <div className="mt-1 line-clamp-2 text-xs text-text-muted">{row.snippet}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.1em]">
        <span
          className={`inline-flex items-center rounded-[4px] px-2 py-0.5 font-semibold ${CATEGORY_TONE[row.category]}`}
        >
          {CATEGORY_LABEL[row.category]}
        </span>
        <span className="inline-flex items-center rounded-pill border border-ink-line bg-paper px-2 py-0.5 text-text-muted">
          {SOURCE_LABEL[row.source]}
        </span>
        {hasComment ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 rounded-pill border border-coral/40 bg-coral/10 px-2 py-0.5 text-coral hover:bg-coral/20"
          >
            💬 {expanded ? "Hide" : "Comment"}
          </button>
        ) : null}
      </div>
      {hasComment && expanded ? (
        <blockquote className="mt-1 whitespace-pre-wrap rounded-md border border-ink-line bg-paper px-3 py-2 text-sm text-text">
          {row.comment}
        </blockquote>
      ) : null}
    </li>
  );
}

function RatingChip({ rating }: { rating: FeedbackRating }) {
  const tone = rating === "up" ? "bg-accent/30 text-text" : "bg-coral/20 text-text";
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${tone}`}
    >
      {rating === "up" ? "👍" : "👎"} {rating === "up" ? "liked" : "disliked"}
    </span>
  );
}

function applyFilters(rows: FeedbackRow[], filters: Filters): FeedbackRow[] {
  const cutoffMs =
    filters.range === "all" ? null : Date.now() - RANGE_DAYS[filters.range] * 24 * 60 * 60 * 1000;
  const needle = filters.q?.toLowerCase() ?? "";
  return rows.filter((r: FeedbackRow) => {
    if (filters.rating !== "all" && r.rating !== filters.rating) return false;
    if (cutoffMs !== null && new Date(r.ratedAt).getTime() < cutoffMs) return false;
    if (filters.source !== "all" && r.source !== filters.source) return false;
    if (filters.category !== "all" && r.category !== filters.category) return false;
    if (needle && !r.userEmail.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function RollupCards({
  bySource,
  byCategory,
}: {
  bySource: RollupRow<SourceType>[];
  byCategory: RollupRow<DigestTag>[];
}) {
  return (
    <section className="mb-6 grid gap-4 md:grid-cols-2">
      <RollupCard title="By source" rows={bySource} renderKey={(k) => SOURCE_LABEL[k]} />
      <RollupCard
        title="By category"
        rows={byCategory}
        renderKey={(k) => (
          <span
            className={`inline-flex items-center rounded-[4px] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${CATEGORY_TONE[k]}`}
          >
            {CATEGORY_LABEL[k]}
          </span>
        )}
      />
    </section>
  );
}

function RollupCard<K extends string>({
  title,
  rows,
  renderKey,
}: {
  title: string;
  rows: RollupRow<K>[];
  renderKey: (key: K) => ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-ink-line bg-paper-warm p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-text-muted">
          {title}
        </h2>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-muted"
          title={`Rows with fewer than ${ROLLUP_MIN_N} ratings are hidden — not enough signal at PoC scale.`}
        >
          n ≥ {ROLLUP_MIN_N}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">
          Not enough ratings yet. Need ≥ {ROLLUP_MIN_N} per group.
        </p>
      ) : (
        <ul className="divide-y divide-ink-line overflow-hidden rounded-md border border-ink-line bg-paper">
          {rows.map((r) => (
            <RollupCardRow key={r.key} row={r} renderKey={renderKey} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RollupCardRow<K extends string>({
  row,
  renderKey,
}: {
  row: RollupRow<K>;
  renderKey: (key: K) => ReactNode;
}) {
  const ratio = row.total > 0 ? row.up / row.total : 0;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">{renderKey(row.key)}</div>
      <div className="flex items-center gap-3 font-mono tabular-nums text-text-muted">
        <span title="ratings in group">n {row.total}</span>
        <span className="text-text">{Math.round(ratio * 100)}% 👍</span>
      </div>
    </li>
  );
}

function relativeLabel(occurred: Date, now: Date): string | null {
  const diffMs = now.getTime() - occurred.getTime();
  if (diffMs < 0) return null;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    if (minutes < 1) return "just now";
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
}
