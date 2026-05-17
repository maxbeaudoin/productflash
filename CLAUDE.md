# Product Flash

Daily AI-curated competitive intelligence digest for SaaS product leaders. Currently in **PoC phase** — validating demand with 5–10 beta users over a 2–3 week build. No code yet at time of writing; planning artifacts only.

## Start here

- **`SCOPE.md`** — full PoC plan: goal, in/out of scope, sources, architecture, design system, daily pipeline, milestones, success criteria, risks. Source of truth for _what we're building_.
- **`TASKS.md`** — 22 work items with descriptions, dependencies, and statuses. Source of truth for _what's left to do_.
- **`docs/`** — vendor API knowledge base (PH, Firehose, Firecrawl, RSS). Read the relevant file BEFORE writing or modifying that source adapter — captures verified schema, rate limits, working/broken query patterns. Not auto-loaded; consult on demand.
- **`MEMORY.md`** index in `~/.claude/...` — pointers to locked decisions (scope, stack, ingestion principle).

## Workflow

- When picking up work: read `TASKS.md` first, find an unblocked task, do it.
- **Update task status in `TASKS.md`** as you progress (☐ → ⏳ → ✅). Commit status changes alongside the work.
- The in-session task list (`TaskCreate`/`TaskUpdate`) is a per-session scratchpad. `TASKS.md` is the durable source of truth — they will drift if you only update one.
- Default branch is `main`. Commit messages are concise; explain the _why_ when non-obvious.

## Stack (locked — see `SCOPE.md` §4 for rationale)

- TanStack Start + Drizzle + pg-boss + Neon Postgres, deployed on Railway (web service + long-running worker)
- Anthropic SDK direct: `claude-sonnet-4-6` (synthesis) + `claude-haiku-4-5-20251001` (classification fan-out)
- Resend + React Email
- Tailwind v4 + shadcn/ui (Base UI primitives) + TanStack Form + Zod + Lucide
- PostHog (analytics) + Pino (logging) → Railway logs

## Hard rules

- **Use existing APIs for ingestion** — Firehose, Firecrawl, RSS, Product Hunt. No custom crawlers. User has Firehose + Firecrawl procured.
- **pg-boss for all scheduling** — NOT Railway cron, NOT Redis/BullMQ. One long-running worker handles cron + retries + per-user fan-out queue.
- **Shared design tokens** — `src/design/tokens.ts` is the single source of truth for brand. Tailwind `@theme` consumes it; React Email components import it for inline styles. Web UI and email must look identical.
- **Don't broaden scope** — competitor-moves pillar only. Market signal + VoC pillars are explicitly deferred (`SCOPE.md` §2). Push back if asked to add them without a scope conversation.

## Common commands (once stack is bootstrapped)

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
