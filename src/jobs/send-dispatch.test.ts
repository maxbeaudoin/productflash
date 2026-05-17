import { describe, expect, test } from 'vitest'
import { computeLocal } from './send-dispatch'

// Weekday legend: 0=Sun, 1=Mon, …, 6=Sat (matches Date.prototype.getDay).
// 2026-05-16 is a Saturday → weekday=6 in every test below unless the zone
// pushes the local date across a boundary.

describe('computeLocal', () => {
  test('UTC is identity', () => {
    const now = new Date('2026-05-16T03:00:00Z')
    expect(computeLocal(now, 'UTC')).toEqual({ hour: 3, weekday: 6 })
  })

  test('America/Los_Angeles in May is PDT (UTC-7)', () => {
    // 12:00Z → 05:00 PDT, still Saturday.
    const now = new Date('2026-05-16T12:00:00Z')
    expect(computeLocal(now, 'America/Los_Angeles')).toEqual({ hour: 5, weekday: 6 })
  })

  test('Pacific/Auckland in May is NZST (UTC+12) — pushes local into Saturday noon', () => {
    // 00:00Z Saturday → 12:00 NZST Saturday.
    const now = new Date('2026-05-16T00:00:00Z')
    expect(computeLocal(now, 'Pacific/Auckland')).toEqual({ hour: 12, weekday: 6 })
  })

  test('zone shift crosses the day boundary backwards (UTC Sat 03:00 → LA Fri 20:00)', () => {
    // Sat 03:00Z minus 7h PDT = Fri 20:00. weekday should land on Friday=5.
    const now = new Date('2026-05-16T03:00:00Z')
    expect(computeLocal(now, 'America/Los_Angeles')).toEqual({ hour: 20, weekday: 5 })
  })

  test('zone shift crosses the day boundary forwards (UTC Fri 23:00 → Auckland Sat 11:00)', () => {
    const now = new Date('2026-05-15T23:00:00Z')
    expect(computeLocal(now, 'Pacific/Auckland')).toEqual({ hour: 11, weekday: 6 })
  })

  test('US DST spring-forward: 07:00Z on the transition day is 03:00 EDT (not 02:00 EST)', () => {
    // 2026-03-08 is the second Sunday of March → US DST forward at 02:00
    // local jumps to 03:00 EDT (UTC-4). 07:00Z = 03:00 EDT.
    const now = new Date('2026-03-08T07:00:00Z')
    expect(computeLocal(now, 'America/New_York')).toEqual({ hour: 3, weekday: 0 })
  })

  test('EU DST fall-back: post-transition Sunday morning is local +1 (CET, not CEST)', () => {
    // EU DST ends 2026-10-25 at 03:00 local Paris → falls back to 02:00 CET
    // (UTC+1). Pick 05:00Z, well past the ambiguous hour: 05:00Z + 1h = 06:00.
    const now = new Date('2026-10-25T05:00:00Z')
    expect(computeLocal(now, 'Europe/Paris')).toEqual({ hour: 6, weekday: 0 })
  })

  test('EU pre-fall-back Saturday is CEST (UTC+2)', () => {
    // Day before DST ends, same UTC instant +2h.
    const now = new Date('2026-10-24T05:00:00Z')
    expect(computeLocal(now, 'Europe/Paris')).toEqual({ hour: 7, weekday: 6 })
  })

  test('local midnight is reported as hour=0 (normalization of en-US "24" quirk)', () => {
    // 2026-05-16T22:00Z + LA (UTC-7) = 15:00 same day, so use a different
    // instant. 2026-05-17T07:00Z = 00:00 PDT Sunday. Some Node versions emit
    // "24" instead of "00" from en-US hour12:false formatToParts — the
    // function's `% 24` should fold that to 0.
    const now = new Date('2026-05-17T07:00:00Z')
    expect(computeLocal(now, 'America/Los_Angeles')).toEqual({ hour: 0, weekday: 0 })
  })

  test('invalid IANA tz throws', () => {
    const now = new Date('2026-05-16T12:00:00Z')
    expect(() => computeLocal(now, 'Not/A_Zone')).toThrow()
  })
})
