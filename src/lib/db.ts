import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env, requireEnv } from "./env";

let _pool: Pool | undefined;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: requireEnv("DATABASE_URL"),
      max: env.NODE_ENV === "production" ? 10 : 4,
    });
  }
  return _pool;
}

export function getDb() {
  return drizzle(getPool());
}

export async function pingDb(): Promise<{ ok: true; latencyMs: number }> {
  const start = performance.now();
  const client = await getPool().connect();
  try {
    await client.query("select 1");
  } finally {
    client.release();
  }
  return { ok: true, latencyMs: Math.round(performance.now() - start) };
}
