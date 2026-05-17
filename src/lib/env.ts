import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ENV_KEYS, ENV_REQUIRED_IN_PROD } from "./env-keys";

// --- Env file loading -------------------------------------------------------
//
// Two-file model (kept in sync by `pnpm env:lint`):
//
//   .env             Local dev secrets + overrides. Gitignored.
//   .env.production  Committed *non-secret* production defaults. Loaded
//                    by both Vite (at build time, for VITE_* bundling)
//                    and by this module (at server runtime). Actual
//                    secrets are injected by Railway at deploy and
//                    ALWAYS win — dotenv refuses to override values
//                    already present in process.env, and Vite layers
//                    process.env on top of parsed files for the same
//                    effect during bundling.
//
// We load `.env` first so a developer's local file dominates, then
// conditionally `.env.production` to back-fill prod defaults.

const ROOT = process.cwd();

// Local overrides first. Doesn't override Railway-set vars in prod (since
// .env isn't shipped in the deployed image), and gives a developer's .env
// the chance to declare NODE_ENV before we decide whether to load .env.production.
const ENV_LOCAL = resolve(ROOT, ".env");
if (existsSync(ENV_LOCAL)) loadDotenv({ path: ENV_LOCAL });

// Committed production defaults — loaded ONLY when NODE_ENV is already
// "production" at this point. Either set by Railway before the process
// starts, or set explicitly by a developer who wants to dry-run prod
// locally. Avoids accidentally flipping local dev into strict-prod-validation
// mode just because .env.production is on disk.
const ENV_PROD = resolve(ROOT, ".env.production");
if (process.env.NODE_ENV === "production" && existsSync(ENV_PROD)) {
  loadDotenv({ path: ENV_PROD });
}

// --- Schema ----------------------------------------------------------------
//
// The set of known keys + the required-in-prod subset live in
// `./env-keys.ts` so `scripts/env-lint.ts` can read them without importing
// this file (which would trigger dotenv side effects and the startup
// validation throw).

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url().optional(),

  // Direct (non-pooler) Neon endpoint, used only by the FTE SSE handler
  // (#29) which needs LISTEN/NOTIFY to survive — that's broken under
  // PgBouncer transaction pooling. Everything else (worker writes, web reads)
  // sticks with the pooled DATABASE_URL. If unset, falls back to
  // DATABASE_URL so dev against a non-Neon Postgres still works.
  DATABASE_URL_DIRECT: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("Product Flash <noreply@productflash.ai>"),

  // PostHog uses one "Project API Key" (called the project token in the
  // dashboard) for both server-side capture (posthog-node) and client-side
  // capture (posthog-js). The VITE_ prefix is the price of entry for Vite
  // to inline the value into the browser bundle; Node reads the same env
  // var server-side via process.env, so one variable serves both.
  VITE_POSTHOG_KEY: z.string().optional(),
  VITE_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),

  // Firehose uses two keys: `fhm_...` management key (one-off tap creation
  // via scripts/firehose-bootstrap-tap.ts) and `fh_...` tap token (daily
  // rule sync + stream consumption). The token implicitly identifies the
  // tap — no separate tap_id is needed in subsequent calls.
  FIREHOSE_MANAGEMENT_KEY: z.string().optional(),
  FIREHOSE_TAP_TOKEN: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  PRODUCT_HUNT_TOKEN: z.string().optional(),

  FEEDBACK_SIGNING_SECRET: z.string().min(32).optional(),

  // HMAC secret for `/signup?invite=<token>` links issued by the admin
  // waitlist UI (#34). Distinct from FEEDBACK_SIGNING_SECRET so a leak of
  // one doesn't grant invite issuance.
  INVITE_TOKEN_SECRET: z.string().min(32).optional(),

  // Better Auth — secret signs sessions + magic-link tokens; URL is the
  // canonical base for callback links (dev: http://localhost:3000,
  // prod: the Railway-issued domain or productflash.ai).
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),

  // Google OAuth client (web app) for "Continue with Google" sign-in.
  // Required in prod alongside magic-link — beta is invite-only, so the
  // Google provider runs with `disableSignUp: true` and only signs in
  // emails that already have a `users` row from an admin invite (#34).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Opt-in switch for the daily ingestion + score crons. Off by default so a
  // deploy never auto-fires real API calls — flip to "1" only when dogfooding
  // / real users are ready. Manual triggers (`pnpm ingest:run` or
  // `boss.send`) work regardless. Accepts the obvious on/off spellings so the
  // Railway UI can carry a visible toggle.
  INGEST_SCHEDULE_ENABLED: z
    .enum(["0", "1", "true", "false", ""])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

// Drift guard — if a key is added/removed from the Zod schema above without
// updating env-keys.ts (which the linter relies on), boot fails loudly here
// instead of letting the linter silently miss the change.
{
  const shapeKeys = Object.keys(baseSchema.shape).sort();
  const declaredKeys: string[] = [...ENV_KEYS].sort();
  const onlyInShape = shapeKeys.filter((k) => !declaredKeys.includes(k));
  const onlyInDeclared = declaredKeys.filter((k) => !shapeKeys.includes(k));
  if (onlyInShape.length || onlyInDeclared.length) {
    throw new Error(
      `[env] schema/env-keys drift — update src/lib/env-keys.ts:` +
        (onlyInShape.length ? ` missing from ENV_KEYS: ${onlyInShape.join(", ")};` : "") +
        (onlyInDeclared.length ? ` missing from schema: ${onlyInDeclared.join(", ")};` : ""),
    );
  }
}

// `production` adds the fail-fast gate. In dev/test, missing values stay
// callable via `requireEnv()` (which throws lazily on first use).
const schema = baseSchema.superRefine((data, ctx) => {
  if (data.NODE_ENV !== "production") return;
  for (const key of ENV_REQUIRED_IN_PROD) {
    const value = data[key];
    if (value === undefined || value === null || value === "") {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} is required in production (currently missing/empty)`,
      });
    }
  }
  // localhost URLs would 404 every magic-link in prod — catch the
  // forgot-to-set-it case before Better Auth signs unusable callbacks.
  if (data.BETTER_AUTH_URL.includes("localhost")) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message: `BETTER_AUTH_URL must not point at localhost in production (got ${data.BETTER_AUTH_URL})`,
    });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Group by field so the operator sees one block per offending var instead
  // of a wall of Zod issue noise.
  const errors = parsed.error.flatten().fieldErrors;
  // eslint-disable-next-line no-console
  console.error("[env] validation failed:");
  for (const [field, messages] of Object.entries(errors)) {
    if (!messages?.length) continue;
    // eslint-disable-next-line no-console
    console.error(`  ${field}: ${messages.join("; ")}`);
  }
  throw new Error(
    "Environment validation failed — fix the vars above before starting. " +
      "Run `pnpm env:lint` to cross-check .env / .env.production / .env.example.",
  );
}

export const env = parsed.data;
export type Env = z.infer<typeof baseSchema>;

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value as NonNullable<Env[K]>;
}
