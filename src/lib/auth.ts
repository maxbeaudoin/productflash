import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
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
async function deliverMagicLink({ email, url }: { email: string; url: string }) {
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

export const auth = betterAuth({
  secret: requireEnv("BETTER_AUTH_SECRET"),
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(getDb(), {
    provider: "pg",
    usePlural: true,
    schema,
  }),
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
