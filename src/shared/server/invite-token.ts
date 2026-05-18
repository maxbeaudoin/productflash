import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env";

// Signed invite token attached to `/signup?invite=<token>` links the admin
// hands out from /admin/waitlist. The token carries the waitlist row id +
// email + issuedAt so the signup page can prefill (and lock) the email
// without a DB round-trip. The HMAC keeps third parties from forging or
// tampering with a link.
//
// Format: `<base64url(payload)>.<base64url(hmac)>` — payload is JSON
// `{ id, email, iat }`. Mirrors the pattern in `feedback-token.ts`; uses a
// distinct secret (`INVITE_TOKEN_SECRET`) so a leak of one doesn't grant
// the other capability.

type InvitePayload = {
  id: string;
  email: string;
};

type EncodedPayload = InvitePayload & { iat: number };

// Invite links auto-expire so a leaked URL (Slack archive, forwarded email,
// screenshot) can't be redeemed indefinitely. 14d matches the manual outreach
// cadence — admins re-issue if a beta user takes longer to redeem.
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function compute(serialized: string): string {
  const secret = requireEnv("INVITE_TOKEN_SECRET");
  return createHmac("sha256", secret).update(serialized).digest("base64url");
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string | null {
  try {
    return Buffer.from(input, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function signInviteToken({ id, email }: InvitePayload): string {
  const payload: EncodedPayload = { id, email, iat: Date.now() };
  const serialized = JSON.stringify(payload);
  const encoded = toBase64Url(serialized);
  const sig = compute(serialized);
  return `${encoded}.${sig}`;
}

export function verifyInviteToken(token: string): InvitePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, providedSig] = parts;
  if (!encoded || !providedSig) return null;

  const serialized = fromBase64Url(encoded);
  if (!serialized) return null;

  const expected = compute(serialized);
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { email?: unknown }).email !== "string" ||
    typeof (parsed as { iat?: unknown }).iat !== "number"
  ) {
    return null;
  }
  const { id, email, iat } = parsed as EncodedPayload;
  if (Date.now() - iat > INVITE_TTL_MS) return null;
  return { id, email };
}
