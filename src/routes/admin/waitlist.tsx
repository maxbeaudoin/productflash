import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { FilterChipRow } from "~/components/admin/FilterChipRow";
import { FilterSearchInput } from "~/components/admin/FilterSearchInput";
import { issueInvite, listWaitlist } from "~/features/waitlist/server/admin-fns";
import type { WaitlistRow } from "~/features/waitlist/shared/types";
import { WaitlistRowItem } from "~/features/waitlist/ui/admin/waitlist-row-item";

// Minimal admin surface for issuing invites off the public waitlist (#34).
// Lives at /admin/waitlist behind requireAdminSession. Shares no nav with
// the future /admin/users (#16) yet — those converge once #16 lands.

const STATE_VALUES = ["all", "waitlist", "invited", "accepted"] as const;

const filterSchema = z.object({
  state: z.enum(STATE_VALUES).catch("all"),
  q: z.string().trim().max(120).optional().catch(undefined),
});

type Filters = z.infer<typeof filterSchema>;

export const Route = createFileRoute("/admin/waitlist")({
  validateSearch: filterSchema,
  loader: async () => listWaitlist(),
  component: AdminWaitlistPage,
});

const STATE_LABELS: Record<Filters["state"], string> = {
  all: "All",
  waitlist: "Waitlist",
  invited: "Invited",
  accepted: "Accepted",
};

function AdminWaitlistPage() {
  const { rows } = Route.useLoaderData();
  const filters = Route.useSearch();
  const router = useRouter();

  const filtered = applyFilters(rows, filters);
  // State chip counts respect the email search so operators can see "2
  // invited rows match 'acme'" rather than the unfiltered total.
  const stateCounts: Record<Filters["state"], number> = {
    all: applyFilters(rows, { ...filters, state: "all" }).length,
    waitlist: applyFilters(rows, { ...filters, state: "waitlist" }).length,
    invited: applyFilters(rows, { ...filters, state: "invited" }).length,
    accepted: applyFilters(rows, { ...filters, state: "accepted" }).length,
  };

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    router.navigate({
      to: "/admin/waitlist",
      search: { ...filters, [key]: value },
      replace: true,
    });
  }

  async function onIssueInvite(id: string) {
    const result = await issueInvite({ data: { id } });
    router.invalidate();
    return result;
  }

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Waitlist</h1>
            <p className="mt-1 text-sm text-text-muted">
              {rows.length} {rows.length === 1 ? "signup" : "signups"} · newest first
            </p>
          </div>
        </header>

        <div className="mb-6 space-y-3">
          <FilterChipRow
            ariaLabel="Filter by status"
            active={filters.state}
            onChange={(v) => updateFilter("state", v)}
            options={STATE_VALUES.map((v) => ({
              value: v,
              label: STATE_LABELS[v],
              count: stateCounts[v],
            }))}
          />

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <FilterSearchInput
              label="Search"
              placeholder="email"
              value={filters.q}
              onChange={(v) => updateFilter("q", v)}
            />
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            {rows.length === 0
              ? "Nobody has joined the waitlist yet."
              : "No rows match these filters."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-line rounded-2xl border border-ink-line bg-paper-warm">
            {filtered.map((row: WaitlistRow) => (
              <WaitlistRowItem key={row.id} row={row} onIssueInvite={onIssueInvite} />
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function applyFilters(rows: WaitlistRow[], filters: Filters): WaitlistRow[] {
  const needle = filters.q?.toLowerCase() ?? "";
  return rows.filter((r) => {
    if (filters.state !== "all" && r.state !== filters.state) return false;
    if (needle && !r.email.toLowerCase().includes(needle)) return false;
    return true;
  });
}
