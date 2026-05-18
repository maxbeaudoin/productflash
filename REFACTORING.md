# Refactoring: by-feature structure + client/server segregation

Working doc for the structural refactor. Principles: SOLID, KISS, YAGNI, POLA, DRY, low coupling, high cohesion, maximize colocation.

## Findings (evidence)

**Pain concentrated in 4 files (~3k LOC, 32% of `src/`):**

- `src/routes/app/onboarding.tsx` — **1485 LOC**. Server fns (`loadOnboarding`, `editProfile`, `addCompetitor`, `removeCompetitor`, `confirmProfile`) + `ThinkingStream` + 8 streaming sub-components + `ProfileCard` + `ProfileEditor` + `CompetitorsList` + `CompetitorRow` + `AddCompetitorForm` + helpers + inline form schemas. Five concerns in one file.
- `src/routes/app/profile.tsx` — **767 LOC**. Nearly identical `ProfileCard`/`ProfileEditor`/`DetailRow`/`FocusAreas`/`CompetitorsList`/`CompetitorRow`/`AddCompetitorForm` to onboarding. **Duplicated, not shared.** Server fns `editProfile`/`addCompetitor`/`removeCompetitor` also duplicated.
- `src/routes/signup.tsx` — 451 LOC.
- `src/routes/admin/waitlist.tsx` — 336 LOC.

**`src/lib/` is a kitchen sink (42 files).** Half-split by `-server`/`-client` suffix (auth, url, posthog), but the rest is mixed: server-only (`db.ts`, `env.ts`, `anthropic.ts`, `classify.ts`, `synthesize.ts`, `feedback-token.ts`) sits next to isomorphic (`digest-period.ts`, `llm-cost.ts`, `url.ts`, `utils.ts`, `validation/*`). A client import of the wrong file would silently pull server code into the bundle.

**Feature seams are blurred.** "Competitors" lives in `db/schema.ts` + `lib/validation/competitor.ts` + inline in two routes + `agents/fte/tools.ts`. Same for "profile", "digest", "waitlist". Code is organized by *kind* (route/component/lib/validation), not by *feature*.

**Components are already partly by-feature** (`components/{admin,app,auth,landing,forms}`). The missing split is *inside* the feature: card vs editor vs form vs list, and the server fns that drive them.

## Target shape

```
src/
  features/
    profile/
      server/           # server fns, repository, auth-guarded queries
      ui/               # ProfileCard, ProfileEditor, DetailRow, FocusAreas
      shared/           # ProfileView type, isomorphic helpers
      schema.ts         # zod
    competitors/
      server/           # addCompetitor / removeCompetitor / list
      ui/               # CompetitorsList, CompetitorRow, AddCompetitorForm
      shared/
    onboarding/
      server/           # confirmProfile + load fn that hydrates the page
      ui/               # ThinkingStream, ThoughtCard, ProgressChips, status
      shared/           # event projection, status humanizer
    digest/
      server/           # synthesize, classify, dispatch (today in lib/ + jobs/)
      ui/               # DigestItemCard, FeedbackButtons
      shared/           # digest-period, llm-cost
      email/            # DigestEmail.tsx + build-email-props.ts
    waitlist/
      server/
      ui/               # WaitlistForm + admin row/pill
      shared/
    auth/
      server/           # auth-server, magic link, invite-token
      client/           # auth-client
      ui/               # AuthShell, signup form, login form
      shared/           # invite-token shared bits
    fte/                # agent already lives here, mostly fine
  shared/
    client/             # posthog-client, browser-only utils
    server/             # db, env, logger, boss, anthropic, safe-fetch, notify
    iso/                # url, utils, llm-cost-format, digest-period
    ui/                 # ui/ (shadcn primitives) + forms/field-shell
  db/                   # schema + seed stay — cross-feature
  design/               # tokens stay
  routes/               # thin: load fn + composition only
  data/                 # landing content (could move under features/landing)
```

