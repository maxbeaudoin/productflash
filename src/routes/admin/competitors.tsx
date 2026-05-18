import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import {
  type CompetitorAdminRow,
  listCompetitorsForAdmin,
} from "~/features/competitors/server/admin-fns";

// /admin/competitors (PF-59). Cohort-wide view of every competitor row so we
// can spot sourceless feeds (no rss_url AND no ph_slug — ingestion is a no-op
// for these) and popular targets at a glance. Filters live in URL search
// params; the loader returns the full list and the page applies filters
// client-side, same as /admin/feedback (PF-56).

const SOURCE_VALUES = ["all", "has-rss", "has-ph", "sourceless"] as const;
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

const SOURCE_FILTERS: { value: Filters["source"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "has-rss", label: "Has RSS" },
  { value: "has-ph", label: "Has PH" },
  { value: "sourceless", label: "Sourceless" },
];

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

export const Route = createFileRoute("/admin/competitors")({
  validateSearch: filterSchema,
  loader: () => listCompetitorsForAdmin(),
  component: AdminCompetitorsPage,
});

function AdminCompetitorsPage() {
  const { rows } = Route.useLoaderData();
  const filters = Route.useSearch();
  const router = useRouter();

  const filtered = applyFilters(rows, filters);
  const sourceCounts = {
    all: rows.length,
    "has-rss": rows.filter((r: CompetitorAdminRow) => r.rssUrl !== null).length,
    "has-ph": rows.filter((r: CompetitorAdminRow) => r.phSlug !== null).length,
    sourceless: rows.filter((r: CompetitorAdminRow) => r.rssUrl === null && r.phSlug === null)
      .length,
  } satisfies Record<Filters["source"], number>;

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

        <div className="mb-6 space-y-3">
          <nav className="flex flex-wrap gap-2" aria-label="Filter by source presence">
            {SOURCE_FILTERS.map((f) => {
              const active = filters.source === f.value;
              return (
                <Link
                  key={f.value}
                  to="/admin/competitors"
                  search={{ ...filters, source: f.value }}
                  replace
                  className={`inline-flex items-center gap-2 rounded-pill border px-3 py-1 text-xs uppercase tracking-[0.1em] transition-colors ${
                    active
                      ? "border-ink bg-ink text-paper"
                      : "border-ink-line bg-paper-warm text-text-muted hover:border-ink hover:text-text"
                  }`}
                >
                  {f.label}
                  <span
                    className={`font-mono text-[10px] ${active ? "text-paper/70" : "text-text-muted"}`}
                  >
                    {sourceCounts[f.value]}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <FilterSelect
              label="Tracked by"
              value={filters.tracked}
              onChange={(v) => updateFilter("tracked", v as Filters["tracked"])}
              options={TRACKED_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <FilterSelect
              label="Added"
              value={filters.recent}
              onChange={(v) => updateFilter("recent", v as Filters["recent"])}
              options={RECENT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            />
            <label className="inline-flex items-center gap-2 text-text-muted">
              <span className="uppercase tracking-[0.1em] text-[10px]">Search</span>
              <input
                type="search"
                value={filters.q ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateFilter("q", v.length ? v : undefined);
                }}
                placeholder="name or domain"
                className="rounded-pill border border-ink-line bg-paper px-3 py-1 text-xs text-text placeholder:text-text-muted hover:border-ink focus:border-ink focus:outline-none"
              />
            </label>
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

function CompetitorRowItem({ row }: { row: CompetitorAdminRow }) {
  const domain = parseDomain(row.homepageUrl);
  const lastIngest = row.lastIngestedAt ? relativeLabel(new Date(row.lastIngestedAt)) : null;
  const added = formatDate(row.createdAt);
  return (
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <a
            href={row.homepageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate font-medium text-text hover:underline"
          >
            {row.name}
          </a>
          <span className="truncate font-mono text-xs text-text-muted">{domain}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <PresenceChip label="RSS" present={row.rssUrl !== null} />
          <PresenceChip label="PH" present={row.phSlug !== null} />
          <PresenceChip label="Pricing" present={row.pricingUrl !== null} />
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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="inline-flex items-center gap-2 text-text-muted">
      <span className="uppercase tracking-[0.1em] text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-pill border border-ink-line bg-paper px-3 py-1 text-xs text-text hover:border-ink focus:border-ink focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
    if (filters.source === "has-ph" && r.phSlug === null) return false;
    if (filters.source === "sourceless" && (r.rssUrl !== null || r.phSlug !== null)) return false;
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
