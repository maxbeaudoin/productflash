---
name: test-coverage
description: >
  Perform a read-only audit of the codebase's test pyramid. Maps existing tests
  (unit, integration, e2e, smoke), identifies critical flows that lack coverage,
  and judges whether each layer is healthy, anemic, or top-heavy. Assumes
  Vitest for unit/integration and Playwright for e2e/smoke. Pragmatic by
  contract: does NOT chase 100% line coverage — flags missing tests for
  *critical logic and flows*, ignores trivial getters/setters and shape-only
  tests. Produces one ranked report with severity, the flow at risk, evidence
  (file:line), and a concrete test sketch. Use whenever the user asks for a
  "test audit", "test coverage review", "test pyramid health check", "what
  should we test", or similar. Never modifies files — read-only by contract.
allowed-tools: Bash(rg:*), Bash(grep:*), Bash(find:*), Bash(ls:*), Bash(wc:*), Bash(cat:*), Bash(sort:*), Bash(uniq:*), Bash(head:*), Bash(tail:*), Bash(awk:*), Bash(sed:*), Bash(jq:*), Bash(node:*), Bash(npm:*), Bash(pnpm:*), Bash(git:*), Read, Write
---

# Test Coverage Audit

A read-only audit of the testing pyramid. The skill is **methodology, not
magic**: walk the phases below, gather concrete `file:line` evidence of what
*is* and *is not* tested, then emit one ranked report.

## Operating contract

1. **Read-only.** Do not create or modify test files, fixtures, or config.
   The only file you may write is the final report (default:
   `TEST-AUDIT.md` in the repo root, or wherever the user asks). If the user
   said "take no action," do not write the report to disk — emit it inline.
2. **Evidence-first.** Every finding cites `path/to/file.ts:LINE` for the
   *production* code at risk and (when relevant) the existing test that does
   or doesn't cover it. No vague claims like "tests should be expanded."
3. **Pragmatic, not exhaustive.** The target is a healthy pyramid covering
   critical flows — NOT 100% line coverage. Skip trivial code (pure type
   helpers, single-line wrappers, shape-only DTOs). Focus on logic, branching,
   integrations, and user-visible flows.
4. **Test logic, not shape.** A "good test" exercises behavior under
   conditions that could plausibly fail. A test that asserts `expect(obj).
   toHaveProperty('id')` on a typed object is shape-only and should be
   flagged as low-value, not counted as coverage.

## The pyramid

Use this mental model when judging health. Each layer answers a different
question and has a different cost/speed/confidence tradeoff.

| Layer | Question it answers | Typical tool | Cost |
|-------|---------------------|--------------|------|
| **Unit** | Does this function's logic do the right thing across its branches? | Vitest (node env) | Fast, cheap |
| **Integration** | Do these modules + the DB/queue/HTTP boundary cooperate correctly? | Vitest + real DB/queue or testcontainers | Medium |
| **E2E** | Can a real user complete a critical flow end-to-end in a browser? | Playwright | Slow, expensive |
| **Smoke** | After deploy, is the system minimally alive? (health, auth, one happy path) | Playwright (subset) or curl | Fast, run post-deploy |

**Healthy pyramid:** many cheap unit tests at the base, fewer integration
tests in the middle, a small set of e2e flows for happy + key error paths,
a tiny set of smoke checks that run against production. Inverted pyramids
(e2e-heavy) are slow and flaky; missing-middle pyramids (unit + e2e only)
miss boundary bugs.

## Severity rubric for findings

| Severity | Definition |
|----------|-----------|
| **Critical** | A core revenue/data/security flow has no test of any kind. A regression would be invisible until a user reports it. |
| **High** | A complex piece of business logic (branching, money math, auth, data isolation) has only shape-only or happy-path coverage. Error paths and edge cases are untested. |
| **Medium** | An important flow is tested at the wrong layer (e.g., complex logic only verified through a slow flaky e2e) or has stale/brittle tests. |
| **Low** | Defense-in-depth gap: missing tests on non-critical helpers, or duplication that increases maintenance cost. |
| **Info** | Hygiene observation: configuration suggestions, naming conventions, no-runner-found, etc. |

A finding's severity reflects **the cost of a regression slipping through**,
not the size of the missing test. Bias toward the higher of likelihood and
impact when they disagree.

## Audit phases

Work these in order. Don't skip phases even if early ones look clean —
different gaps surface in different phases.

### Phase 1 — Recon

Build a map of what exists before judging what's missing.

