import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('Product Flash <noreply@productflash.dev>'),

  POSTHOG_API_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().default('https://us.i.posthog.com'),

  // Firehose uses two keys: `fhm_...` management key (one-off tap creation
  // via scripts/firehose-bootstrap-tap.ts) and `fh_...` tap token (daily
  // rule sync + stream consumption). The token implicitly identifies the
  // tap — no separate tap_id is needed in subsequent calls.
  FIREHOSE_MANAGEMENT_KEY: z.string().optional(),
  FIREHOSE_TAP_TOKEN: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  PRODUCT_HUNT_TOKEN: z.string().optional(),

  FEEDBACK_SIGNING_SECRET: z.string().min(32).optional(),

  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),

  // Opt-in switch for the daily ingestion cron. Off by default so a deploy
  // never auto-fires real API calls — flip to "1" only when dogfooding /
  // real users are ready. Manual triggers (`pnpm ingest:run` or
  // `boss.send`) work regardless.
  INGEST_SCHEDULE_ENABLED: z
    .union([z.literal('1'), z.literal('true')])
    .optional(),
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