**Routes become thin shells.** `routes/app/onboarding.tsx` shrinks from 1485 → ~100 LOC (route definition, loader, JSX composition pulling from `features/onboarding/ui` + `features/profile/ui` + `features/competitors/ui`).

**Client/server segregation enforced by directory, not naming convention.** Anything under `features/*/server/` or `shared/server/` can import `~/shared/server/db`. Anything under `*/ui` or `*/client` cannot. ESLint `no-restricted-imports` fails the build on a violation — the discipline only holds if the linter holds it.

## Hard calls to lock before any moves

1. **`features/` vs flatter `domain/` layer.** Recommend `features/` — duplication pain is *intra-feature* (profile in 2 routes with the same components). A `domain/profile/` layer would dedupe server logic but not components.
2. **Server-fn placement.** Recommend moving the server fn definitions to `features/*/server/fns.ts` and importing into routes. Risk: TanStack Start's bundler boundary. Fallback: keep `createServerFn(...)` wiring inline, extract only the *handlers* to `features/*/server/handlers.ts`.
3. **Validation schemas.** Move `lib/validation/*` into `features/*/schema.ts`. Cross-feature imports (signup pulls profile + competitor schemas) are honest and few.
4. **`jobs/` and `worker/`.** Recommend absorbing into `features/digest/server/jobs/`. 8 of 10 jobs are digest-pipeline; `jobs/synthesize.ts` (536 LOC) and `lib/synthesize.ts` (339 LOC) being in separate trees is exactly the spread we're trying to fix. `worker/index.ts` stays top-level (boots the queue).
5. **Big-bang vs incremental.** Incremental, one feature per PR, typecheck-green at each step. Start with profile (kills ~400 LOC of dup), then competitors, then unload onboarding, then digest.
6. **Out of scope (YAGNI).** No DI container. No repository pattern abstraction. No event bus. No ports & adapters. SOLID/DRY justify extraction + dedup, not new layers.

## Plan — execution order

Each task = one PR. Typecheck + relevant tests must be green before merge.

### Task 1 — Lint guard for client/server boundary
Add `eslint-plugin-no-restricted-imports` rules:
- Files under `features/*/ui/**` or `*/client/**` may not import from `*/server/**` or `~/shared/server/**` or `~/lib/db` / `~/lib/env` / `~/lib/auth-server`.
- Set as error, not warn.

Done before any file moves — catches regressions in subsequent tasks.

### Task 2 — Dedupe Profile + Competitors UI (no folder moves yet)
Extract from `routes/app/onboarding.tsx` and `routes/app/profile.tsx`:
- `ProfileCard`, `ProfileEditor`, `DetailRow`, `FocusAreas`, `FocusAreasLabel`
- `CompetitorsList`, `CompetitorRow`, `AddCompetitorForm`

Target location (provisional): `components/app/profile/` and `components/app/competitors/`. We'll relocate in Task 4. The point of doing this first is the dedup ROI — one PR removes ~400 LOC of duplicated component code without any folder restructuring risk.

Server fns (`editProfile`, `addCompetitor`, `removeCompetitor`) also duplicated — extract to a shared module same PR. Provisional: `lib/server/profile-fns.ts`, `lib/server/competitor-fns.ts`.

### Task 3 — Split `src/lib/` into `src/shared/{client,server,iso}/`
Mechanical move pass. No logic changes.

- `shared/server/`: `db.ts`, `env.ts`, `env-keys.ts`, `auth.ts`, `auth-server.ts`, `boss.ts`, `logger.ts`, `anthropic.ts`, `classify.ts`, `synthesize.ts`, `safe-fetch.ts`, `notify.ts`, `feedback-token.ts`, `feedback-rating.ts`, `invite-token.ts`, `url-server.ts`, `posthog.ts`, `next-digest.ts`
- `shared/client/`: `auth-client.ts`, `posthog-client.ts`
- `shared/iso/`: `digest-period.ts`, `llm-cost.ts`, `llm-cost-format.ts`, `url.ts`, `utils.ts`
- `shared/iso/validation/`: existing `validation/*` (until Task 5 moves them into features)

