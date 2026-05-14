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

  FIREHOSE_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  PRODUCT_HUNT_TOKEN: z.string().optional(),

  FEEDBACK_SIGNING_SECRET: z.string().min(32).optional(),

  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().optional(),
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
