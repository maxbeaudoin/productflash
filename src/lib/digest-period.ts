// Derives header framing + visible date range for a digest from its persisted
// ingestion window (#40). The window is the actual `raw_items` cutoff →
// synthesis-run timestamp the synthesizer wrote to `digests.period_start` /
// `digests.period_end`. Legacy rows (pre-#40) carry nulls — we render no
// range rather than fabricate one.

export type DigestPeriodKind = "catchup" | "daily" | "unknown";

export interface DigestPeriodInput {
  periodStart: string | null;
  periodEnd: string | null;
}

export interface DigestPeriod {
  kind: DigestPeriodKind;
  // Catch-up: "May 9 → May 16". Daily: "May 16". Unknown: null.
  rangeLabel: string | null;
  // Ceil of (periodEnd - periodStart) in whole days. Used in catch-up copy
  // ("past 7 days"). Null when unknown or daily.
  daysBack: number | null;
}

const DAILY_THRESHOLD_HOURS = 48;

export function deriveDigestPeriod(input: DigestPeriodInput): DigestPeriod {
  const { periodStart, periodEnd } = input;
  if (!periodStart || !periodEnd) {
    return { kind: "unknown", rangeLabel: null, daysBack: null };
  }
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const spanMs = end.getTime() - start.getTime();
  const spanHours = spanMs / (60 * 60 * 1000);

  if (spanHours <= DAILY_THRESHOLD_HOURS) {
    return {
      kind: "daily",
      rangeLabel: formatDateShort(end),
      daysBack: null,
    };
  }

  const daysBack = Math.max(1, Math.ceil(spanMs / (24 * 60 * 60 * 1000)));
  return {
    kind: "catchup",
    rangeLabel: `${formatDateShort(start)} → ${formatDateShort(end)}`,
    daysBack,
  };
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
