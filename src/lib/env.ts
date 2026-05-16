import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().url().optional(),

  // Direct (non-pooler) Neon endpoint, used only by the FTE SSE handler
  // (#29) which needs LISTEN/NOTIFY to survive — that's broken under
  // PgBouncer transaction pooling. Everything else (worker writes, web reads)
  // sticks with the pooled DATABASE_URL. If unset, falls back to
  // DATABASE_URL so dev against a non-Neon Postgres still works.
  DATABASE_URL_DIRECT: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('Product Flash <noreply@productflash.ai>'),

  // PostHog uses one "Project API Key" (called the project token in the
  // dashboard) for both server-side capture (posthog-node) and client-side
  // capture (posthog-js). The VITE_ prefix is the price of entry for Vite
  // to inline the value into the browser bundle; Node reads the same env
  // var server-side via process.env, so one variable serves both.
  VITE_POSTHOG_KEY: z.string().optional(),
  VITE_POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),

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
  // prod: the Railway-issued domain).
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),

  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),

  // Opt-in switch for the daily ingestion + score crons. Off by default so a
  // deploy never auto-fires real API calls — flip to "1" only when dogfooding
  // / real users are ready. Manual triggers (`pnpm ingest:run` or
  // `boss.send`) work regardless. Accepts the obvious on/off spellings so the
  // Railway UI can carry a visible toggle.
  INGEST_SCHEDULE_ENABLED: z
    .enum(['0', '1', 'true', 'false', ''])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors)
  throw new Error('Environment validation failed — see errors above')
}

export const env = parsed.data
export type Env = z.infer<typeof schema>

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key]
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required env var: ${key}`)
  }
  return value as NonNullable<Env[K]>
}
