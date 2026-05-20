import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { z } from "zod";
import { FilterChipRow } from "~/components/admin/FilterChipRow";
import { FilterSearchInput } from "~/components/admin/FilterSearchInput";
import { FilterSelect } from "~/components/admin/FilterSelect";
import { listCompetitorsForAdmin } from "~/features/competitors/server/admin-fns";
import type { CompetitorAdminRow } from "~/features/competitors/shared/types";
import {
  type HealthFlagBucket,
  type HealthFlagKind,
  classifyHealthFlags,
} from "~/features/competitors/shared/health-flags";

// /admin/competitors (PF-59). Cohort-wide view of every competitor row so we
// can spot sourceless feeds (no rss_url — ingestion is a no-op for these)
// and popular targets at a glance. Filters live in URL search params; the
// loader returns the full list and the page applies filters client-side,
// same as /admin/feedback (PF-56).

const SOURCE_VALUES = ["all", "has-rss", "sourceless"] as const;
const TRACKED_VALUES = ["any", "1", "2", "3"] as const;
const RECENT_VALUES = ["all", "7d", "30d"] as const;

const filterSchema = z.object({
  source: z.enum(SOURCE_VALUES).catch("all"),
  tracked: z.enum(TRACKED_VALUES).catch("any"),
  recent: z.enum(RECENT_VALUES).catch("all"),
  q: z.string().trim().max(120).optional().catch(undefined),
});

type Filters = z.infer<typeof filterSchema>;

const RECENT_DAYS: Record<Exclude<Filters["recent"], "all">, number> = { "7d": 7, "30d": 30 };

const TRACKED_OPTIONS: { value: Filters["tracked"]; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "1", label: "1+" },
  { value: "2", label: "2+" },
  { value: "3", label: "3+" },
];