```bash
# Repo shape & framework
find src -type d | head -60
cat package.json | jq '.scripts, .dependencies, .devDependencies'

# Test runners present?
cat package.json | jq '.scripts | to_entries | map(select(.value | test("vitest|playwright|jest|mocha"))) | .[]'

# Test config files
ls vitest.config* playwright.config* jest.config* 2>/dev/null

# All test files (broad net)
find . -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' -o -name '*.e2e.ts' \) -not -path '*/node_modules/*'

# Test directories
find . -type d \( -name '__tests__' -o -name 'tests' -o -name 'test' -o -name 'e2e' -o -name 'smoke' \) -not -path '*/node_modules/*'

# CI hooks for tests
cat .github/workflows/*.yml 2>/dev/null | rg -i 'test|vitest|playwright' -A2 -B1
```

Note: production framework, ORM, queue/worker, auth library, external
integrations (LLM, email, payment, scraping). These are the boundaries where
integration tests live.

### Phase 2 — Map production surfaces to "what should be tested"

You can't judge missing tests without knowing what flows matter. Build a
shortlist of **critical flows** by inspecting:

- **Routes / endpoints.** Each is a flow entry point.
  ```bash
  find src/routes src/app src/pages -type f 2>/dev/null
  rg -n 'createServerFn|defineHandler|export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)' src/
  ```
- **Jobs / workers.** Each scheduled or queued job is a critical flow.
  ```bash
  find src/jobs src/worker -type f 2>/dev/null
  rg -n 'boss\.send|boss\.work|cron|schedule' src/
  ```
- **Money/auth/data-isolation code paths.** Pricing, billing, auth, tenant
  filters — high-cost-of-regression by definition.
  ```bash
  rg -n 'price|amount|cents|charge|invoice|stripe' src/
  rg -n 'auth|session|userId|orgId|tenantId' src/ | head -40
  ```
- **External integrations.** LLM/email/scraping adapters — boundary code
  that benefits most from integration tests.
- **User-visible UI flows.** Sign-up, sign-in, onboarding, primary value
  surface, payment. These are e2e candidates.

For each critical flow, classify the **best layer to test it at** (don't
e2e a pure-function pricing calculator; don't unit-test a multi-step
sign-up).

### Phase 3 — Inventory existing tests

For every test file found in Phase 1:

- **What it asserts** — read 5–20 lines around each `test(`/`it(`/`describe(`
  block and classify:
  - Behavior test (asserts on observable outcome under varied inputs)
  - Shape test (asserts on type/structure only — usually low value)
  - Happy-path-only (no error/edge cases)
  - Snapshot only (often brittle, low signal)
- **Which layer** — unit (no IO, mocked deps), integration (real DB/queue/
  HTTP), e2e (browser-driven, Playwright), smoke (post-deploy minimal).
- **Health signals** — `.skip`, `.only`, TODO comments, `setTimeout` waits,
  flaky-test workarounds, excessive mocking.
  ```bash
  rg -n '\.skip\(|\.only\(|@skip|setTimeout|sleep\(' tests/ test/ e2e/ src/ 2>/dev/null | rg -i 'test|spec'
  ```

Produce a small table:

```
Layer        Count  Health
Unit         12     6 behavior, 4 shape, 2 skipped
Integration  2      both behavior, both touch real DB
E2E          1      happy-path signup only
Smoke        0      —
```

### Phase 4 — Layer-by-layer gap analysis

For each layer, judge **shape of the pyramid** and **specific gaps**.

#### Unit layer

- Are pure functions with branching covered? (money math, parsers,
  validators, scorers, classifiers, prompt builders.)
  ```bash
  # Pure-function candidates
  rg -nl 'export\s+(async\s+)?function\s+\w+\(' src/lib src/utils src/agents 2>/dev/null
  ```
- For each non-trivial function, is there a test file colocated or in
  `__tests__/`?
- **Flag:** branching logic with no test of either branch. **Don't flag:**
  one-line wrappers, type-only modules, re-exports.

#### Integration layer

- For each external boundary (DB, queue, LLM, email provider, HTTP source),
  is there at least one test that exercises it end-to-end *within* the
  process? (Not full e2e — just "this function actually inserts a row.")
- Common gaps: jobs that compose multiple modules (`src/jobs/*.ts`),
  source adapters (`src/sources/*.ts`), auth flows (token issue → consume).
- **Flag:** module compositions that only exist in production code paths.
  These are exactly where bugs hide that unit tests can't catch.

#### E2E layer

