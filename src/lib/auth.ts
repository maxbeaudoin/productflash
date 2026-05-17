import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { eq } from "drizzle-orm";
import { Resend } from "resend";
import { env, requireEnv } from "./env";
import { getDb } from "./db";
import { logger } from "./logger";
import * as schema from "~/db/schema";

let _resend: Resend | undefined;

function getResend(): Resend {
  if (!_resend) _resend = new Resend(requireEnv("RESEND_API_KEY"));
  return _resend;
}

// Plain-text magic-link email. Intentionally bare — the polished daily
// digest template (#11) is a separate React Email component. Auth mails
// are transactional and short-lived; deliverability matters more than
// branding here.
//
// Private-beta guard: Better Auth's magic-link plugin calls sendMagicLink
// unconditionally at /sign-in/magic-link — `disableSignUp` only fires at
// verify time. Without this guard, any email posted to the endpoint
// would burn a Resend send + leak beta existence + open an email-bomb
// vector. We silently no-op for unknown emails (still returning success
// up the stack) so an attacker can't enumerate beta members via timing
// or error-shape differences.
async function deliverMagicLink({ email, url }: { email: string; url: string }) {
  const normalized = email.toLowerCase();
  const db = getDb();
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, normalized))
    .limit(1);
  if (!existing) {
    logger.warn({ email: normalized }, "magic-link suppressed (no users row — uninvited)");
    return;
  }

  if (env.NODE_ENV !== "production" && !env.RESEND_API_KEY) {
    logger.info({ email, url }, "magic-link (no Resend key — printed only)");
    return;
  }
  const { error } = await getResend().emails.send({
    from: env.RESEND_FROM,
    to: email,
    subject: "Sign in to Product Flash",
    text: [
      "Click the link below to sign in to Product Flash.",
      "",
      url,
      "",
      "The link expires in 5 minutes. If you did not request it, ignore this email.",
    ].join("\n"),
  });
  if (error) {
    logger.error({ email, err: error }, "magic-link send failed");
    throw new Error(`Resend send failed: ${error.message}`);
  }
}

// Google OAuth is opt-in via env — when the client ID/secret are unset
// (typical local dev), the social provider is simply not registered, so
// the /api/auth/sign-in/social route 404s instead of throwing at boot.
// In prod both vars are required-in-prod (env-keys.ts), so a deploy
// without them fails fast at env.ts validation.
const googleProvider =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          // Private beta: same rule as the magic-link plugin. A successful
          // Google OAuth callback for an email that has no `users` row is
          // rejected — the admin invite (#34) remains the only path to a
          // row. Returning users (row exists, no `accounts` link yet) ARE
          // allowed in; the row matching happens via accountLinking below.
          disableSignUp: true,
        },
      }
    : undefined;

export const auth = betterAuth({
  secret: requireEnv("BETTER_AUTH_SECRET"),
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(getDb(), {
    provider: "pg",
    usePlural: true,
    schema,
  }),
  // First-time Google sign-in for an invited user finds an existing
  // `users` row (pre-created by admin invite) with no matching `accounts`
  // row. Better Auth's default is to refuse the link — anti-hijacking
  // guard for unverified emails. Google verifies the email at the IdP, so
  // listing it as a trusted provider tells Better Auth the email match is
  // sufficient proof of ownership and the account auto-links.
  //
  // `requireLocalEmailVerified: false` is required because admin invite
  // creates the users row with `email_verified=false` (only magic-link
  // verification flips it to true). Without this, an invited user trying
  // Google SSO as their FIRST sign-in would be rejected with
  // "account not linked" even though Google has fully verified them at
  // the IdP. The admin invite is the trust anchor for the email's
  // legitimacy; the OAuth round-trip is the trust anchor for ownership.
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
      requireLocalEmailVerified: false,
    },
  },
  ...(googleProvider ? { socialProviders: googleProvider } : {}),
  // Postgres `.defaultRandom()` already supplies UUIDs — tell Better Auth
  // not to generate IDs itself, so inserts omit `id` and the DB default
  // fires.
  advanced: {
    database: {
      generateId: false,
    },
    // Railway sits behind their edge proxy — the runtime sees Railway's
    // internal address as remoteAddress, so the rate limiter must read the
    // forwarded client IP from the header instead, or it'll bucket every
    // request together and fall open.
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for"],
    },
  },
  // Better Auth's built-in rate limiter — auto-disabled in dev, on in prod.
  // Memory storage is fine at private-beta scale (counters reset on deploy,
  // which we do rarely). Upgrade to 'database' if rate-limit evasion across
  // deploys becomes a concern.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    storage: "memory",
    customRules: {
      // Magic-link sends a real email per call → email-bomb / Resend-quota
      // burn vector. 3 attempts per minute per IP is plenty for a real user
      // mistyping their address; an attacker can't refill a target's inbox.
      "/sign-in/magic-link": { window: 60, max: 3 },
      // Bound the blast radius of a stolen admin cookie on the mutating
      // admin-plugin endpoints (ban-user, set-role, impersonate, …).
      "/admin/*": { window: 60, max: 20 },
    },
  },
  // Magic-link is the only sign-in surface in v1. Email/password is
  // disabled (not in the plugin list).
  emailAndPassword: { enabled: false },
  plugins: [
    magicLink({
      // Private beta: no self-serve signup. Verifying a magic link for an
      // unknown email is rejected instead of auto-creating a user. The
      // only path to a `users` row is an admin clicking Invite on the
      // waitlist (#34), which pre-creates the row.
      disableSignUp: true,
      sendMagicLink: async ({ email, url }) => {
        await deliverMagicLink({ email, url });
      },
    }),
    admin(),
    tanstackStartCookies(),
  ],
});

export type Auth = typeof auth;
