# Test Coverage Audit — Product Flash (2026-05-16)

## Executive summary

- **Pyramid shape: Empty.** No test runner is installed, no test files exist,
  no CI runs tests. The repo has 94 production `.ts`/`.tsx` files in `src/`
  and zero `*.test.*` / `*.spec.*` / `*.e2e.*` files.
- 12 findings: 4 Critical, 4 High, 3 Medium, 2 Low, 2 Info.
- **Top three coverage gaps:**
  1. Signed-token verification (`feedback-token`, `invite-token`) — auth-grade
     HMAC + TTL code with no unit tests; a regression silently allows
     forged links into the product.
  2. SSRF defense in `safe-fetch.ts` — the only thing standing between an
     authenticated beta user and a Railway-internal HTTP probe, with no
     coverage of the private-address / redirect-revalidation branches.
  3. The daily digest pipeline (ingest → score → synthesize → send) has no
     automated test of any layer; a regression in any step silently breaks
     the product's core value delivery.
- **Verdict:** At PoC stage with 5–10 beta users this is survivable but
  brittle. Before letting the beta cohort grow, scaffold Vitest + Playwright
  and seed the four Critical findings as the v1 test set; do **not** chase
  full-line coverage. Three small unit suites + one integration test + one
  e2e flow would already eliminate the worst regression risks.

## Pyramid snapshot

| Layer        | Count | Status   | Notes                                                                                  |
|--------------|-------|----------|----------------------------------------------------------------------------------------|
| Unit         | 0     | Empty    | No Vitest installed. Pure-logic helpers (tokens, date math, money math) all untested.  |
| Integration  | 0     | Empty    | No test DB harness. Jobs (`src/jobs/*.ts`) only exercised by manual `tsx scripts/...`. |
| E2E          | 0     | Empty    | No Playwright. Sign-up-with-invite flow has no automated check.                        |
| Smoke        | 0     | Empty    | `GET /healthz` route exists (`src/routes/healthz.ts`) but nothing pings it post-deploy.|

The `scripts/test-source-*.ts` and `scripts/smoke-schema.ts` files are
**manual probe scripts** (per the codebase convention in
`MEMORY.md`/`feedback_end_to_end_validation.md`), not assertion-based tests:
they print output to stdout and exit, so they catch nothing in CI and
nothing on merge. Keep them — they validate against real third-party APIs
that a mocked test can't — but do not count them as coverage.

## Scope & methodology

- **Reviewed:** all of `src/` (94 files, ~13k LoC of production code),
  `scripts/`, `package.json`, `.github/workflows/*` (none present),
  `vitest.config*` / `playwright.config*` (none present).
- **Commit reviewed:** `f1f3ae1`.
- **Not reviewed:** runtime behavior in Railway, Postgres production schema,
  manual QA history, the contents of probe-script stdout from past runs.
- **Tools used:** `rg`, `find`, `jq`, `wc`, `git`, `cat`/`head` for inspection.

## Critical flows considered

| Flow                                                    | Best layer        | Currently tested? |
|---------------------------------------------------------|-------------------|-------------------|
| Sign in via magic link (Better Auth)                    | E2E + integration | No                |
| Sign up via admin invite (`/signup?invite=…`)           | E2E + unit        | No                |
| Waitlist intake (`POST /api/waitlist`)                  | Integration       | No                |
| FTE onboarding agent SSE stream                         | Integration       | No                |
| Ingestion job (`src/jobs/ingest.ts`)                    | Integration       | Manual probe only |
| Source adapters: RSS / PH / Firecrawl                   | Integration       | Manual probe only |
| Scoring job (Haiku fan-out, `src/jobs/score.ts`)        | Integration + unit| No                |
| Synthesis job (Sonnet, `src/jobs/synthesize.ts`)        | Integration + unit| Manual probe only |
| Send dispatch scheduling (per-user TZ window)           | Unit              | No                |
| Send (Resend dispatch, tracking pixel, links)           | Integration       | No                |
| Feedback rating link (`/r/:id/:rating?t=…`)             | Unit + integration| No                |
| Email open tracking (`/api/email/open/:digestId`)       | Integration       | No                |
| Tenant isolation in every job and query                 | Integration       | No                |
| LLM cost accounting (`src/lib/llm-cost.ts`)             | Unit              | No                |
| Digest period derivation (daily vs catch-up)            | Unit              | No                |
| Next-digest cadence math (`src/lib/next-digest.ts`)     | Unit              | No                |
| SSRF defense (`src/lib/safe-fetch.ts`)                  | Unit              | No                |
| Health endpoint (`GET /healthz`)                        | Smoke             | No                |

