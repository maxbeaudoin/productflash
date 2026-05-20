import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "@tanstack/react-form";
import { AtSign, Globe, Rss, Video } from "lucide-react";
import { useState, type ComponentType, type SVGProps } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { FieldShell, fieldHasError } from "~/components/forms/field-shell";
import { Button } from "~/components/ui/button";
import { AdminAuditList } from "~/features/admin-audit/ui/AdminAuditList";
import {
  type CompetitorDetailData,
  type CompetitorSourceRow,
  type CompetitorSourcesRollup,
  loadCompetitorDetail,
  removeCompetitorSource,
  setCompetitorSourceStatus,
  triggerCompetitorDiscovery,
  triggerCompetitorIngest,
  updateCompetitorFields,
  updateCompetitorSourceUrl,
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

const TAB_VALUES = ["activity", "users", "feedback", "audit"] as const;
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
  const router = useRouter();
  const [discoveryState, setDiscoveryState] = useState<"idle" | "running" | "error">("idle");
  const [ingestState, setIngestState] = useState<"idle" | "running" | "error">("idle");
  const [actionNote, setActionNote] = useState<string | null>(null);

  async function onReRunDiscovery() {
    setDiscoveryState("running");
    setActionNote(null);
    try {
      const res = await triggerCompetitorDiscovery({
        data: { competitorId: data.competitor.id },
      });
      setActionNote(
        res.enqueued
          ? `Discovery re-run enqueued (${res.runId.slice(0, 8)}…). Refresh in ~30–60s.`
          : "Discovery already in flight for this competitor — no new job enqueued.",
      );
      setDiscoveryState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue discovery");
      setDiscoveryState("error");
    }
  }

  async function onReIngest() {
    setIngestState("running");
    setActionNote(null);
    try {
      const res = await triggerCompetitorIngest({
        data: { competitorId: data.competitor.id },
      });
      setActionNote(
        res.enqueued
          ? "Ingest re-run enqueued. RSS/webpage/pricing pulled for this competitor only. Refresh in ~30–60s."
          : "Ingest already in flight for this competitor — no new job enqueued.",
      );
      setIngestState("idle");
      router.invalidate();
    } catch (err) {
      setActionNote(err instanceof Error ? err.message : "Failed to enqueue ingest");
      setIngestState("error");
    }
  }

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

        <ActionsRow
          discoveryState={discoveryState}
          ingestState={ingestState}
          actionNote={actionNote}
          onReRunDiscovery={onReRunDiscovery}
          onReIngest={onReIngest}
        />

        <TabBar competitorId={data.competitor.id} active={tab} data={data} />
        <TabContent tab={tab} data={data} />
      </div>
    </main>
  );
}

function ActionsRow({
  discoveryState,
  ingestState,
  actionNote,
  onReRunDiscovery,
  onReIngest,
}: {
  discoveryState: "idle" | "running" | "error";
  ingestState: "idle" | "running" | "error";
  actionNote: string | null;
  onReRunDiscovery: () => void;
  onReIngest: () => void;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-ink-line bg-paper-warm p-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onReRunDiscovery}
          disabled={discoveryState === "running"}
          title="Re-run the source-discovery agent for this competitor. Sources upsert; duplicates from prior runs are skipped."
        >
          {discoveryState === "running" ? "Enqueuing…" : "Re-run source discovery"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onReIngest}
          disabled={ingestState === "running"}
          title="Pull RSS / webpage / pricing for this competitor only. raw_items dedupes on (source, external_id) so re-runs are safe."
        >
          {ingestState === "running" ? "Enqueuing…" : "Re-ingest this competitor"}
        </Button>
        <p className="text-xs text-text-muted">
          Both queues are singleton-per-competitor — a duplicate click while a job is in flight is a
          no-op.
        </p>
      </div>
      {actionNote ? (
        <p className="mt-3 rounded-md border border-ink-line bg-paper px-3 py-2 font-mono text-xs text-text">
          {actionNote}
        </p>
      ) : null}
    </section>
  );
}

function HeaderCard({ data }: { data: CompetitorDetailData }) {
  const { competitor } = data;
  const domain = parseDomain(competitor.homepageUrl);
  return (
    <section className="rounded-2xl border border-ink-line bg-paper-warm p-6">
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
    </section>
  );
}

