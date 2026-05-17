// Forecasts when a user's next digest will actually land at /app/digests,
// accounting for:
//   - the per-TZ send dispatcher (#17) firing at the user's local 7am, and
//   - the no-weekend rule (Saturday + Sunday are quiet; Monday's brief
//     covers the weekend).
//
// The first guard for delivery is still synthesize at 05:30 UTC. For
// users in NA/EU TZs that lands well before their local 7am. The banner
// just shows them the next time a digest is scheduled to appear; if the
// synthesis happens to be late or fail, the relative timer ticks past
// "any minute now" and the loader rendering the banner will simply pick
// the next valid send slot on the next page load.

const DEFAULT_SEND_HOUR = 7;

export interface NextDigestForecast {
  // Absolute instant of the next scheduled delivery.
  at: Date;
  // Human-readable description of the local slot in the user's tz, e.g.
  // "Tuesday at 7:00 AM EDT" or "Monday at 7:00 AM UTC" when no tz.
  whenLabel: string;
}

export function computeNextDigestFor(
  tz: string | null,
  now: Date = new Date(),
): NextDigestForecast {
  const zone = resolveZone(tz);
  // Walk forward day-by-day from "now" until we land on the next Mon-Fri
  // 7am slot in the user's zone. Capped at 8 iterations as a defensive
  // bound — a healthy zone should always resolve within 4 (today + Fri-Sun).
  for (let offset = 0; offset < 8; offset++) {
    const candidate = computeLocalSlot(now, zone, offset, DEFAULT_SEND_HOUR);
    if (candidate.getTime() <= now.getTime()) continue;
    const weekday = weekdayInZone(candidate, zone);
    if (weekday === 0 || weekday === 6) continue;
    return {
      at: candidate,
      whenLabel: formatSlotLabel(candidate, zone),
    };
  }
  // Should be unreachable; fall through to next-day UTC 7am as a safe
  // last resort.
  const fallback = computeLocalSlot(now, "UTC", 1, DEFAULT_SEND_HOUR);
  return { at: fallback, whenLabel: formatSlotLabel(fallback, "UTC") };
}

export function formatRelativeUntil(target: Date, now: Date = new Date()): string {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "any minute now";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `in ~${totalMinutes}m`;
  const hours = Math.round(totalMinutes / 60);
  if (hours < 24) return `in ~${hours}h`;
  const days = Math.round(hours / 24);
  return `in ~${days}d`;
}

function resolveZone(tz: string | null): string {
  if (!tz) return "UTC";
  try {
    // Trigger an Intl validation by instantiating with the zone — bad
    // strings throw RangeError. Cheap; we don't keep the formatter.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

// Returns the instant matching `targetHour` in `zone` on the date that is
// `dayOffset` days after `now` in that zone. Solved by formatting `now` in
// the zone, advancing the rendered Y/M/D by `dayOffset`, then binary-
// searching the matching UTC instant via Intl. We use a direct
// construction instead — for IANA names with whole-hour offsets the only
// edge case is DST transitions, and on a daily 7am slot a single retry
// near the transition is enough.
function computeLocalSlot(now: Date, zone: string, dayOffset: number, targetHour: number): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  // Start by guessing the UTC instant for that wall-clock Y/M/D at
  // targetHour. Then read what time that lands in the zone, and subtract
  // the delta to converge. One iteration is enough for whole-hour offsets;
  // a second handles DST cusps.
  let candidate = new Date(Date.UTC(y, m - 1, d + dayOffset, targetHour, 0, 0));
  for (let i = 0; i < 2; i++) {
    const seen = readHourInZone(candidate, zone);
    const delta = targetHour - seen.hour;
    if (delta === 0 && seen.day === d + dayOffset) break;
    candidate = new Date(candidate.getTime() + delta * 60 * 60 * 1000);
  }
  return candidate;
}

function readHourInZone(instant: Date, zone: string): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    hour: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const day = Number(parts.find((p) => p.type === "day")!.value);
  return { hour, day };
}

function weekdayInZone(instant: Date, zone: string): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
  }).format(instant);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[short] ?? 0;
}

function formatSlotLabel(instant: Date, zone: string): string {
  const dayPart = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "long",
  }).format(instant);
  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
  return `${dayPart} at ${timePart}`;
}
