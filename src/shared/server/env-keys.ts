// Single source of truth for the set of env var keys the app knows about
// and which subset is fail-fast required when NODE_ENV=production.
//
// Imported by:
//   src/lib/env.ts        — uses ENV_REQUIRED_IN_PROD to build the Zod
//                           superRefine; runs a startup assertion that
//                           ENV_KEYS exactly matches its Zod schema shape.
//   scripts/env-lint.ts   — cross-checks .env / .env.example / .env.production
//                           without importing env.ts (which would trigger
//                           dotenv loading + validation throws).
//
// This file is pure data — no side effects, no dotenv, safe to import from
// anywhere. Drift between this list and the Zod schema in env.ts is caught
// at startup by the assertion in env.ts.

export const ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "VITE_POSTHOG_KEY",
  "VITE_POSTHOG_HOST",
  "FIRECRAWL_API_KEY",
  "FEEDBACK_SIGNING_SECRET",
  "INVITE_TOKEN_SECRET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "INGEST_SCHEDULE_ENABLED",
  "SYNTHESIS_FEEDBACK_SIGNAL_ENABLED",
] as const;

export type EnvKey = (typeof ENV_KEYS)[number];

// MUST be set (non-empty) when NODE_ENV=production. Missing/empty values
// here cause env.ts to throw at module-load so the Railway container exits
// before serving traffic — deploy fails fast instead of 500-ing on first
// request that touches the missing var.
export const ENV_REQUIRED_IN_PROD = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "RESEND_API_KEY",
  "FIRECRAWL_API_KEY",
  "FEEDBACK_SIGNING_SECRET",
  "INVITE_TOKEN_SECRET",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const satisfies readonly EnvKey[];