const RECENT_OPTIONS: { value: Filters["recent"]; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

const SOURCE_LABELS: Record<Filters["source"], string> = {
  all: "All",
  "has-rss": "Has RSS",
  sourceless: "Sourceless",
};

export const Route = createFileRoute("/admin/competitors/")({
  validateSearch: filterSchema,
  loader: () => listCompetitorsForAdmin(),
  component: AdminCompetitorsPage,
});

function AdminCompetitorsPage() {
  const { rows } = Route.useLoaderData();
  const filters = Route.useSearch();
  const router = useRouter();

  const flags = classifyHealthFlags(rows);
  const filtered = applyFilters(rows, filters);
  const sourceCounts: Record<Filters["source"], number> = {
    all: rows.length,
    "has-rss": rows.filter((r: CompetitorAdminRow) => r.rssUrl !== null).length,
    sourceless: rows.filter((r: CompetitorAdminRow) => r.rssUrl === null).length,
  };

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    router.navigate({
      to: "/admin/competitors",
      search: { ...filters, [key]: value },
      replace: true,
    });
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Competitors</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? "row" : "rows"} · sorted by users tracking
            </p>
          </div>
        </header>

        <StatsPanel rows={rows} />

        <HealthFlagsPanel flags={flags} />

        <div className="mb-6 space-y-3">
          <FilterChipRow
            ariaLabel="Filter by source presence"
            active={filters.source}
            onChange={(v) => updateFilter("source", v)}
            options={(["all", "has-rss", "sourceless"] as const).map((v) => ({
              value: v,
              label: SOURCE_LABELS[v],
              count: sourceCounts[v],
            }))}
          />

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <FilterSelect
              label="Tracked by"
              value={filters.tracked}
              onChange={(v) => updateFilter("tracked", v)}
              options={TRACKED_OPTIONS}
            />
            <FilterSelect
              label="Added"
              value={filters.recent}
              onChange={(v) => updateFilter("recent", v)}
              options={RECENT_OPTIONS}
            />
            <FilterSearchInput
              label="Search"
              placeholder="name or domain"
              value={filters.q}
              onChange={(v) => updateFilter("q", v)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            {rows.length === 0
              ? "No competitors yet. Users add these during the FTE agent run or from /app/profile."
              : "No competitors match these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
            {filtered.map((row) => (
              <CompetitorRowItem key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

const RECENT_ADDITIONS_DAYS = 7;
const RECENT_ADDITIONS_PREVIEW = 8;
const TOP_TRACKED_LIMIT = 10;

function StatsPanel({ rows }: { rows: CompetitorAdminRow[] }) {
  if (rows.length === 0) return null;
  const total = rows.length;
  const rss = rows.filter((r) => r.rssUrl !== null).length;
  const sourceless = rows.filter((r) => r.rssUrl === null).length;

  const cutoffMs = Date.now() - RECENT_ADDITIONS_DAYS * 24 * 60 * 60 * 1000;
  const recent = rows
    .filter((r) => new Date(r.createdAt).getTime() >= cutoffMs)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const topTracked = rows.filter((r) => r.trackedBy > 0).slice(0, TOP_TRACKED_LIMIT);

  return (
    <section className="mb-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-text">
          Cohort signal
        </h2>
        <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">
          {total} {total === 1 ? "competitor" : "competitors"}
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SourceCoverageCard total={total} rss={rss} sourceless={sourceless} />
        <RecentAdditionsCard rows={recent} />
        <MostTrackedCard rows={topTracked} />
      </div>
    </section>
  );
}

function StatsCard({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    <article className="flex min-h-0 flex-col rounded-xl border border-ink-line bg-paper p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        {meta ? (
          <span className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{meta}</span>
        ) : null}
      </div>
      {children}
    </article>
  );
}

function SourceCoverageCard({
  total,
  rss,
  sourceless,
}: {
  total: number;
  rss: number;
  sourceless: number;
}) {
  return (
    <StatsCard title="Source coverage">
      <ul className="space-y-2 text-xs">
        <CoverageRow label="RSS" value={rss} total={total} />
        <CoverageRow label="Sourceless" value={sourceless} total={total} muted={sourceless === 0} />
      </ul>
    </StatsCard>
  );
}

function CoverageRow({
  label,
  value,
  total,
  muted,
}: {
  label: string;
  value: number;
  total: number;
  muted?: boolean;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className={muted ? "text-text-muted" : "text-text"}>{label}</span>
      <span className="font-mono text-sm tabular-nums text-text">
        {value} <span className="text-text-muted">/ {total}</span>
      </span>
    </li>
  );
}

function RecentAdditionsCard({ rows }: { rows: CompetitorAdminRow[] }) {
  const shown = rows.slice(0, RECENT_ADDITIONS_PREVIEW);
  const overflow = rows.length - shown.length;
  return (
    <StatsCard title={`Recently added (${RECENT_ADDITIONS_DAYS}d)`} meta={String(rows.length)}>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">No competitors added in the last week.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {shown.map((row) => (
              <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
                <Link
                  to="/admin/competitors/$competitorId"
                  params={{ competitorId: row.id }}
                  search={{ tab: "activity" }}
                  className="truncate font-medium text-text hover:underline"
                >
                  {row.name}
                </Link>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.05em] text-text-muted">
                  {relativeLabel(new Date(row.createdAt))}
                </span>
              </li>
            ))}
          </ul>
          {overflow > 0 ? (
            <p className="mt-3 text-[10px] uppercase tracking-[0.1em] text-text-muted">
              +{overflow} more
            </p>
          ) : null}
        </>
      )}
    </StatsCard>
  );
}

