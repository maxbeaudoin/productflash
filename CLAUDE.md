# Product Flash

Daily AI-curated competitive-intelligence digest for SaaS product leaders. One pillar (competitor moves: launches, pricing changes, feature releases, positioning shifts); per-user personalization driven by an agentic onboarding (FTE) that builds the user's profile from a minimal signup form.

## Phase & goal

**PoC — demand validation, not feature completeness.** Prove that 5–10 beta users open the daily digest ≥3 days/week and react (👍/👎) on items they find load-bearing.

Go/no-go after 2 weeks of live sends: ≥60% open rate, ≥30% of items get any reaction, ≥3 users explicitly say "keep sending it", <5% missed-launch rate vs. user's own knowledge.

**Current focus**: agentic SaaS + dogfood loop — auth, profile schema, FTE agent, in-app digest views, fast-path TTV, admin app. Email + send + launch is the next phase.

## How to work (Karpathy's 4 rules)

These bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding
Don't assume. Don't hide confusion. Surface tradeoffs.

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first
Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask: "Would a senior engineer call this overcomplicated?" If yes, simplify.

### 3. Surgical changes
Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- Remove imports/vars/functions that **your** changes orphaned. Don't delete pre-existing dead code unless asked — mention it instead.

Test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution
Define success criteria. Loop until verified.

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step work, state a brief plan with per-step verification before starting.

## Tech stack

- **Runtime**: Node.js ≥22.12, TypeScript, pnpm 9
- **Framework**: TanStack Start (React 19, full-stack, server functions)
- **DB / ORM**: Neon Postgres + Drizzle ORM
- **Queue + cron**: pg-boss (Postgres-backed) in a long-running worker — NOT Railway cron, NOT Redis/BullMQ
- **Auth**: Better Auth (Drizzle adapter, magic-link via Resend, admin-role plugin); `disableSignUp: true` — private beta, admin invite only
- **LLM**: Anthropic SDK direct — `claude-haiku-4-5-20251001` (per-item classify/score, high fan-out) + `claude-sonnet-4-6` (digest synthesis, once per user per day)
- **Email**: Resend + React Email; inline-styled, ~600px, no JS
- **Frontend**: Tailwind v4 + shadcn/ui (Base UI primitives, not Radix) + TanStack Form + Zod + Lucide
- **Design tokens**: `src/design/tokens.ts` is the single source of truth; Tailwind `@theme` and React Email both consume it — web and email must look identical
- **Sources** (priority order): RSS, Product Hunt, Firehose (deferred no-op for PoC), Firecrawl. No custom crawlers — use existing APIs only.
- **Analytics / logging**: PostHog cloud + Pino → Railway logs
- **Hosting**: Railway (web service + worker service), Neon Postgres

**Pillar discipline**: competitor moves only. Market-signal and VoC pillars are explicitly deferred — push back if asked to add them without a scope conversation.

## Code structure

```
src/
  agents/fte/            FTE onboarding agent (Anthropic tool-use loop)
  components/            Shared UI (admin, app, forms, ui = shadcn)
  db/                    Drizzle schema + seed
  design/tokens.ts       Single source of truth for brand
  features/              Vertical slices: client | server | shared | ui
    auth/  competitors/  digest/  landing/  onboarding/
    profile/  waitlist/
  routes/                TanStack Start file-based routes
    admin/  api/  app/  debug/  r/  (+ index, login, signup, healthz)
  shared/                Cross-feature utils: client | iso | server
  sources/               Source adapters: rss, ph, firehose, firecrawl
  styles/app.css         Tailwind entry
  worker/index.ts        pg-boss worker entrypoint
scripts/                 One-off TS scripts (migrate, run-*, smoke probes)
tests/integration/       Vitest + testcontainers Postgres
tests/e2e/               Playwright e2e
drizzle/                 Generated migrations
docs/                    Vendor API knowledge base — read before touching adapters
```

Unit tests are colocated next to the code (`foo.ts` + `foo.test.ts`).

## Commands

```
# Dev loop
pnpm dev                 # TanStack Start dev server
pnpm worker              # pg-boss worker (watch mode)
pnpm typecheck           # tsr generate + tsgo --noEmit
pnpm lint                # oxlint
pnpm format              # oxfmt

# Tests
pnpm test                # Vitest unit (one-shot)
pnpm test:watch          # Vitest watch
pnpm test:integration    # Vitest integration (needs Docker)
pnpm test:e2e            # Playwright e2e (needs Docker + chromium)

# DB
pnpm db:push             # Drizzle schema push (dev branch on Neon)
pnpm db:generate         # Generate migration
pnpm db:migrate          # Apply migrations
pnpm db:studio           # Drizzle Studio
pnpm db:seed             # Seed dev data
pnpm env:lint            # Cross-check .env files vs schema

# Pipeline (manual runs)
pnpm ingest:run          # Pull from all sources
pnpm score:run           # Haiku classify + score
pnpm synthesize:run      # Sonnet digest synthesis
pnpm fte:run             # Run FTE agent manually
pnpm send:run            # Send digests
pnpm send:dispatch       # Per-TZ dispatch
pnpm email:preview       # React Email preview server
```

## External IDs

| System | Name | ID / URL |
| --- | --- | --- |
| GitHub | `maxbeaudoin/productflash` | https://github.com/maxbeaudoin/productflash |
| Linear team | `ProductFlash` (key `PF`) | `3f3a4fdb-a805-4032-b921-f1314e957e93` |
| Railway project | `spectacular-flow` | `bba786ce-140e-4ac3-abcb-4062aea6dfca` |
| Railway service: web | `web` | `dc96ae2c-9276-43b0-90ca-01b43063cb85` |
| Railway service: worker | `worker` | `4d99faba-a0c3-4820-811e-d96b909328fd` |
| Neon Postgres | dev + prod branches | via Railway env vars |
| Anthropic | API key | `ANTHROPIC_API_KEY` |
| Resend | Email API | `RESEND_API_KEY` |
| PostHog | analytics | `POSTHOG_*` |
| Firecrawl | scraping API | `FIRECRAWL_API_KEY` · docs.firecrawl.dev |
| Firehose | news API (deferred no-op) | `FIREHOSE_API_KEY` · firehose.com/api-docs |