## Findings (ranked, Critical → Info)

### F-001 — Signed token sign/verify has no unit tests [Severity: Critical] [Layer: Unit]

**Flow at risk:** Feedback link signature (`src/lib/feedback-token.ts`,
34 LoC) and admin-invite signup signature (`src/lib/invite-token.ts`, 85
LoC). The first stops a third party from forging up/down votes on someone
else's digest item; the second is the **only** auth gate on
`/signup?invite=…` for the private beta.

**Current coverage:** None.

**Why it matters:** This is the smallest, purest, highest-value test
target in the repo. A regression here is invisible to type checks and to
manual QA — the function still returns a boolean, just the wrong one. The
TTL check in `verifyInviteToken` (`src/lib/invite-token.ts:71-72`,
`Date.now() - iat > INVITE_TTL_MS`) is especially easy to break in a
refactor that swaps the comparison direction or unit. A broken `<` here
would either lock everyone out or let expired invites in indefinitely.

**Suggested tests (sketches, not code to add now):**
- Vitest unit suite, no IO. Cases:
  - `signFeedbackToken` then `verifyFeedbackToken` returns true for the
    same `(id, rating)` pair.
  - Verify returns false when `rating` is flipped on the same id.
  - Verify returns false when the token bytes are tampered (single-byte
    flip in middle).
  - Verify returns false when token length differs (no panic, no leak).
  - `signInviteToken` / `verifyInviteToken` round-trip preserves
    `{id, email}` and rejects expired (`iat` 15 days in past).
  - Reject malformed token (missing `.`, non-base64 payload, JSON that
    parses but is missing fields).

### F-002 — SSRF defenses in `safe-fetch.ts` are untested [Severity: Critical] [Layer: Unit]

**Flow at risk:** `safeFetch` (`src/lib/safe-fetch.ts:48-`) wraps every
server-side fetch of user-influenced URLs (RSS autodetect on
`/app/profile`, agent tool calls). Without it, an authenticated beta user
can submit `http://10.0.0.1/…` or `http://169.254.169.254/…` and turn the
app into an internal-network HTTP probe inside Railway.

**Current coverage:** None. The branching here is rich — scheme
allow-list, DNS lookup, private-range checks, redirect-target
re-validation — and exactly the kind of code that quietly degrades during
refactors. The header comment already names two real attack URLs.

**Why it matters:** A regression here doesn't fail a build, doesn't show
up in QA, and is only detectable from prod logs after the fact. This is
one of two paths to a security incident in the current codebase (the
other is F-001).

**Suggested tests (sketches):**
- Vitest unit suite. Stub `dns.lookup` (no real DNS in unit layer).
- Cases:
  - Reject `file://`, `gopher://`, `ftp://` with `bad_scheme`.
  - Reject `http://10.0.0.1/`, `http://127.0.0.1/`, `http://169.254.169.254/`,
    `http://[::1]/`, `http://[fc00::1]/` with `private_address`.
  - Allow a public IP (e.g. 8.8.8.8 via stubbed lookup) — fetch goes through.
  - Redirect to a private address at hop 2 → reject with `private_address`,
    not allowed through.
  - Hop counter: 4 redirects → `too_many_redirects`.
  - `allowPrivate: true` honored only when `env.NODE_ENV !== 'production'`.

### F-003 — Daily digest pipeline has no integration coverage [Severity: Critical] [Layer: Integration]

