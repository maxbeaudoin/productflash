import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { Button } from "~/components/ui/button";
import { AdminAuditList } from "~/features/admin-audit/ui/AdminAuditList";
import {
  type CompetitorDetailData,
  type CompetitorIngestionRow,
  loadCompetitorDetail,
  updateCompetitorFields,
} from "~/features/competitors/server/admin-fns";
import {
  type CompetitorEditFormValues,
  competitorEditFormSchema,
} from "~/features/competitors/schema";
import { cn } from "~/shared/iso/utils";

// /admin/competitors/:id (PF-66). Detail view for one competitor row. The
// page is tab-based on purpose — the issue calls out that a future
// **Relationships** tab needs to slot in without restructuring the page.
// All tabs read from the same loader payload (one round trip per page load);
// switching tabs is purely client-side.
//
// Editing competitor fields makes admin the second privileged writer of a
// shared row (the FTE agent being the first; see invariant on
// `competitors` in db/schema.ts). The audit log (PF-60) covers the
// blast-radius forensics.

const TAB_VALUES = ["activity", "users", "pricing", "feedback", "audit"] as const;
type TabValue = (typeof TAB_VALUES)[number];

const searchSchema = z.object({
  tab: z.enum(TAB_VALUES).catch("activity"),
});

export const Route = createFileRoute("/admin/competitors/$competitorId")({
  validateSearch: searchSchema,
  loader: ({ params }) => loadCompetitorDetail({ data: { competitorId: params.competitorId } }),
  component: AdminCompetitorDetailPage,
});

function AdminCompetitorDetailPage() {
  const data = Route.useLoaderData();
  const { tab } = Route.useSearch();

  return (
    <main className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <Link
          to="/admin/competitors"
          search={{ source: "all", tracked: "any", recent: "all" }}
          className="mb-6 inline-flex items-center gap-2 text-xs uppercase tracking-[0.1em] text-text-muted hover:text-text"
        >
          <span aria-hidden>←</span> All competitors
        </Link>

        <HeaderCard data={data} />
        <SummaryStats data={data} />
        <EditSection competitor={data.competitor} trackedBy={data.trackedBy} />

        <TabBar competitorId={data.competitor.id} active={tab} data={data} />
        <TabContent tab={tab} data={data} />
      </div>
    </main>
  );
}

