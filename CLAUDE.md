# Product Flash

Daily AI-curated competitive intelligence digest for SaaS product leaders. Currently in **PoC phase** — validating demand with 5–10 beta users.

## Reference docs

- **`docs/`** — vendor API knowledge base (PH, Firehose, Firecrawl, RSS). Read the relevant file BEFORE writing or modifying that source adapter — captures verified schema, rate limits, working/broken query patterns. Not auto-loaded; consult on demand.
- **`SCOPE.md`** / **`TASKS.md`** — historical planning artifacts. Useful for context on _why_ a decision was made, but not load-bearing for day-to-day work. Don't treat them as a queue or a contract.
- **`MEMORY.md`** index in `~/.claude/...` — locked decisions (scope, stack, ingestion principle).

## Before you start a new task

1. Make sure you understand the requirements, ask multi-choice questions, and flag blockers.
2. Checkout a new branch from main and make sure your local main is up to date:

```
git checkout main
git status --porcelain
git pull --ff-only
git checkout -b feat|fix|chore|docs|refactor|test/<branch-name>
```

## Validate your own work

Using `mcp__chrome-devtools__`, and the `psql` and `curl` CLIs: 

1. Write tests for your code and make sure they pass.
2. Start the development server and test your changes in the browser.
3. Query the database to verify that your changes are reflected correctly.
4. Send requests to test your API endpoints if applicable.
5. Check the console for any errors or warnings and address them.
6. Write tmp ts scripts to validate more intricate changes if necessary.

* Only run relevant e2e tests locally (they can be slow); the full suite will run in CI.
* Always ask the user to validate the screenshots and provide feedback before moving to the PR stage.

## Definition of done

Using the `gh` CLIs:

1. Open a pull request and request a review from Github Copilot (`copilot-pull-request-reviewer[bot]`).
2. Address any comments from the review and make sure all checks have passed.
3. Merge the code into main.
4. Monitor the deployment to production and verify that it was successful.

**Checklist:**
- [ ] Code is complete and you validated your own work
- [ ] User has approved screenshots and feedback is incorporated (if applicable)
- [ ] PR is reviewed by Github Copilot, comments are resolved, all checks have passed
- [ ] Code is merged into main

* Use `Monitor` to watch for Copilot reviews and checks: 1m cadence, 5m timeout.

## Stack

- TanStack Start + Drizzle + pg-boss + Neon Postgres, deployed on Railway (web service + long-running worker)
- Anthropic SDK direct: `claude-sonnet-4-6` (synthesis) + `claude-haiku-4-5-20251001` (classification fan-out)
- Resend + React Email
- Tailwind v4 + shadcn/ui (Base UI primitives) + TanStack Form + Zod + Lucide
- PostHog (analytics) + Pino (logging) → Railway logs

## Hard rules

- **Use existing APIs for ingestion** — Firehose, Firecrawl, RSS, Product Hunt. No custom crawlers. User has Firehose + Firecrawl procured.
- **pg-boss for all scheduling** — NOT Railway cron, NOT Redis/BullMQ. One long-running worker handles cron + retries + per-user fan-out queue.
- **Shared design tokens** — `src/design/tokens.ts` is the single source of truth for brand. Tailwind `@theme` consumes it; React Email components import it for inline styles. Web UI and email must look identical.
- **Competitor-moves pillar only** — market signal + VoC pillars are explicitly deferred. Push back if asked to add them without a scope conversation.

## Common commands

```
pnpm dev              # TanStack Start dev server
pnpm db:push          # Drizzle schema push (dev branch on Neon)
pnpm db:migrate       # Generate + apply migration
pnpm worker           # Run the pg-boss worker locally
pnpm typecheck        # tsc --noEmit
pnpm env:lint         # cross-check .env / .env.example / .env.production vs schema
pnpm test             # Vitest unit suite (one-shot)
pnpm test:watch       # Vitest in watch mode
pnpm test:integration # Vitest integration suite (needs Docker; ~20s container boot first run)
pnpm test:e2e         # Playwright e2e (needs Docker; spawns pnpm dev against a fresh test container)
```

## Testing

- **Vitest for unit + integration**, **Playwright for e2e + smoke** (smoke not yet scaffolded).
- Unit tests live alongside the code: `src/foo/bar.ts` → `src/foo/bar.test.ts`. Run with `pnpm test`.
- Integration tests live under `tests/integration/`. They boot a real Postgres in Docker via testcontainers (`@testcontainers/postgresql`), apply Drizzle migrations, and stub only the external API surface (Anthropic, Resend). Run with `pnpm test:integration` — needs Docker.
- E2E tests live under `tests/e2e/`. Playwright spawns `pnpm dev` against a fresh testcontainer Postgres from `tests/e2e/global-setup.ts`, drives the browser through full user flows, then tears the stack down. Run with `pnpm test:e2e` — needs Docker + chromium (`pnpm exec playwright install chromium` after install). On Linux first run, also: `sudo pnpm exec playwright install-deps chromium`.
- Use the project-local `/test-coverage` skill to audit pyramid health on demand — it covers both missing-coverage gaps and existing-test defects (shape-only, tautological mocks, etc.).
- **Pragmatic, not exhaustive.** Aim for a healthy pyramid covering critical flows — branching logic, money math, auth/tenant filters, external boundaries — not 100% line coverage. Skip shape-only assertions; test behavior under conditions that could plausibly fail.
- `scripts/test-source-*.ts` / `scripts/smoke-schema.ts` are **manual probe scripts** (run via `tsx`), not assertion-based tests. They validate against real third-party APIs the unit/integration mocks can't reach — keep them, don't count them as coverage.
