import type { CompetitorAdminRow } from "~/features/competitors/server/admin-fns";

// PF-64. Three triage buckets surfaced on /admin/competitors so dead feeds
// stop sitting in the table unnoticed. Computed client-side from the loader's
// rows — no schema or query changes.

export const STALE_THRESHOLD_DAYS = 30;

export type HealthFlagKind = "orphans" | "sourceless" | "stale";

export type HealthFlagBucket = {
  kind: HealthFlagKind;
  rows: CompetitorAdminRow[];
};

export function classifyHealthFlags(
  rows: CompetitorAdminRow[],
  nowMs: number = Date.now(),
): Record<HealthFlagKind, HealthFlagBucket> {
  const staleCutoffMs = nowMs - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const orphans: CompetitorAdminRow[] = [];
  const sourceless: CompetitorAdminRow[] = [];
  const stale: CompetitorAdminRow[] = [];

  for (const row of rows) {
    if (row.trackedBy === 0) orphans.push(row);

    const hasSource = row.rssUrl !== null || row.phSlug !== null;
    if (!hasSource) {
      sourceless.push(row);
      continue;
    }

    const lastMs = row.lastIngestedAt ? new Date(row.lastIngestedAt).getTime() : null;
    if (lastMs === null || lastMs < staleCutoffMs) stale.push(row);
  }

  return {
    orphans: { kind: "orphans", rows: orphans },
    sourceless: { kind: "sourceless", rows: sourceless },
    stale: { kind: "stale", rows: stale },
  };
}