- For each top-of-funnel user flow (sign-up, sign-in, primary value action,
  payment), is there a Playwright spec?
- **Flag:** missing e2e for sign-up/sign-in or for the product's primary
  user-visible flow. **Don't over-flag:** every UI page does not need e2e.
- **Flag in reverse:** if e2e count >> integration count, the pyramid is
  inverted — slow, flaky CI ahead.

#### Smoke layer

- Are there post-deploy checks? (Health endpoint, auth round-trip, one
  read-only query.) If deploy is automated, smoke is non-optional.
- **Flag:** no smoke pack at all if deploys are automated.

### Phase 5 — Quality of existing tests

Tests can give false confidence. Read the code, not just the count.

- **Shape-only tests.** `expect(result).toHaveProperty('id')` on a typed
  return is type-system noise. Same with `expect(arr).toHaveLength(3)`
  without asserting *what's in* the array.
  ```bash
  rg -n 'toHaveProperty|toBeDefined|toBeTruthy\s*\(\s*\)' tests/ test/ src/ 2>/dev/null
  ```
- **Over-mocking.** A unit test that mocks every dependency proves the
  mocks return what they were told to. Look for tests where the
  assertion is downstream of `vi.mock(...)` returning a stub.
- **Snapshot abuse.** Large snapshots that no one reviews; snapshots over
  rendered HTML that change on every refactor.
  ```bash
  find . -name '*.snap' -not -path '*/node_modules/*'
  ```
- **Time-dependent flakiness.** `new Date()`, `Date.now()`, real timers
  without `vi.useFakeTimers()`.
- **Real network in unit tests.** `fetch(...)` not stubbed → slow, flaky.

### Phase 6 — CI integration

- Are tests wired into CI? Pre-merge or post-merge?
- Is e2e in a separate job so unit-test feedback stays fast?
- Is there a smoke job that runs against the deployed environment?
- Coverage report generated? (Optional — coverage is a *map*, not a goal.)

## Report format

Emit one markdown report. Structure:

```markdown
# Test Coverage Audit — <project> (<YYYY-MM-DD>)

## Executive summary
- Pyramid shape: <Healthy | Anemic | Missing-middle | Inverted | Empty>
- N findings: X Critical, Y High, Z Medium, W Low, V Info
- Top three coverage gaps (one line each)
- Overall verdict (1–2 sentences)

## Pyramid snapshot

| Layer | Count | Status | Notes |
|-------|-------|--------|-------|
| Unit | … | … | … |
| Integration | … | … | … |
| E2E | … | … | … |
| Smoke | … | … | … |

## Scope & methodology
- What was reviewed (paths, commit SHA)
- What was NOT reviewed (runtime behavior, prod telemetry)
- Tools/commands used

## Critical flows considered
- List of flows identified in Phase 2 with the layer chosen for each.

## Findings (ranked, Critical → Info)

### F-001 — <Short title> [Severity: High] [Layer: Integration]
**Flow at risk:** Daily digest synthesis (`src/jobs/synthesize.ts`)
**Current coverage:** None.
**Why it matters:** This job composes LLM call + DB write + Resend
dispatch. A regression in any step silently breaks the product's core
value delivery; no other test layer would catch it.

**Suggested test (sketch, not code to add now):**
- Integration test, real Postgres test DB, stub Anthropic + Resend with
  recorded fixtures.
- Cases: happy path produces N digest rows; LLM 429 → job retries;
  empty input set → job no-ops without sending email.

**Verification needed (if any):** N/A — coverage gap, not a runtime claim.

### F-002 — …
```

Order findings strictly by severity, then by likelihood of regression
(complexity × change frequency). Use stable IDs (`F-001`, `F-002`) so they
can be referenced in follow-up PRs.

If the pyramid is healthy in a particular layer, **say so explicitly** —
absence of findings in a section is itself useful signal.

## Anti-patterns to avoid in the report

- ❌ "Coverage is at 42%, target 80%." → ✅ "The synthesis job's retry
  branch (`src/jobs/synthesize.ts:88-104`) has no test; a regression here
  silently drops daily emails."
- ❌ Recommending tests for trivial getters or type re-exports.
- ❌ Recommending e2e tests for pure logic that belongs in a unit test.
- ❌ Recommending unit tests for a flow that genuinely needs the DB to
  prove anything — that's an integration test.
- ❌ Marking everything Critical to look thorough. Follow the rubric — a
  missing test on a one-line utility is not Critical.
- ❌ Treating shape-only assertions as coverage. They satisfy the type
  system; they don't prove behavior.
