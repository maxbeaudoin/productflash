import { describe, expect, test } from 'vitest'
import { computeNextDigestFor, formatRelativeUntil } from './next-digest'

// Banner copy on /app/digests rides on these two functions. A regression
// surfaces as a wrong day-of-week label or a "next digest 3 days from now"
// when it's really tomorrow.

describe('computeNextDigestFor — UTC baseline', () => {
  test('weekday before 7am → same day 7am UTC', () => {
    // 2026-05-13 is a Wednesday.
    const now = new Date('2026-05-13T06:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-13T07:00:00.000Z')
    expect(next.whenLabel).toContain('Wednesday')
  })

  test('weekday at exactly 7am → rolls forward to next weekday 7am', () => {
    // 7am UTC has already arrived (`<= now`) so the forecast skips today.
    const now = new Date('2026-05-13T07:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-14T07:00:00.000Z')
    expect(next.whenLabel).toContain('Thursday')
  })

  test('weekday after 7am → next weekday 7am', () => {
    const now = new Date('2026-05-13T08:30:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-14T07:00:00.000Z')
  })

  test('Friday after 7am → skips weekend, lands Monday 7am', () => {
    // 2026-05-15 is a Friday → Mon 2026-05-18.
    const now = new Date('2026-05-15T09:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-18T07:00:00.000Z')
    expect(next.whenLabel).toContain('Monday')
  })

  test('Saturday → Monday 7am', () => {
    const now = new Date('2026-05-16T06:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-18T07:00:00.000Z')
    expect(next.whenLabel).toContain('Monday')
  })

  test('Sunday → Monday 7am', () => {
    const now = new Date('2026-05-17T12:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.at.toISOString()).toBe('2026-05-18T07:00:00.000Z')
  })
})

describe('computeNextDigestFor — IANA zones', () => {
  test("America/New_York — Friday 06:00 EDT (10:00Z) → today's 07:00 EDT (11:00Z)", () => {
    // 2026-05-15 is Friday. EDT = UTC-4.
    const now = new Date('2026-05-15T10:00:00Z')
    const next = computeNextDigestFor('America/New_York', now)
    expect(next.at.toISOString()).toBe('2026-05-15T11:00:00.000Z')
    expect(next.whenLabel).toContain('Friday')
  })

  test('America/New_York — Saturday in local → Monday 07:00 EDT (11:00Z)', () => {
    // Sat 2026-05-16 at 12:00Z = 08:00 EDT Saturday. Next slot is Mon 07:00 EDT.
    const now = new Date('2026-05-16T12:00:00Z')
    const next = computeNextDigestFor('America/New_York', now)
    expect(next.at.toISOString()).toBe('2026-05-18T11:00:00.000Z')
    expect(next.whenLabel).toContain('Monday')
  })

  test("Pacific/Auckland — Sunday evening UTC is already Monday local → Monday 07:00 NZST (Sun 19:00Z)", () => {
    // 2026-05-17T22:00Z = Mon 2026-05-18T10:00 NZST.
    // Next 7am NZST is Tue (Mon 10:00 is past 7am so today is out → Tue 07:00 NZST = Mon 19:00Z).
    const now = new Date('2026-05-17T22:00:00Z')
    const next = computeNextDigestFor('Pacific/Auckland', now)
    expect(next.at.toISOString()).toBe('2026-05-18T19:00:00.000Z')
    expect(next.whenLabel).toContain('Tuesday')
  })

  test('invalid IANA string falls back to UTC', () => {
    const now = new Date('2026-05-13T06:00:00Z')
    const next = computeNextDigestFor('Not/A_Zone', now)
    expect(next.at.toISOString()).toBe('2026-05-13T07:00:00.000Z')
    expect(next.whenLabel).toContain('UTC')
  })

  test('null tz falls back to UTC', () => {
    const now = new Date('2026-05-13T06:00:00Z')
    const next = computeNextDigestFor(null, now)
    expect(next.whenLabel).toContain('UTC')
  })
})

describe('formatRelativeUntil', () => {
  const now = new Date('2026-05-16T12:00:00Z')

  test('target in the past → "any minute now"', () => {
    expect(formatRelativeUntil(new Date('2026-05-16T11:59:00Z'), now)).toBe('any minute now')
  })

  test('target right at now → "any minute now"', () => {
    expect(formatRelativeUntil(now, now)).toBe('any minute now')
  })

  test('30 minutes out → "in ~30m"', () => {
    expect(formatRelativeUntil(new Date(now.getTime() + 30 * 60_000), now)).toBe('in ~30m')
  })

  test('59 minutes out → minute-resolution label', () => {
    expect(formatRelativeUntil(new Date(now.getTime() + 59 * 60_000), now)).toBe('in ~59m')
  })

  test('60+ minutes out → hour-resolution label', () => {
    expect(formatRelativeUntil(new Date(now.getTime() + 90 * 60_000), now)).toBe('in ~2h')
  })

  test('25 hours out → day-resolution label', () => {
    expect(formatRelativeUntil(new Date(now.getTime() + 25 * 60 * 60_000), now)).toBe('in ~1d')
  })

  test('3 days out → "in ~3d"', () => {
    expect(formatRelativeUntil(new Date(now.getTime() + 3 * 24 * 60 * 60_000), now)).toBe(
      'in ~3d',
    )
  })
})
