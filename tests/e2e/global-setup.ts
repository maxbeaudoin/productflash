import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

// Boots the full stack for the Playwright suite:
//   1. Postgres container (testcontainers).
//   2. Drizzle migrations applied so the dev server sees a populated schema.
//   3. process.env populated with the container URL + test-only secrets.
//   4. `pnpm dev` spawned as a child process so it inherits the env we
//      just wrote (Playwright's built-in `webServer` config launches in
//      parallel with globalSetup, which is too late — we'd race the env
//      writes vs the dev server's env.ts module-load).
//   5. Wait for /healthz to respond before letting tests start.
//
// The returned function is Playwright's teardown — kills the dev server
// process group and stops the container.

const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? "3100");

// Poll cadence for /healthz. 200ms is short enough that the wait wakes
// almost immediately after the dev server reports ready, but long enough
// not to thrash the event loop.
const HEALTHZ_POLL_MS = 200;

async function waitForHealthz(timeoutMs: number, readySignal: Promise<void>): Promise<void> {
  // Race two observations: the dev server's "ready" stdout line, and the
  // /healthz endpoint. Whichever fires first short-circuits the wait —
  // /healthz is the authoritative readiness check, but the stdout signal
  // typically beats it by ~200ms and gives us a clean ready log either way.
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  let sawReady = false;
  void readySignal.then(() => {
    sawReady = true;
  });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = err;
    }
    // After we've seen the stdout ready line, poll harder — the server
    // is up and /healthz is just about to flip green.
    await new Promise((r) => setTimeout(r, sawReady ? 50 : HEALTHZ_POLL_MS));
  }
  throw new Error(
    `e2e: dev server did not respond to /healthz within ${timeoutMs}ms (last: ${String(lastErr)})`,
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // eslint-disable-next-line no-console
  console.log("[e2e] booting Postgres container…");
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();
  const url = container.getConnectionUri();

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e] Postgres ready at ${url}`);

  const devEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url,
    DATABASE_URL_DIRECT: url,
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    // Overwrite any values the developer's .env happens to have set —
    // a token signed with the test secret in this process MUST verify
    // against the same secret in the dev server.
    INVITE_TOKEN_SECRET: "test-invite-secret-xxxxxxxxxxxxxxxxxxxx",
    FEEDBACK_SIGNING_SECRET: "test-feedback-secret-xxxxxxxxxxxxxxxx",
    BETTER_AUTH_SECRET: "test-better-auth-secret-xxxxxxxxxxxxxxx",
    BETTER_AUTH_URL: `http://localhost:${PORT}`,
    INGEST_SCHEDULE_ENABLED: "0",
  };

  // Propagate so the test specs themselves see the same secrets when
  // they import ~/lib/invite-token to sign tokens.
  for (const [k, v] of Object.entries(devEnv)) {
    if (v !== undefined) process.env[k] = v;
  }

  // eslint-disable-next-line no-console
  console.log(`[e2e] spawning pnpm dev on port ${PORT}…`);
  const devServer: ChildProcessByStdio<Writable | null, Readable, Readable> = spawn(
    "pnpm",
    ["dev", "--port", String(PORT)],
    {
      env: devEnv,
      detached: true, // own process group so SIGTERM reaches vite + nitro children
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  // Surface server errors during the wait — silent crashes here are the
  // hardest e2e bugs to diagnose.
  devServer.stderr?.on("data", (buf) => process.stderr.write(`[dev] ${buf}`));
  devServer.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      // eslint-disable-next-line no-console
      console.error(`[e2e] dev server exited unexpectedly (code=${code} signal=${signal})`);
    }
  });

  // Sniff stdout for Vite's ready line (e.g. "Local: http://localhost…"
  // or "ready in NNNms"). Resolving this promise lets waitForHealthz drop
  // to a 50ms poll cadence — saves ~150ms on the typical boot and gives
  // us a deterministic readiness observation instead of a coarse 1s loop.
  const readySignal = new Promise<void>((resolve) => {
    const onData = (buf: Buffer) => {
      const line = buf.toString();
      process.stdout.write(`[dev] ${line}`);
      if (/ready in|Local:\s+http/i.test(line)) {
        devServer.stdout?.off("data", onData);
        resolve();
      }
    };
    devServer.stdout?.on("data", onData);
  });

  try {
    // 90s is generous for a cold boot (typical: 6-10s on this machine).
    // The old 180s was a paranoid upper bound from before stdout sniffing —
    // if we're past 90s the dev server isn't coming up, fail fast.
    await waitForHealthz(90_000, readySignal);
  } catch (err) {
    devServer.kill("SIGKILL");
    await container.stop();
    throw err;
  }
  // eslint-disable-next-line no-console
  console.log("[e2e] dev server is ready");

  return async () => {
    // eslint-disable-next-line no-console
    console.log("[e2e] tearing down dev server + Postgres…");
    if (devServer.pid && !devServer.killed) {
      try {
        // Negative pid → signal the whole process group, killing vite + nitro.
        process.kill(-devServer.pid, "SIGTERM");
      } catch {
        // already gone
      }
      // Give it 2s, then force kill if still alive.
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if (devServer.pid) process.kill(-devServer.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await container.stop();
  };
}