**Flow at risk:** The four-job chain that delivers the product —
`src/jobs/ingest.ts` (258 LoC) → `src/jobs/score.ts` (284) →
`src/jobs/synthesize.ts` (531) → `src/jobs/send.ts` (212) → dispatched by
`src/jobs/send-dispatch.ts` (216). Each job composes 5–10 modules
(adapters, DB, Anthropic SDK, Resend, pg-boss). 1,500+ LoC of production
code with zero automated test of any layer.

**Current coverage:** None. The manual probe scripts
(`scripts/run-ingest.ts`, `run-score.ts`, etc.) exercise the happy path
against real APIs but assert nothing — they're for ad-hoc validation, not
regression protection.

**Why it matters:** This is the product. A regression in `synthesize.ts`
that silently drops half the digest items, or in `send.ts` that sends to
the wrong recipient, would only be caught by a beta user noticing. The
synthesizer's diversity selection
(`selectDiverseCandidates`, `src/jobs/synthesize.ts:469`), retry
behavior, and `upsertDigest` (line 417) are particularly load-bearing
and not trivially correct.

**Suggested tests (sketches):**
- Vitest integration suite against a real Postgres test DB (Neon dev
  branch or a Docker container), with Anthropic + Resend stubbed via
  recorded fixtures (`anthropic.messages.create` returns canned JSON,
  `resend.emails.send` returns a fake id and captures the args).
- Cases per job:
  - `ingest`: given 3 competitors with RSS URLs, writes N rows to
    `raw_items` and is idempotent on second run (dedupe via `source_id`).
  - `score`: given M `raw_items`, produces M classifications and records
    cost in `llm_usage`. Stubbed Haiku 429 → job retries, doesn't crash.
  - `synthesize`: produces a `digests` row + K `digest_items` rows; empty
    input → no digest row, no error.
  - `send`: marks digest sent only on Resend success; on Resend 5xx,
    digest stays unsent.

### F-004 — Sign-up-with-invite + sign-in have no e2e coverage [Severity: Critical] [Layer: E2E]

**Flow at risk:** `/signup?invite=…` (`src/routes/signup.tsx`) and
`/login` (`src/routes/login.tsx`). The product is a private beta, so
`disableSignUp: true` is set (per `MEMORY.md` /
`feedback_private_beta_no_signup.md`) and the **only** way into a `users`
row is the admin-invite path. If invite verification regresses, no new
beta user can join until a developer notices.

**Current coverage:** None.

**Why it matters:** This is the single point of failure for beta growth.
Unit tests on the token (F-001) cover the cryptography; only an e2e
covers that the token actually reaches Better Auth's session-creation
side and ends with an authenticated session cookie.

**Suggested tests (sketch):**
- Playwright suite, single happy-path spec to start:
  - Admin route (or seed script) issues an invite for `beta+e2e@…`.
  - Visit `/signup?invite=<token>`, confirm email field is pre-filled and
    locked, submit, assert redirected to `/app` with a session cookie.
  - Repeat with the same token expired (mock `Date.now`) → assert visible
    "invite expired" message and no session created.
- Add a `/login` spec: enter email, request magic link, click the
  emitted verify URL (capture it from logs or a test-only endpoint),
  assert authenticated.

### F-005 — Send-dispatch timezone math is untested [Severity: High] [Layer: Unit]

**Flow at risk:** `computeLocal` (`src/jobs/send-dispatch.ts:185-216`)
projects a UTC instant into each user's IANA zone via
`Intl.DateTimeFormat` and looks up the weekday in a `WEEKDAY_INDEX`
record. This decides whether a given user gets their digest *now*.

**Current coverage:** None.

**Why it matters:** Bugs here are not crashes — they mis-fire dispatch
windows by hours or skip days. The "hour 24 vs 00" normalization
(line 204) is a real-world Node-version-dependent quirk, and DST
transitions in `America/New_York` / `Europe/Paris` will be a recurring
correctness question.