function MostTrackedCard({ rows }: { rows: CompetitorAdminRow[] }) {
  return (
    <StatsCard title="Most tracked" meta={`top ${TOP_TRACKED_LIMIT}`}>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">No competitor is tracked by any user yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
              <Link
                to="/admin/competitors/$competitorId"
                params={{ competitorId: row.id }}
                search={{ tab: "activity" }}
                className="truncate font-medium text-text hover:underline"
              >
                {row.name}
              </Link>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
                {row.trackedBy} {row.trackedBy === 1 ? "user" : "users"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </StatsCard>
  );
}

const HEALTH_FLAG_META: Record<
  HealthFlagKind,
  { label: string; hint: string; emptyContext: (row: CompetitorAdminRow) => string }
> = {
  orphans: {
    label: "Orphans",
    hint: "No users tracking. Usually FTE-added rows a user later removed.",
    emptyContext: (row) => `added ${formatDate(row.createdAt)}`,
  },
  sourceless: {
    label: "Sourceless",
    hint: "No RSS feed. Ingestion produces nothing for these.",
    emptyContext: (row) => `tracked by ${row.trackedBy}`,
  },
  stale: {
    label: "Stale",
    hint: "Has a source but no ingest in 30d. Feed is probably broken upstream.",
    emptyContext: (row) =>
      row.lastIngestedAt
        ? `last ingest ${relativeLabel(new Date(row.lastIngestedAt))}`
        : "never ingested",
  },
};

const HEALTH_FLAG_ORDER: HealthFlagKind[] = ["stale", "sourceless", "orphans"];

const HEALTH_FLAG_PREVIEW = 8;

function HealthFlagsPanel({ flags }: { flags: Record<HealthFlagKind, HealthFlagBucket> }) {
  const buckets = HEALTH_FLAG_ORDER.map((k) => flags[k]).filter((b) => b.rows.length > 0);
  if (buckets.length === 0) return null;
  return (
    <section className="mb-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-text">Health flags</h2>
        <p className="text-[10px] uppercase tracking-[0.1em] text-text-muted">triage candidates</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {buckets.map((bucket) => (
          <HealthFlagCard key={bucket.kind} bucket={bucket} />
        ))}
      </div>
    </section>
  );
}

function HealthFlagCard({ bucket }: { bucket: HealthFlagBucket }) {
  const meta = HEALTH_FLAG_META[bucket.kind];
  const shown = bucket.rows.slice(0, HEALTH_FLAG_PREVIEW);
  const overflow = bucket.rows.length - shown.length;
  return (
    <article className="flex min-h-0 flex-col rounded-xl border border-ink-line bg-paper p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">{meta.label}</h3>
        <span className="font-mono text-sm tabular-nums text-text">{bucket.rows.length}</span>
      </div>
      <p className="mb-3 text-xs text-text-muted">{meta.hint}</p>
      <ul className="space-y-1.5">
        {shown.map((row) => (
          <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
            <a
              href={row.homepageUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate font-medium text-text hover:underline"
            >
              {row.name}
            </a>
            <span className="shrink-0 text-[10px] uppercase tracking-[0.05em] text-text-muted">
              {meta.emptyContext(row)}
            </span>
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        <p className="mt-3 text-[10px] uppercase tracking-[0.1em] text-text-muted">
          +{overflow} more
        </p>
      ) : null}
    </article>
  );
}

function CompetitorRowItem({ row }: { row: CompetitorAdminRow }) {
  const domain = parseDomain(row.homepageUrl);
  const lastIngest = row.lastIngestedAt ? relativeLabel(new Date(row.lastIngestedAt)) : null;
  const added = formatDate(row.createdAt);
  return (
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to="/admin/competitors/$competitorId"
            params={{ competitorId: row.id }}
            search={{ tab: "activity" }}
            className="truncate font-medium text-text hover:underline"
          >
            {row.name}
          </Link>
          <a
            href={row.homepageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate font-mono text-xs text-text-muted hover:text-text"
          >
            {domain}
          </a>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <PresenceChip label="RSS" present={row.rssUrl !== null} />
          <span className="ml-2 text-[10px] uppercase tracking-[0.1em] text-text-muted">
            added {added}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-right">
        <Stat label="tracking" value={String(row.trackedBy)} />
        <Stat label="7d items" value={String(row.rawItems7d)} />
        <Stat label="last ingest" value={lastIngest ?? "—"} />
      </div>
    </li>
  );
}

function PresenceChip({ label, present }: { label: string; present: boolean }) {
  const tone = present
    ? "border-ink-line bg-paper text-text"
    : "border-ink-line/60 bg-paper-warm text-text-muted/60 line-through";
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${tone}`}
    >
      {label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-sm tabular-nums text-text">{value}</div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-text-muted">{label}</div>
    </div>
  );
}

function applyFilters(rows: CompetitorAdminRow[], filters: Filters): CompetitorAdminRow[] {
  const cutoffMs =
    filters.recent === "all"
      ? null
      : Date.now() - RECENT_DAYS[filters.recent] * 24 * 60 * 60 * 1000;
  const minTracked = filters.tracked === "any" ? 0 : Number(filters.tracked);
  const needle = filters.q?.toLowerCase() ?? "";

  return rows.filter((r) => {
    if (filters.source === "has-rss" && r.rssUrl === null) return false;
    if (filters.source === "sourceless" && r.rssUrl !== null) return false;
    if (r.trackedBy < minTracked) return false;
    if (cutoffMs !== null && new Date(r.createdAt).getTime() < cutoffMs) return false;
    if (needle) {
      const hay = `${r.name.toLowerCase()} ${parseDomain(r.homepageUrl).toLowerCase()}`;
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function parseDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function relativeLabel(occurred: Date): string {
  const diffMs = Date.now() - occurred.getTime();
  if (diffMs < 0) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return minutes < 1 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1d ago" : `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "1mo ago" : `${months}mo ago`;
}
