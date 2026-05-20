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
const ENV_LOCAL = resolve(ROOT, ".env");
const ENV_PROD = resolve(ROOT, ".env.production");
const hasLocal = existsSync(ENV_LOCAL);
const hasProd = existsSync(ENV_PROD);

// .env presence is the dev/deployed signal: developers always have a
// .env; the deployed image (Railway, Docker, etc.) ships without one.
//
// This file is also bundled by Vite for the production server, and Vite
// inlines every `process.env.NODE_ENV` reference at build time as a
// literal string. That dead-code-eliminates any runtime NODE_ENV check
// in this module — by the time the bundled code runs, it's frozen to
// whatever NODE_ENV was at build. Avoid touching process.env.NODE_ENV
// here at all; rely on file presence and let `override: true` make
// .env.production deterministic regardless of what stale or empty
// NODE_ENV state the runtime happens to start with.
// Reflect.get avoids Vite's static `process.env.NODE_ENV` replacement at
// build time — same trick as the diagnostic block below.
const preExistingNodeEnv = Reflect.get(process.env, "NODE_ENV");

if (preExistingNodeEnv === "test") {
  // Test runner (vitest) sets NODE_ENV=test in process.env before this
  // module loads and provides its own env stubs (vitest.config.ts +
  // vitest.integration.config.ts). Skip dotenv entirely so a committed
  // .env.production (which carries NODE_ENV=production) can't clobber
  // the test environment via override:true. Without this guard, CI
  // checkouts that include .env.production fail integration tests with
  // "X is required in production" because the override flips the env
  // back to prod-validation mode.
} else if (hasLocal) {
  // Local dev: .env is authoritative. Don't touch .env.production —
  // its NODE_ENV=production would silently flip dev into prod-validation
  // mode (.env.production loaded with override would clobber).
  loadDotenv({ path: ENV_LOCAL });
} else if (hasProd) {
  // Deployed image: no .env present. Load .env.production with
  // override:true so its values (notably NODE_ENV=production and
  // BETTER_AUTH_URL) win over any platform-set or platform-bequeathed
  // value in process.env. Safe because .env.production only contains
  // @public / @private values — @secret keys are forbidden by env-lint,
  // so override:true can't clobber a Railway-managed secret.
  loadDotenv({ path: ENV_PROD, override: true });
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

  FIRECRAWL_API_KEY: z.string().optional(),

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

  // Inject each user's recent 👎'd items into the synthesis prompt as
  // "avoid items in the same vein" examples. Off by default so we can A/B
  // by hand against a clean baseline before flipping on for the cohort.
  // Cold-start users (< 3 ratings) are skipped regardless of this flag.
  SYNTHESIS_FEEDBACK_SIGNAL_ENABLED: z
    .enum(["0", "1", "true", "false", ""])
    .optional()
    .transform((v) => v === "1" || v === "true"),

  // OTEL + OpenInference observability (PF-103). Off by default so a missing
  // exporter endpoint can't crash boot; flip to "1" once Langfuse Cloud
  // credentials are in Railway. When disabled, src/shared/server/otel.ts is
  // a no-op import.
  OTEL_ENABLED: z
    .enum(["0", "1", "true", "false", ""])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  // Service name attached to every span. Worker entry overrides this so
  // web and worker traces are easy to filter; env var is the default.
  OTEL_SERVICE_NAME: z.string().optional(),
  // OTLP/HTTP collector URL. For Langfuse Cloud this is
  // https://cloud.langfuse.com/api/public/otel
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  // Comma-separated key=value pairs (OTEL spec). Langfuse expects a single
  // `Authorization=Basic <base64(public_key:secret_key)>` header.
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
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
  // Iterate issues (not flatten().fieldErrors) so we can include the
  // RECEIVED value alongside the message — flatten drops it, leaving
  // operators with "Invalid option" and no clue what the actual value
  // was. Long values are truncated so a malformed secret doesn't dump
  // its full contents to deploy logs.
  // eslint-disable-next-line no-console
  console.error("[env] validation failed:");
  // Diagnostic context — invaluable when the failure is platform-shaped
  // (file missing from deployed image, surprising cwd, NODE_ENV
  // bequeathed by base image, etc.) rather than a code mistake.
  // Read via Reflect.get so Vite's static `process.env.NODE_ENV`
  // replacement can't inline it at build time — bracket access alone
  // also gets folded, but a dynamic property read defeats the analysis.
  const runtimeNodeEnv = Reflect.get(process.env, "NODE_ENV");
  // eslint-disable-next-line no-console
  console.error(
    `[env] context: cwd=${ROOT} hasLocal=${hasLocal} hasProd=${hasProd} ` +
      `NODE_ENV=${JSON.stringify(runtimeNodeEnv)}`,
  );
  for (const issue of parsed.error.issues) {
    const field = issue.path.join(".") || "<root>";
    let received = "";
    if ("input" in issue && issue.input !== undefined && issue.input !== null) {
      const raw = typeof issue.input === "string" ? issue.input : JSON.stringify(issue.input);
      const safe =
        raw.length > 64 ? `${raw.slice(0, 64)}… (${raw.length} chars)` : JSON.stringify(raw);
      received = ` (received: ${safe})`;
    }
    // eslint-disable-next-line no-console
    console.error(`  ${field}: ${issue.message}${received}`);
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