**Suggested tests (sketch):**
- Vitest unit. Cases:
  - 2026-05-16T12:00Z + `America/Los_Angeles` → `hour=5, weekday=6` (Sat).
  - 2026-05-16T00:00Z + `Pacific/Auckland` → wraps to local Saturday
    noon, weekday=6, hour=12.
  - DST forward (US 2026-03-08T07:00Z + `America/New_York`).
  - DST back (EU 2026-10-25T01:00Z + `Europe/Paris`).
  - Invalid tz string → throws.

### F-006 — Digest-period classification is untested [Severity: High] [Layer: Unit]

**Flow at risk:** `deriveDigestPeriod`
(`src/lib/digest-period.ts:25-53`) classifies a digest as `daily` vs
`catchup` based on a 48-hour threshold. Drives email subject line and
in-app header copy.

**Current coverage:** None.

**Why it matters:** Pure function, easy to test, and silently wrong if
the threshold or `Math.ceil` is touched. A regression turns every email
into "your past 1 days" copy — visible to every recipient.

**Suggested tests (sketch):**
- Vitest unit. Cases:
  - 24h span → `daily`, `rangeLabel` = end date short.
  - 48h span (exact boundary) → `daily` (inclusive of the threshold).
  - 72h span → `catchup`, `daysBack=3`, range `"May 13 → May 16"`.
  - 7d span → `catchup`, `daysBack=7`.
  - Null periodStart or periodEnd → `unknown`, all fields null.

### F-007 — LLM cost accounting is untested [Severity: High] [Layer: Unit]

**Flow at risk:** `computeCostMicroUsd` (`src/lib/llm-cost.ts:73-`) and
`recordLlmUsage` (line 98). Per-call cost math; reads run into PostHog
and into internal cost dashboards.

**Current coverage:** None.

**Why it matters:** Money math. Off-by-1000 errors on micro-USD
conversion or model-rate lookups will quietly under- or over-report cost
to PostHog. Trivial to test.

**Suggested tests (sketch):**
- Vitest unit. Cases:
  - Sonnet input/output rates × known token counts → expected
    micro-USD (verify against published Anthropic rates).
  - Haiku same.
  - Unknown model id → throws (or returns 0; whichever is the contract).
  - Cache-write / cache-read tokens priced separately if the schema
    supports it.
- `recordLlmUsage` belongs in an integration test (it writes a row);
  the cost computation is pure-function unit.

### F-008 — Classifier prompt + response handling is untested [Severity: High] [Layer: Unit + integration]

**Flow at risk:** `classifyItem` (`src/lib/classify.ts:122`, 258 LoC
total). Builds the Haiku prompt, parses JSON from the model, recovers
from malformed JSON, falls through to default classifications on error.

**Current coverage:** None.

**Why it matters:** Branching logic on untrusted (model-generated) JSON
is exactly where bugs hide. Today a malformed Haiku response either
crashes the score job or silently default-classifies — without a test
we can't tell which.

**Suggested tests (sketch):**
- Vitest unit. Stub the Anthropic SDK. Cases:
  - Well-formed JSON response → returns parsed classification.
  - Response wrapped in markdown code fence → still parses.
  - Garbage non-JSON → returns the documented fallback, doesn't throw.
  - SDK throws 429 → propagates so the caller (score job) can retry.

### F-009 — Tenant isolation in jobs has no test [Severity: Medium] [Layer: Integration]

**Flow at risk:** Per the agentic-pivot memory, the v1 model is "one
user = one customer" and every job query filters by `user_id`. There is
no automated check that any of these filters actually holds.

**Current coverage:** None.

**Why it matters:** A regression that drops the `WHERE user_id = ?`
clause on a synthesizer query writes user A's digest_items against user
B's digest row. Type checks won't catch this. Manual QA against a
single seeded user won't catch this.

**Suggested tests (sketch):**
- Vitest integration. Seed users A and B with overlapping competitors.
  Run `runSynthesisForUser(A.id)`. Assert: digest rows + digest_items
  rows belong only to A; B's row count is unchanged.

