import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { Pool } from 'pg'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Integration-test harness. Each test file calls `startTestDb()` in
// `beforeAll` to spin up an isolated Postgres container, apply the
// production migrations, and return a Drizzle handle. `truncateAll()`
// between tests resets state without paying the container boot cost
// again (~3s per container).
//
// The harness is read by `vitest.integration.config.ts` only — the unit
// test runner never sees these files.

const MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
)

export interface TestDb {
  url: string
  pool: Pool
  db: NodePgDatabase
  container: StartedPostgreSqlContainer
  stop: () => Promise<void>
}

export async function startTestDb(): Promise<TestDb> {
  // Pin to the same major version Neon runs (16 at time of writing). A
  // version skew between local-test and prod is exactly the kind of
  // surprise that makes integration tests pass and prod break.
  const container = await new PostgreSqlContainer('postgres:16-alpine').start()

  const url = container.getConnectionUri()
  const pool = new Pool({ connectionString: url, max: 4 })
  const db = drizzle(pool)

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })

  return {
    url,
    pool,
    db,
    container,
    stop: async () => {
      await pool.end()
      await container.stop()
    },
  }
}

// Names match `src/db/schema.ts` exactly. Order is irrelevant when using
// `TRUNCATE ... CASCADE` since Postgres handles the FK dependency graph.
const ALL_TABLES = [
  'feedback',
  'llm_usage',
  'fte_events',
  'waitlist',
  'item_scores',
  'competitor_pricing_snapshots',
  'digest_items',
  'digests',
  'raw_items',
  'user_competitors',
  'competitors',
  'verifications',
  'accounts',
  'sessions',
  'users',
]

export async function truncateAll(pool: Pool): Promise<void> {
  // CASCADE handles FK chains; RESTART IDENTITY is harmless on uuid PKs but
  // keeps any future serial/identity columns clean.
  const quoted = ALL_TABLES.map((t) => `"${t}"`).join(', ')
  await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`)
}

// Convenience: callers that just want to verify connectivity (smoke test).
export async function ping(db: NodePgDatabase): Promise<number> {
  const result = await db.execute<{ one: number }>(sql`select 1 as one`)
  return Number(result.rows[0]?.one ?? 0)
}
