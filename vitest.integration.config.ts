import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Integration suite — Postgres in Docker via testcontainers. Separated
// from the unit config so `pnpm test` stays sub-2s; `pnpm test:integration`
// is the opt-in slow path.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // Container boot is ~3s; one container is shared per test file via
    // beforeAll/afterAll. 60s per test is the safety margin for cold-start
    // image pulls on a fresh machine.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    // Sequential file execution avoids piling up multiple containers at
    // once on a developer laptop. Parallelism inside a file (it.concurrent)
    // is still allowed.
    fileParallelism: false,
    env: {
      TZ: "UTC",
      NODE_ENV: "test",
      // Test-only secrets so any imported lib that does `requireEnv` at
      // module-load time doesn't throw before the suite gets a chance to
      // run. Length must satisfy the zod `min(32)` in `src/lib/env.ts`.
      FEEDBACK_SIGNING_SECRET: "test-feedback-secret-xxxxxxxxxxxxxxxx",
      INVITE_TOKEN_SECRET: "test-invite-secret-xxxxxxxxxxxxxxxxxxxx",
      BETTER_AUTH_SECRET: "test-better-auth-secret-xxxxxxxxxxxxxxx",
    },
  },
});