### F-010 — Feedback rating endpoint has no test [Severity: Medium] [Layer: Integration]

**Flow at risk:** `GET /r/:digestItemId/:rating?t=<token>`
(`src/routes/r/$digestItemId/$rating.ts`). Verifies HMAC, looks up item
to recover `user_id`, upserts feedback row.

**Current coverage:** None. F-001 covers the crypto in isolation; this
finding covers the endpoint shape (status codes, redirect to
`/r/thanks`, the `onConflictDoUpdate` for re-rating).

**Suggested tests (sketch):**
- Vitest integration. Real DB. Cases:
  - Valid token, valid digest item → 302 to `/r/thanks?rating=up`, row
    in `feedback` with correct `(user_id, digest_item_id, rating)`.
  - Tampered token → 400.
  - Wrong rating for the token → 400.
  - Re-vote (up then down) → second call updates `rating` and
    `created_at` per `excluded.*`.

### F-011 — Onboarding SSE stream per-user channel isolation [Severity: Medium] [Layer: Integration]

**Flow at risk:** `/api/onboarding/stream`
(`src/routes/api/onboarding/stream.ts`). Comment at the top names the
attack: per-user `LISTEN` channels prevent cross-user delta leakage
even if a server-side filter has a bug. Worth pinning with a test.

**Current coverage:** None.

**Suggested tests (sketch):**
- Vitest integration. Open two SSE connections (users A and B). Trigger
  a `NOTIFY` on A's channel. Assert: A's stream receives the event,
  B's stream times out without receiving anything.

### F-012 — No test runner installed; no scaffold present [Severity: Low] [Layer: Tooling]

**Flow at risk:** Tooling, not a flow. `package.json` does not list
`vitest` or `@playwright/test`; no `vitest.config*` or
`playwright.config*` exists. Every finding above starts with "install
the runner first."

**Current coverage:** N/A.

**Suggested action:** Add `vitest` + `@playwright/test` + a minimal
config in one small PR. Wire `pnpm test` (unit + integration) and
`pnpm test:e2e` scripts. Do not seed full suites in the same PR —
follow up with the F-001/F-005/F-006/F-007 unit suites first, since
they're the cheapest wins.

### F-013 — Probe scripts ≠ tests; document the distinction [Severity: Low] [Layer: Hygiene]

**Flow at risk:** Communication. `scripts/test-source-*.ts`,
`scripts/test-haiku-classify.ts`, `scripts/test-sonnet-synthesize.ts`,
`scripts/test-synthesize-e2e.ts`, `scripts/smoke-schema.ts` are named
"test"/"smoke" but assert nothing. A new contributor reading the
filenames may assume coverage exists.

**Suggested action:** Keep the probe scripts — they validate against
real third-party APIs that mocks can't (per
`feedback_end_to_end_validation.md`). Either rename them to
`probe-*.ts` for clarity, or note their nature in `CLAUDE.md`. No
action needed if the convention is already understood.

### F-014 — No CI to run tests once they exist [Severity: Info] [Layer: Tooling]

**Flow at risk:** None today (no tests). But adding tests without a CI
job is half a solution — local-only tests rot. Recommend adding a
GitHub Actions workflow that runs `pnpm typecheck && pnpm test` on PR.
E2E and integration can run in a separate post-merge job to keep PR
feedback fast.

### F-015 — `/healthz` has no scheduled post-deploy check [Severity: Info] [Layer: Smoke]

**Flow at risk:** `GET /healthz` (`src/routes/healthz.ts`) exists and
returns 200 with DB latency. Nothing pings it after a Railway deploy.

**Suggested action:** A 1-line post-deploy curl in Railway (or a
single-test Playwright smoke spec running against the production URL)
catches "deploy succeeded but the app is broken" cases. Optional at PoC
scale; non-optional once the beta exits.

## Pyramid layers with no current findings

None. Every layer is empty. Re-run this audit after the first round of
tests is added; expect the next pass to focus on the *quality* of
existing tests rather than their absence.