function HeaderCard({ data }: { data: CompetitorDetailData }) {
  const { competitor } = data;
  const domain = parseDomain(competitor.homepageUrl);
  return (
    <section className="rounded-2xl border border-ink-line bg-paper-warm p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{competitor.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <a
              href={competitor.homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-text hover:underline"
            >
              {domain}
            </a>
            <span aria-hidden>·</span>
            <span>Added {formatDate(competitor.createdAt)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <PresenceChip label="RSS" present={competitor.rssUrl !== null} />
            <PresenceChip label="PH" present={competitor.phSlug !== null} />
            <PresenceChip label="Pricing" present={competitor.pricingUrl !== null} />
          </div>
          <code className="font-mono text-xs text-text-muted">{competitor.id}</code>
        </div>
      </div>
    </section>
  );
}

function SummaryStats({ data }: { data: CompetitorDetailData }) {
  const totalIngest30d = data.ingestion.reduce((sum, i) => sum + i.count30d, 0);
  const lastIngestedAt = data.ingestion
    .map((i) => i.lastIngestedAt)
    .filter((s): s is string => s !== null)
    .sort()
    .at(-1);
  const hit = data.digestHitRate;
  const hitPct =
    hit.rawCount30d > 0 ? Math.round((hit.digestCount30d / hit.rawCount30d) * 100) : null;
  const fb = data.feedback;
  const totalFb = fb.up + fb.down;
  const upPct = totalFb > 0 ? Math.round((fb.up / totalFb) * 100) : null;
  return (
    <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Users tracking"
        value={String(data.trackedBy)}
        hint={data.trackedBy === 0 ? "orphan row" : null}
      />
      <StatCard
        label="Ingest (30d)"
        value={String(totalIngest30d)}
        hint={lastIngestedAt ? `last ${relativeLabel(new Date(lastIngestedAt))}` : "never"}
      />
      <StatCard
        label="Digest hit rate"
        value={hitPct === null ? "—" : `${hitPct}%`}
        hint={
          hit.rawCount30d > 0
            ? `${hit.digestCount30d} / ${hit.rawCount30d} surfaced`
            : "no items in 30d"
        }
      />
      <StatCard
        label="Feedback ratio"
        value={upPct === null ? "—" : `${upPct}% 👍`}
        hint={totalFb > 0 ? `${fb.up} 👍 · ${fb.down} 👎` : "no ratings yet"}
      />
    </section>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string | null }) {
  return (
    <div className="rounded-2xl border border-ink-line bg-paper-warm p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl tabular-nums text-text">{value}</div>
      {hint ? <div className="mt-1 text-[10px] text-text-muted">{hint}</div> : null}
    </div>
  );
}

function EditSection({
  competitor,
  trackedBy,
}: {
  competitor: CompetitorDetailData["competitor"];
  trackedBy: number;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function handleSave(values: CompetitorEditFormValues) {
    const res = await updateCompetitorFields({
      data: { competitorId: competitor.id, values },
    });
    if (res.changed) {
      toast.success("Competitor updated. Audit row written.");
    } else {
      toast.info("No fields changed.");
    }
    setOpen(false);
    router.invalidate();
  }

  return (
    <section className="mt-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-text">
            Edit details
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Name, homepage, RSS URL, PH slug, and pricing URL. Every change is logged to the admin
            audit trail.
          </p>
        </div>
        <Button type="button" variant={open ? "ghost" : "default"} onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Edit details"}
        </Button>
      </div>
      {open ? (
        <div className="mt-5">
          <BlastRadiusWarning trackedBy={trackedBy} />
          <CompetitorEditForm
            initial={competitor}
            onCancel={() => setOpen(false)}
            onSubmit={handleSave}
          />
        </div>
      ) : null}
    </section>
  );
}

function BlastRadiusWarning({ trackedBy }: { trackedBy: number }) {
  if (trackedBy === 0) {
    return (
      <p className="mb-4 rounded-md border border-ink-line bg-paper px-3 py-2 text-xs text-text-muted">
        No users currently track this competitor. Edits here only affect future trackers and
        ingestion.
      </p>
    );
  }
  return (
    <p className="mb-4 rounded-md border border-coral/40 bg-coral/10 px-3 py-2 text-xs text-text">
      <strong className="font-semibold">Editing affects {trackedBy}</strong>{" "}
      {trackedBy === 1 ? "user" : "users"} — competitor rows are shared across every user tracking
      them. Source URL changes also re-target the next ingestion run.
    </p>
  );
}

function CompetitorEditForm({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: CompetitorDetailData["competitor"];
  onCancel: () => void;
  onSubmit: (values: CompetitorEditFormValues) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: {
      name: initial.name,
      homepageUrl: initial.homepageUrl,
      rssUrl: initial.rssUrl ?? "",
      phSlug: initial.phSlug ?? "",
      pricingUrl: initial.pricingUrl ?? "",
    },
    validators: { onChange: competitorEditFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const parsed = competitorEditFormSchema.safeParse(value);
      if (!parsed.success) return;
      try {
        await onSubmit(parsed.data);
        formApi.reset();
      } catch {
        toast.error("Could not save changes. Try again.");
        throw new Error("competitor_edit_failed");
      }
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="grid gap-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <form.Field name="name">
          {(field) => (
            <FieldShell field={field} label="Name" labelClassName={labelClass}>
              <input
                id={field.name}
                type="text"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="homepageUrl">
          {(field) => (
            <FieldShell field={field} label="Homepage URL" labelClassName={labelClass}>
              <input
                id={field.name}
                type="text"
                inputMode="url"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="rssUrl">
          {(field) => (
            <FieldShell
              field={field}
              label="RSS URL"
              labelClassName={labelClass}
              hint="Leave blank to clear."
            >
              <input
                id={field.name}
                type="text"
                inputMode="url"
                placeholder="https://example.com/feed.xml"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
        <form.Field name="phSlug">
          {(field) => (
            <FieldShell
              field={field}
              label="Product Hunt slug"
              labelClassName={labelClass}
              hint="Lowercase a-z, 0-9, hyphens. Leave blank to clear."
            >
              <input
                id={field.name}
                type="text"
                placeholder="notion"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                aria-invalid={fieldHasError(field)}
                className={inputClass}
              />
            </FieldShell>
          )}
        </form.Field>
      </div>
      <form.Field name="pricingUrl">
        {(field) => (
          <FieldShell
            field={field}
            label="Pricing URL"
            labelClassName={labelClass}
            hint="Used by the Firecrawl pricing-snapshot job. Leave blank to clear."
          >
            <input
              id={field.name}
              type="text"
              inputMode="url"
              placeholder="https://example.com/pricing"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              aria-invalid={fieldHasError(field)}
              className={inputClass}
            />
          </FieldShell>
        )}
      </form.Field>
      <div className="flex flex-wrap items-center gap-2">
        <form.Subscribe
          selector={(s) => ({ canSubmit: s.canSubmit, isSubmitting: s.isSubmitting })}
        >
          {({ canSubmit, isSubmitting }) => (
            <>
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? "Saving…" : "Save changes"}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
                Cancel
              </Button>
            </>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}

const labelClass = "text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted";
const inputClass =
  "h-10 w-full rounded-md border border-ink-line bg-paper px-3 font-mono text-sm text-text outline-none transition-colors focus:border-text aria-invalid:border-coral aria-invalid:focus:border-coral";

function TabBar({
  competitorId,
  active,
  data,
}: {
  competitorId: string;
  active: TabValue;
  data: CompetitorDetailData;
}) {
  const items: { value: TabValue; label: string; count?: number }[] = [
    { value: "activity", label: "Activity", count: data.recentItems.length },
    { value: "users", label: "Users", count: data.trackedBy },
    { value: "pricing", label: "Pricing" },
    {
      value: "feedback",
      label: "Feedback",
      count: data.feedback.up + data.feedback.down,
    },
    { value: "audit", label: "Audit", count: data.auditRows.length },
  ];
  return (
    <nav
      aria-label="Competitor detail sections"
      className="mt-8 mb-6 flex flex-wrap gap-1 border-b border-ink-line"
    >
      {items.map((item) => {
        const isActive = active === item.value;
        return (
          <Link
            key={item.value}
            to="/admin/competitors/$competitorId"
            params={{ competitorId }}
            search={{ tab: item.value }}
            replace
            className={cn(
              "-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              isActive
                ? "border-text text-text"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            <span>{item.label}</span>
            {typeof item.count === "number" ? (
              <span className="font-mono text-[10px] tabular-nums text-text-muted">
                {item.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

function TabContent({ tab, data }: { tab: TabValue; data: CompetitorDetailData }) {
  switch (tab) {
    case "users":
      return <UsersTab rows={data.usersTracking} />;
    case "pricing":
      return <PricingTab pricing={data.pricing} pricingUrl={data.competitor.pricingUrl} />;
    case "feedback":
      return <FeedbackTab feedback={data.feedback} />;
    case "audit":
      return <AuditTab rows={data.auditRows} />;
    case "activity":
    default:
      return <ActivityTab ingestion={data.ingestion} recentItems={data.recentItems} />;
  }
}

function UsersTab({ rows }: { rows: CompetitorDetailData["usersTracking"] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
        No users track this competitor right now. Orphan rows are usually FTE-suggested competitors
        a user later removed.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
      {rows.map((row) => (
        <li
          key={row.userId}
          className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <Link
            to="/admin/users/$userId"
            params={{ userId: row.userId }}
            className="truncate font-mono text-sm text-text hover:underline"
          >
            {row.email}
          </Link>
          <span className="text-[10px] uppercase tracking-[0.1em] text-text-muted">
            added {formatDate(row.addedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

const SOURCE_LABEL: Record<CompetitorIngestionRow["source"], string> = {
  rss: "RSS",
  ph: "Product Hunt",
  firecrawl: "Firecrawl",
  firehose: "Firehose",
};

function ActivityTab({
  ingestion,
  recentItems,
}: {
  ingestion: CompetitorIngestionRow[];
  recentItems: CompetitorDetailData["recentItems"];
}) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
          Ingestion health
        </h3>
        <div className="overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
          <table className="w-full text-sm">
            <thead className="text-left text-[10px] uppercase tracking-[0.1em] text-text-muted">
              <tr className="border-b border-ink-line">
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">24h</th>
                <th className="px-4 py-2 text-right font-medium">7d</th>
                <th className="px-4 py-2 text-right font-medium">30d</th>
                <th className="px-4 py-2 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-line">
              {ingestion.map((row) => (
                <tr key={row.source}>
                  <td className="px-4 py-2 text-text">{SOURCE_LABEL[row.source]}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{row.count24h}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{row.count7d}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{row.count30d}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-text-muted">
                    {row.lastIngestedAt ? relativeLabel(new Date(row.lastIngestedAt)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
          Recent items <span className="text-text-muted">· latest {recentItems.length}</span>
        </h3>
        {recentItems.length === 0 ? (
          <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
            No raw items ingested for this competitor. Check the source URLs above.
          </p>
        ) : (
          <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
            {recentItems.map((item) => (
              <RawItemRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RawItemRow({ item }: { item: CompetitorDetailData["recentItems"][number] }) {
  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <div className="flex items-center gap-2">
        <SourcePill source={item.source} />
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-sm text-text hover:underline"
        >
          {item.title}
        </a>
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] uppercase tracking-[0.1em] text-text-muted">
        <span>ingested {relativeLabel(new Date(item.ingestedAt))}</span>
        {item.publishedAt ? (
          <span>published {relativeLabel(new Date(item.publishedAt))}</span>
        ) : null}
      </div>
    </li>
  );
}

function SourcePill({ source }: { source: CompetitorIngestionRow["source"] }) {
  return (
    <span className="inline-flex items-center rounded-pill border border-ink-line bg-paper px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
      {SOURCE_LABEL[source]}
    </span>
  );
}

function PricingTab({
  pricing,
  pricingUrl,
}: {
  pricing: CompetitorDetailData["pricing"];
  pricingUrl: string | null;
}) {
  if (!pricing) {
    return (
      <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
        No pricing snapshot yet.{" "}
        {pricingUrl
          ? "The Firecrawl job hasn't run for this URL — re-trigger ingestion or wait for the next cron."
          : "Set a pricing URL above first."}
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-ink-line bg-paper-warm p-6">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 text-xs text-text-muted">
        <span>
          Scraped {formatDateTime(pricing.scrapedAt)} · {relativeLabel(new Date(pricing.scrapedAt))}
        </span>
        <code className="font-mono text-[10px]">hash {pricing.contentHash.slice(0, 12)}…</code>
      </div>
      <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-ink-line bg-paper p-4 font-mono text-xs text-text">
        {pricing.content}
      </pre>
    </div>
  );
}

function FeedbackTab({ feedback }: { feedback: CompetitorDetailData["feedback"] }) {
  const total = feedback.up + feedback.down;
  const upPct = total > 0 ? Math.round((feedback.up / total) * 100) : 0;
  if (total === 0) {
    return (
      <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
        No ratings on items from this competitor yet.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-ink-line bg-paper-warm p-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="Total ratings" value={String(total)} hint={null} />
        <StatCard label="👍 Likes" value={String(feedback.up)} hint={`${upPct}%`} />
        <StatCard
          label="👎 Dislikes"
          value={String(feedback.down)}
          hint={total > 0 ? `${100 - upPct}%` : null}
        />
      </div>
      <div className="mt-4">
        <div className="flex h-2 overflow-hidden rounded-pill bg-paper">
          <div className="bg-accent" style={{ width: `${upPct}%` }} aria-hidden />
          <div className="bg-coral" style={{ width: `${100 - upPct}%` }} aria-hidden />
        </div>
      </div>
    </div>
  );
}

function AuditTab({ rows }: { rows: CompetitorDetailData["auditRows"] }) {
  return (
    <AdminAuditList
      rows={rows}
      hideTarget
      emptyMessage="No admin actions on this competitor yet. The first edit above will land here."
    />
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
