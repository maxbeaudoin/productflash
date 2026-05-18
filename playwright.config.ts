import { defineConfig } from "@playwright/test";

// Distinct port from `pnpm dev` (3000) so a developer running both at
// once doesn't get an EADDRINUSE collision. Override via env when needed.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? "3100");
const BASE_URL = `http://localhost:${PORT}`;

// E2E config. The Playwright suite is opt-in (`pnpm test:e2e`) — it pulls
// up a real Postgres + spawns `pnpm dev`, so it's slower than unit /
// integration. Single worker keeps the spawned dev server simple.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // 20s per test: every spec here is a single user action plus a DB
  // round-trip. A healthy run finishes in <3s. If we approach the wall
  // something is wrong — fail fast rather than waiting out a 60s budget.
  timeout: 20_000,
  // 5s per `expect()` assertion (web-first assertions, polling). Note:
  // this does NOT govern `locator.waitFor()` — that one uses Playwright's
  // own default (30s) unless callers pass an explicit `{ timeout }`. Our
  // specs pass `{ timeout: 5_000 }` at the call site; if you add a new
  // `waitFor()`, do the same.
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // 5s per action (clicks/fills/scrolls). Default is 0 (no cap), which
    // means a hung action only surfaces at the test-level wall — these
    // tests are all single-user interactions, so 5s is plenty for a real
    // wait and tight enough to fail fast on a broken selector.
    actionTimeout: 5_000,
    // 15s per `page.goto` — first nav to a route pays TanStack Start's
    // lazy-compile cost (~500ms-1s, occasionally more on cold cache);
    // subsequent navs are <500ms. 15s gives headroom for the cold case
    // while still failing fast on a genuinely broken server (default 30s).
    navigationTimeout: 15_000,
    // Same browser binary across CI + local — avoids "works on my machine"
    // failures rooted in a browser engine version mismatch.
    headless: true,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  // The dev server is spawned inside global-setup (not via Playwright's
  // built-in `webServer`) because that runs in parallel with globalSetup
  // and would race the test-only env vars we write before launching it.
});
