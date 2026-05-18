import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { issueInvite, listWaitlist } from "~/features/waitlist/server/admin-fns";
import type { WaitlistRow } from "~/features/waitlist/shared/types";
import { WaitlistRowItem } from "~/features/waitlist/ui/admin/waitlist-row-item";

// Minimal admin surface for issuing invites off the public waitlist (#34).
// Lives at /admin/waitlist behind requireAdminSession. Shares no nav with
// the future /admin/users (#16) yet — those converge once #16 lands.

const filterSchema = z.object({
  state: z.enum(["all", "waitlist", "invited", "accepted"]).catch("all"),
});

export const Route = createFileRoute("/admin/waitlist")({
  validateSearch: filterSchema,
  loader: async () => listWaitlist(),
  component: AdminWaitlistPage,
});

const FILTERS: { value: z.infer<typeof filterSchema>["state"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "waitlist", label: "Waitlist" },
  { value: "invited", label: "Invited" },
  { value: "accepted", label: "Accepted" },
];

function AdminWaitlistPage() {
  const { rows } = Route.useLoaderData();
  const { state: stateFilter } = Route.useSearch();
  const router = useRouter();
  const counts = {
    all: rows.length,
    waitlist: rows.filter((r: WaitlistRow) => r.state === "waitlist").length,
    invited: rows.filter((r: WaitlistRow) => r.state === "invited").length,
    accepted: rows.filter((r: WaitlistRow) => r.state === "accepted").length,
  };
  const filtered =
    stateFilter === "all" ? rows : rows.filter((r: WaitlistRow) => r.state === stateFilter);

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

        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filter by status">
          {FILTERS.map((f) => {
            const active = stateFilter === f.value;
            const count = counts[f.value];
            return (
              <Link
                key={f.value}
                to="/admin/waitlist"
                search={{ state: f.value }}
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
                  {count}
                </span>
              </Link>
            );
          })}
        </nav>

        {filtered.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            {rows.length === 0
              ? "Nobody has joined the waitlist yet."
              : "No rows match this filter."}
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
