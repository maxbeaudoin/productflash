import { Link } from "@tanstack/react-router";
import type { AdminAuditPayload, AdminAuditRow, JsonValue } from "../shared/types";

// Shared list renderer for the global `/admin/audit` feed AND the "Recent
// admin activity" surface on user detail pages. Same row visual either way
// — the only thing that changes is the surrounding heading and whether the
// target column is rendered (a per-target view always shows the same
// target, so it's hidden).

type Props = {
  rows: AdminAuditRow[];
  // Hide the target column on per-target detail surfaces — every row would
  // show the same target, so it's noise.
  hideTarget?: boolean;
  emptyMessage?: string;
};

export function AdminAuditList({ rows, hideTarget = false, emptyMessage }: Props) {
  if (rows.length === 0) {
    return (
      <p className="rounded-2xl border border-ink-line bg-paper-warm p-6 text-sm text-text-muted">
        {emptyMessage ?? "No admin actions recorded yet."}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-ink-line overflow-hidden rounded-2xl border border-ink-line bg-paper-warm">
      {rows.map((row) => (
        <AdminAuditRowItem key={row.id} row={row} hideTarget={hideTarget} />
      ))}
    </ul>
  );
}

function AdminAuditRowItem({ row, hideTarget }: { row: AdminAuditRow; hideTarget: boolean }) {
  const occurred = new Date(row.createdAt);
  const dateLabel = occurred.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = occurred.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <ActionChip action={row.action} />
        {hideTarget ? null : <TargetCell row={row} />}
        <span aria-hidden>·</span>
        <span className="font-mono text-text-muted">{row.actorEmail ?? "(deleted admin)"}</span>
        <span aria-hidden>·</span>
        <span>
          {dateLabel} · {timeLabel}
        </span>
      </div>
      <PayloadPreview payload={row.payload} />
    </li>
  );
}

// Pretty-print the few actions we know about; fall back to the raw token
// for anything PF-66/67/68 adds later. Keeping the lookup local so adding a
// new action doesn't ripple into a shared registry — one place to update.
const ACTION_LABEL: Record<string, string> = {
  invite_issued: "Invite issued",
  fte_rerun_enqueued: "FTE re-run enqueued",
  fast_path_enqueued: "Catch-up re-gen enqueued",
  daily_regen_enqueued: "Daily re-gen enqueued",
  competitor_edit: "Competitor edited",
  competitor_source_disable: "Source disabled",
  competitor_source_enable: "Source enabled",
  competitor_source_remove: "Source removed",
  competitor_source_edit_url: "Source URL edited",
};

function ActionChip({ action }: { action: string }) {
  const label = ACTION_LABEL[action] ?? action;
  return (
    <span className="inline-flex items-center rounded-pill bg-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text">
      {label}
    </span>
  );
}

function TargetCell({ row }: { row: AdminAuditRow }) {
  const label = row.targetLabel ?? row.targetId.slice(0, 8) + "…";
  if (row.targetKind === "user") {
    return (
      <Link
        to="/admin/users/$userId"
        params={{ userId: row.targetId }}
        className="font-mono text-text hover:underline"
      >
        {label}
      </Link>
    );
  }
  if (row.targetKind === "competitor") {
    return (
      <Link
        to="/admin/competitors/$competitorId"
        params={{ competitorId: row.targetId }}
        search={{ tab: "audit" }}
        className="font-mono text-text hover:underline"
      >
        {label}
      </Link>
    );
  }
  return (
    <span className="font-mono text-text">
      {row.targetKind}:{label}
    </span>
  );
}

// Single-line preview of payload keys — full JSON is overkill in the feed
// and a per-row "expand" toggle is more UI than this PoC needs. Operators
// who want the raw payload can hit the row id in psql.
function PayloadPreview({ payload }: { payload: AdminAuditPayload }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) return null;
  return (
    <div className="line-clamp-1 font-mono text-[11px] text-text-muted">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 ? " · " : ""}
          <span className="text-text">{k}</span>={formatValue(v)}
        </span>
      ))}
    </div>
  );
}

function formatValue(v: JsonValue): string {
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 40 ? `"${v.slice(0, 39)}…"` : `"${v}"`;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return JSON.stringify(v).slice(0, 60);
}
