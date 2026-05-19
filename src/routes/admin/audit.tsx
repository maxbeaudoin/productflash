import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { FilterChipRow } from "~/components/admin/FilterChipRow";
import { FilterSearchInput } from "~/components/admin/FilterSearchInput";
import { listAdminAudit } from "~/features/admin-audit/server/fns";
import type { AdminAuditRow } from "~/features/admin-audit/shared/types";
import { AdminAuditList } from "~/features/admin-audit/ui/AdminAuditList";

// /admin/audit (PF-60). Global, read-only feed of every admin write — the
// forensic backstop for once admin can edit competitor rows (PF-66) and run
// ops on them (PF-67/68). PoC volume is low; we hydrate the last 500 rows
// and filter client-side, matching the convention shared with /admin/users
// and /admin/feedback.

const TARGET_KIND_VALUES = ["all", "user", "waitlist", "competitor"] as const;

const filterSchema = z.object({
  kind: z.enum(TARGET_KIND_VALUES).catch("all"),
  q: z.string().trim().max(120).optional().catch(undefined),
});

type Filters = z.infer<typeof filterSchema>;

const KIND_LABELS: Record<Filters["kind"], string> = {
  all: "All",
  user: "Users",
  waitlist: "Waitlist",
  competitor: "Competitors",
};

export const Route = createFileRoute("/admin/audit")({
  validateSearch: filterSchema,
  loader: () => listAdminAudit(),
  component: AdminAuditPage,
});

function AdminAuditPage() {
  const { rows } = Route.useLoaderData();
  const filters = Route.useSearch();
  const router = useRouter();

  const filtered = applyFilters(rows, filters);
  const counts: Record<Filters["kind"], number> = {
    all: applyFilters(rows, { ...filters, kind: "all" }).length,
    user: applyFilters(rows, { ...filters, kind: "user" }).length,
    waitlist: applyFilters(rows, { ...filters, kind: "waitlist" }).length,
    competitor: applyFilters(rows, { ...filters, kind: "competitor" }).length,
  };

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    router.navigate({ to: "/admin/audit", search: { ...filters, [key]: value }, replace: true });
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? "action" : "actions"} recorded · newest first
            </p>
          </div>
        </header>

        <div className="mb-6 space-y-3">
          <FilterChipRow
            ariaLabel="Filter by target kind"
            active={filters.kind}
            onChange={(v) => updateFilter("kind", v)}
            options={TARGET_KIND_VALUES.map((v) => ({
              value: v,
              label: KIND_LABELS[v],
              count: counts[v],
            }))}
          />

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <FilterSearchInput
              label="Search"
              placeholder="action or admin email"
              value={filters.q}
              onChange={(v) => updateFilter("q", v)}
            />
          </div>
        </div>

        <AdminAuditList
          rows={filtered}
          emptyMessage={
            rows.length === 0
              ? "No admin actions recorded yet. Issue an invite or re-run an FTE to seed the feed."
              : "No actions match these filters."
          }
        />
      </div>
    </main>
  );
}

function applyFilters(rows: AdminAuditRow[], filters: Filters): AdminAuditRow[] {
  const needle = filters.q?.toLowerCase() ?? "";
  return rows.filter((r: AdminAuditRow) => {
    if (filters.kind !== "all" && r.targetKind !== filters.kind) return false;
    if (needle) {
      const hay = `${r.action} ${r.actorEmail ?? ""} ${r.targetLabel ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}