Update all imports via codemod (`tsc --noEmit` is the smoke test). The lint guard from Task 1 enforces the boundary going forward.

### Task 4 — Stand up `features/profile/` and `features/competitors/`
Move the deduped artifacts from Task 2 into:
- `features/profile/{server,ui,shared}/`
- `features/competitors/{server,ui,shared}/`
- `features/profile/schema.ts` ← from `shared/iso/validation/profile.ts`
- `features/competitors/schema.ts` ← from `shared/iso/validation/competitor.ts`

Routes update their imports. No behavior change.

### Task 5 — Unload `onboarding.tsx`
Extract from `routes/app/onboarding.tsx` (1485 → ~120 LOC):
- `ThinkingStream` + `ThoughtCard` + `DurableThought` + `LiveThought` + `PendingThought` + `ThoughtBody` + `PlainStreamingBody` + `Caret` + `BottomStatusLine` → `features/onboarding/ui/thinking-stream/`
- `ProgressChips` + `Stats` → `features/onboarding/ui/progress-chips.tsx`
- `findSaveProfileTs`, `buildStats`, `formatElapsed`, `computeLiveStatus`, `humanizeToolUse`, `prettyHost`, `splitParagraphs`, `renderInline` → `features/onboarding/shared/`
- Server fns (`loadOnboarding`, `confirmProfile`) → `features/onboarding/server/fns.ts`

### Task 6 — Move digest pipeline into `features/digest/`
- `lib/synthesize.ts` + `lib/classify.ts` → `features/digest/server/`
- `jobs/{ingest,score,synthesize,send,send-dispatch,fast-path}.ts` → `features/digest/server/jobs/`
- `jobs/ingest.test.ts`, `jobs/score.test.ts`, `jobs/send-dispatch.test.ts`, `jobs/synthesize.test.ts` move with their code
- `emails/{DigestEmail.tsx,build-email-props.ts}` → `features/digest/email/`
- `components/app/DigestItemCard.tsx` + `components/app/FeedbackButtons.tsx` → `features/digest/ui/`
- `lib/digest-period.ts` + `lib/llm-cost*.ts` → `features/digest/shared/` (or keep in `shared/iso/` if cross-cutting; decide at PR time)
- `worker/index.ts` stays top-level (boot only).

### Task 7 — Waitlist + Auth + cleanup
- `features/waitlist/`: `routes/api/waitlist.ts` handler → `features/waitlist/server/`, `components/landing/WaitlistForm.tsx` → `features/waitlist/ui/`, admin row/pill from `routes/admin/waitlist.tsx` → `features/waitlist/ui/admin/`. Schema from `shared/iso/validation/waitlist.ts` → `features/waitlist/schema.ts`.
- `features/auth/`: existing `lib/auth*.ts` (already moved to `shared/server/` in Task 3) — pull into `features/auth/server/`. `components/auth/AuthShell.tsx` → `features/auth/ui/`. Signup/login route bodies thin out.
- `components/landing/*` → `features/landing/ui/` (and `data/landing.ts` → `features/landing/content.ts`). Optional, low ROI — flag for skip if time-boxed.

## Acceptance per task

- `pnpm typecheck` clean
- `pnpm test` clean
- Lint guard (Task 1) green
- For UI-touching tasks: dev server boots, the affected route loads in browser, golden path verified manually (per CLAUDE.md validation checklist)
- PR reviewed by Copilot, comments resolved, merged, prod deploy verified

## Risk log

- **TanStack Start bundler boundary** — `createServerFn` location is the unknown. Task 4 PR is where we find out. If extracting the `createServerFn(...)` call into a non-route module breaks the build, fall back to inline `createServerFn` wiring with extracted handlers.
- **Server-fn duplication may be intentional in places** — e.g. `editProfile` in onboarding sets `confirmed_at` paths; `editProfile` in profile may not. Diff the two before deduping in Task 2.
- **Test relocations** — colocated tests must move with their code. `pnpm test` is the safety net.
- **Import churn** — Task 3 touches every file in the repo. Land it on a quiet day, no parallel feature work in flight.
