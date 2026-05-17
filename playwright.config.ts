import { defineConfig } from '@playwright/test'

// Distinct port from `pnpm dev` (3000) so a developer running both at
// once doesn't get an EADDRINUSE collision. Override via env when needed.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? '3100')
const BASE_URL = `http://localhost:${PORT}`

// E2E config. The Playwright suite is opt-in (`pnpm test:e2e`) — it pulls
// up a real Postgres + spawns `pnpm dev`, so it's slower than unit /
// integration. Single worker keeps the spawned dev server simple.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Same browser binary across CI + local — avoids "works on my machine"
    // failures rooted in a browser engine version mismatch.
    headless: true,
  },
  globalSetup: './tests/e2e/global-setup.ts',
  // The dev server is spawned inside global-setup (not via Playwright's
  // built-in `webServer`) because that runs in parallel with globalSetup
  // and would race the test-only env vars we write before launching it.
})
