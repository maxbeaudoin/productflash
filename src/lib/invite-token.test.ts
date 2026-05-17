import { afterEach, describe, expect, test, vi } from 'vitest'
import { signInviteToken, verifyInviteToken } from './invite-token'

const TTL_MS = 14 * 24 * 60 * 60 * 1000

afterEach(() => {
  vi.useRealTimers()
})

describe('invite-token', () => {
  const payload = { id: '11111111-1111-1111-1111-111111111111', email: 'beta@example.com' }

  test('round-trip preserves id + email', () => {
    const token = signInviteToken(payload)
    expect(verifyInviteToken(token)).toEqual(payload)
  })

  test('expired token (older than 14d) is rejected', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'))
    const token = signInviteToken(payload)

    // Advance just past TTL.
    vi.setSystemTime(new Date(Date.now() + TTL_MS + 1000))
    expect(verifyInviteToken(token)).toBeNull()
  })

  test('not-yet-expired token (just under 14d) is accepted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'))
    const token = signInviteToken(payload)

    vi.setSystemTime(new Date(Date.now() + TTL_MS - 60_000))
    expect(verifyInviteToken(token)).toEqual(payload)
  })

  test('tampered signature is rejected', () => {
    const token = signInviteToken(payload)
    const [encoded, sig] = token.split('.')
    const flipped = sig![0] === 'A' ? 'B' + sig!.slice(1) : 'A' + sig!.slice(1)
    expect(verifyInviteToken(`${encoded}.${flipped}`)).toBeNull()
  })

  test('tampered payload (email swap) is rejected', () => {
    const token = signInviteToken(payload)
    const evilPayload = JSON.stringify({ ...payload, email: 'attacker@evil.com', iat: Date.now() })
    const evilEncoded = Buffer.from(evilPayload, 'utf8').toString('base64url')
    const [, sig] = token.split('.')
    expect(verifyInviteToken(`${evilEncoded}.${sig}`)).toBeNull()
  })

  test('malformed token shapes are rejected without throwing', () => {
    expect(verifyInviteToken('')).toBeNull()
    expect(verifyInviteToken('no-dot')).toBeNull()
    expect(verifyInviteToken('a.b.c')).toBeNull()
    expect(verifyInviteToken('!!!.???')).toBeNull()
  })

  test('payload missing required field is rejected', () => {
    // Hand-craft a payload that's valid base64 + JSON but missing email.
    const partial = JSON.stringify({ id: payload.id, iat: Date.now() })
    const encoded = Buffer.from(partial, 'utf8').toString('base64url')
    // Forge a signature that matches the partial payload — uses the same
    // secret as the production code, so a tampered-but-resigned token still
    // can't smuggle missing fields past the shape check.
    const { createHmac } = require('node:crypto') as typeof import('node:crypto')
    const sig = createHmac('sha256', process.env.INVITE_TOKEN_SECRET!)
      .update(partial)
      .digest('base64url')
    expect(verifyInviteToken(`${encoded}.${sig}`)).toBeNull()
  })
})