function SummaryStats({ data }: { data: CompetitorDetailData }) {
  const totalIngest30d = data.sourcesRollup.totalItems30d;
  const lastIngestedAt = data.sourcesRollup.lastIngestedAt;
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
            Name and homepage. Every change is logged to the admin audit trail.
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
      </div>
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
    case "feedback":
      return <FeedbackTab feedback={data.feedback} />;
    case "audit":
      return <AuditTab rows={data.auditRows} />;
    case "activity":
    default:
      return (
        <ActivityTab
          sources={data.sources}
          sourcesRollup={data.sourcesRollup}
          recentItems={data.recentItems}
        />
      );
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

type LucideIconType = ComponentType<SVGProps<SVGSVGElement>>;

// `x`/`linkedin`/`youtube` are discovery-only this round (no watcher) —
// they get an "inert" pill instead of the items-in-30d count. Keep
// `INERT_SOURCE_TYPES` in sync with the watcher flip-on order documented
// in PF-93.
const INERT_SOURCE_TYPES: ReadonlySet<CompetitorSourceRow["sourceType"]> = new Set([
  "x",
  "linkedin",
  "youtube",
]);

const SOURCE_TYPE_META: Record<
  CompetitorSourceRow["sourceType"],
  { label: string; Icon: LucideIconType }
> = {
  rss: { label: "RSS", Icon: Rss },
  webpage: { label: "Webpage", Icon: Globe },
  x: { label: "X", Icon: AtSign },
  linkedin: { label: "LinkedIn", Icon: AtSign },
  youtube: { label: "YouTube", Icon: Video },
};

const SOURCE_STATUS_META: Record<
  CompetitorSourceRow["status"],
  { label: string; className: string }
> = {
  active: { label: "Active", className: "border-accent/40 bg-accent/15 text-text" },
  failing: { label: "Failing", className: "border-coral/50 bg-coral/15 text-text" },
  disabled: { label: "Disabled", className: "border-ink-line bg-paper text-text-muted" },
};

const RAW_ITEM_SOURCE_LABEL: Record<CompetitorDetailData["recentItems"][number]["source"], string> =
  {
    rss: "RSS",
    firecrawl: "Firecrawl",
    webpage: "Webpage",
  };

function ActivityTab({
  sources,
  sourcesRollup,
  recentItems,
}: {
  sources: CompetitorSourceRow[];
  sourcesRollup: CompetitorSourcesRollup;
  recentItems: CompetitorDetailData["recentItems"];
}) {
  return (
    <div className="space-y-6">
      <SourcesSection sources={sources} rollup={sourcesRollup} />
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

function SourcesSection({
  sources,
  rollup,
}: {
  sources: CompetitorSourceRow[];
  rollup: CompetitorSourcesRollup;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-muted">
          Sources <span className="text-text-muted">· {sources.length}</span>
        </h3>
        <p className="text-[11px] text-text-muted">
          <span className="font-mono tabular-nums text-text">{rollup.activeCount}</span> active ·{" "}
          <span className="font-mono tabular-nums text-text">{rollup.totalItems30d}</span> items
          (30d) · last ingest{" "}
          <span className="font-mono text-text">
            {rollup.lastIngestedAt ? relativeLabel(new Date(rollup.lastIngestedAt)) : "—"}
          </span>
        </p>
      </div>
      {sources.length === 0 ? (
        <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
          No sources recorded yet. The discovery agent runs on competitor creation — if this row
          predates PF-95 and has no synthetic rss source, re-trigger the agent (phase 5 / PF-93).
        </p>
      ) : (
        <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      )}
    </section>
  );
}

type SourceRowMode = "view" | "edit-url";

function SourceRow({ source }: { source: CompetitorSourceRow }) {
  const router = useRouter();
  const [mode, setMode] = useState<SourceRowMode>("view");
  const [rationaleOpen, setRationaleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = SOURCE_TYPE_META[source.sourceType];
  const isInert = INERT_SOURCE_TYPES.has(source.sourceType);
  const Icon = meta.Icon;

  async function handleToggleStatus() {
    const next: CompetitorSourceRow["status"] =
      source.status === "disabled" ? "active" : "disabled";
    setBusy(true);
    try {
      const res = await setCompetitorSourceStatus({
        data: { sourceId: source.id, status: next },
      });
      if (res.changed) toast.success(next === "disabled" ? "Source disabled." : "Source enabled.");
      else toast.info("Status unchanged.");
      router.invalidate();
    } catch {
      toast.error("Could not update source. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    if (!confirm(`Remove this ${meta.label} source? Past items stay in history.`)) return;
    setBusy(true);
    try {
      await removeCompetitorSource({ data: { sourceId: source.id } });
      toast.success("Source removed.");
      router.invalidate();
    } catch {
      toast.error("Could not remove source. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-label={meta.label}
          title={meta.label}
          className="inline-flex size-7 items-center justify-center rounded-md border border-ink-line bg-paper text-text"
        >
          <Icon className="size-3.5" />
        </span>
        <a
          href={source.urlOrHandle.startsWith("@") ? "#" : source.urlOrHandle}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-sm text-text hover:underline"
          onClick={(e) => {
            if (source.urlOrHandle.startsWith("@")) e.preventDefault();
          }}
        >
          {source.urlOrHandle}
        </a>
        <StatusPill status={source.status} />
        {isInert ? (
          <span
            className="inline-flex items-center rounded-pill border border-ink-line/60 bg-paper-warm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted"
            title="Discovery-only — no watcher yet"
          >
            not yet ingested
          </span>
        ) : (
          <span className="inline-flex items-baseline gap-1 text-[11px] text-text-muted">
            <span className="font-mono tabular-nums text-text">{source.itemCount30d}</span>
            <span>items (30d)</span>
          </span>
        )}
        <span className="text-[10px] uppercase tracking-[0.1em] text-text-muted">
          {source.lastFetchedAt
            ? `fetched ${relativeLabel(new Date(source.lastFetchedAt))}`
            : "never fetched"}
        </span>
      </div>

      {source.agentRationale ? (
        <button
          type="button"
          onClick={() => setRationaleOpen((v) => !v)}
          className="inline-flex items-baseline gap-1 self-start text-[11px] text-text-muted hover:text-text"
          aria-expanded={rationaleOpen}
        >
          <span aria-hidden>{rationaleOpen ? "▾" : "▸"}</span>
          {rationaleOpen ? (
            <span className="italic">{source.agentRationale}</span>
          ) : (
            <span>agent rationale</span>
          )}
        </button>
      ) : null}

      {mode === "edit-url" ? (
        <SourceUrlEditor
          source={source}
          onCancel={() => setMode("view")}
          onSaved={() => {
            setMode("view");
            router.invalidate();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setMode("edit-url")}
          >
            Edit URL
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={handleToggleStatus}
          >
            {source.status === "disabled" ? "Enable" : "Disable"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={handleRemove}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}

function SourceUrlEditor({
  source,
  onCancel,
  onSaved,
}: {
  source: CompetitorSourceRow;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(source.urlOrHandle);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = value.trim();
    if (!next) {
      toast.error("URL or @handle is required.");
      return;
    }
    if (next === source.urlOrHandle) {
      onCancel();
      return;
    }
    setBusy(true);
    try {
      const res = await updateCompetitorSourceUrl({
        data: { sourceId: source.id, urlOrHandle: next },
      });
      if (res.changed) toast.success("Source URL updated. Last-fetched reset.");
      else toast.info("URL unchanged.");
      onSaved();
    } catch {
      toast.error("Could not update URL. Check the format and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
        className="h-8 flex-1 min-w-[16rem] rounded-md border border-ink-line bg-paper px-3 font-mono text-sm text-text outline-none focus:border-text"
        aria-label="Source URL or @handle"
        disabled={busy}
      />
      <Button type="submit" size="xs" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </Button>
      <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function StatusPill({ status }: { status: CompetitorSourceRow["status"] }) {
  const meta = SOURCE_STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-pill border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

function RawItemRow({ item }: { item: CompetitorDetailData["recentItems"][number] }) {
  return (
    <li className="flex flex-col gap-1 px-5 py-3">
      <div className="flex items-center gap-2">
        <RawItemSourcePill source={item.source} />
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

function RawItemSourcePill({
  source,
}: {
  source: CompetitorDetailData["recentItems"][number]["source"];
}) {
  return (
    <span className="inline-flex items-center rounded-pill border border-ink-line bg-paper px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
      {RAW_ITEM_SOURCE_LABEL[source]}
    </span>
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
