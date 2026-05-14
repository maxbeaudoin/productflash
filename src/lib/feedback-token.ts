import { createHmac, timingSafeEqual } from 'node:crypto'
import { requireEnv } from './env'

// Signed token attached to feedback links inside the daily email. The secret
// stays server-side, so a third party cannot forge a URL — they can only
// follow links we sent. We sign `${digestItemId}.${rating}` so each
// (item, rating) pair has its own token: flipping `up` to `down` on a copied
// URL invalidates the signature.

function compute(digestItemId: string, rating: 'up' | 'down'): string {
  const secret = requireEnv('FEEDBACK_SIGNING_SECRET')
  return createHmac('sha256', secret)
    .update(`${digestItemId}.${rating}`)
    .digest('base64url')
}

export function signFeedbackToken(
  digestItemId: string,
  rating: 'up' | 'down',
): string {
  return compute(digestItemId, rating)
}

export function verifyFeedbackToken(
  digestItemId: string,
  rating: 'up' | 'down',
  token: string,
): boolean {
  const expected = compute(digestItemId, rating)
  const a = Buffer.from(expected)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
