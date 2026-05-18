import { Client } from "pg";
import { env, requireEnv } from "./env";

// Dedicated, non-pooled pg client for LISTEN/NOTIFY. Each SSE handler owns
// its own client and is responsible for `.end()` on close.
//
// PgBouncer transaction-pooling (Neon's `-pooler` endpoint) drops LISTENs
// between statements, so production must point DATABASE_URL_DIRECT at a
// non-pooler endpoint. In dev against a non-Neon Postgres, the pooled URL
// works fine — fall through to it.
export async function connectListener(): Promise<Client> {
  const url = env.DATABASE_URL_DIRECT ?? requireEnv("DATABASE_URL");
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
