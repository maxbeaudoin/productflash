// Synthesis cron is `30 5 * * *` (05:30 UTC daily — src/jobs/synthesize.ts).
// Until per-TZ send (#17) ships, every user's next digest lands at the same
// absolute instant; we just localize the display to their tz when we know it.
const NEXT_DIGEST_UTC_HOUR = 5
const NEXT_DIGEST_UTC_MINUTE = 30

export function computeNextDigestAt(now: Date = new Date()): Date {
  const next = new Date(now)
  next.setUTCHours(NEXT_DIGEST_UTC_HOUR, NEXT_DIGEST_UTC_MINUTE, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

export function formatRelativeUntil(target: Date, now: Date = new Date()): string {
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return 'any minute now'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 60) return `in ~${totalMinutes}m`
  const hours = Math.round(totalMinutes / 60)
  if (hours < 24) return `in ~${hours}h`
  const days = Math.round(hours / 24)
  return `in ~${days}d`
}

// Returns e.g. "5:30 AM UTC" or "12:30 AM EST" when the user has a tz.
// Falls back to UTC if the tz string is unset or unrecognized by Intl.
export function formatLocalTimeOfDay(target: Date, tz: string | null): string {
  const tryFormat = (timeZone: string, includeName: boolean) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: includeName ? 'short' : undefined,
    }).format(target)

  if (tz) {
    try {
      return tryFormat(tz, true)
    } catch {
      // fall through to UTC
    }
  }
  return `${tryFormat('UTC', false)} UTC`
}
