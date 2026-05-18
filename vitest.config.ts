import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Separate from `vite.config.ts` so Vitest doesn't load the TanStack Start /
// Nitro plugin chain — those need a full app build and would slow `pnpm test`
// to a crawl. Unit tests should be sub-second.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    // Force a default tz so date-math tests don't differ between local
    // machine and CI. Individual tests can override via the IANA arg they
    // pass into the function under test.
    env: {
      TZ: "UTC",
      NODE_ENV: "test",
      // Test-only secrets so `requireEnv` in token modules doesn't throw on
      // import. Length must satisfy the zod `min(32)` in `src/shared/server/env.ts`.
      FEEDBACK_SIGNING_SECRET: "test-feedback-secret-xxxxxxxxxxxxxxxx",
      INVITE_TOKEN_SECRET: "test-invite-secret-xxxxxxxxxxxxxxxxxxxx",
    },
  },
});
