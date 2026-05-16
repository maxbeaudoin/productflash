# Product Flash — PoC Tasks

_Generated 2026-05-13, restructured 2026-05-15 for the agentic-SaaS pivot. Source of truth for active work behind `SCOPE.md`._

**Legend:**
- ☐ pending · ⏳ in-progress · ✅ completed
- **Blocked by:** task must finish first
- **Blocks:** other tasks that wait on this one

## Priority overrides

The default pickup rule is "lowest ID among unblocked tasks". When this section has entries, take them in the order listed instead — they reflect explicit owner priorities that override numeric ordering.

Current focus is the **agentic SaaS + dogfood loop** — single app for marketing, user app, and admin; magic-link auth; agentic FTE writes a user profile (competitors + position + goal) on signup; first digest visible in-app within ~5 minutes. Email send + per-TZ broadcast are deferred until the in-app dogfood loop is clean.

1. **#14** — landing port (`/`) ✅
2. **#26** — Better Auth + magic-link via Resend ✅
3. **#33** — waitlist capture + invite-gated landing ✅
4. **#34** — admin waitlist + invite issuance ✅
5. **#27** — profile schema expansion ✅
6. **#31** — app shell + `/app/digests` list + detail ✅
7. **#25** — debug digest preview (wraps #31's component) ✅
8. **#28** — FTE agent backend ✅
9. **#29** — FTE flow frontend ✅
10. **#30** — fast-path time-to-first-digest ✅
11. **#35** — personalize classify + synthesize on user profile ✅
12. **#39** — polish FTE streaming UI clunkiness (dogfood iter 1 — user said this first)
13. **#36** — admins skip onboarding ✅
14. **#37** — pre-fill `/signup` from the waitlist row ✅
15. **#38** — auto-sign-in after `/signup` submit ✅
16. **#40** — catch-up framing + visible date ranges on digests ✅
17. **#41** — per-item timestamps when truthful, omit when unknown ✅
18. **#42** — next-digest banner on `/app/digests` listing ✅
19. **#13** — Maxime full FTE dogfood (iter 3 ran 2026-05-16; surfaced #46/#47/#48 — resume iter 4 after those land)
19a. **#43** — fix planner_text disappear/reappear flicker (dogfood iter 2) ✅
19b. **#44** — sticky status header + auto-scroll for streaming (dogfood iter 2) ✅
19c. **#45** — diversify digest items across competitors (dogfood iter 2) ✅
19d. **#46** — fix pending-push double-counting + smoother auto-scroll (dogfood iter 3) ✅
19e. **#47** — move status to bottom + parse markdown in pending cards (dogfood iter 3) ✅
19f. **#48** — agent prompt: ≤2-sentence steps, ban competitor recaps (dogfood iter 3) ✅
19g. **#49** — status pill polish + smooth scrolling everywhere + jump to profile on completion (dogfood iter 3, second pass) ✅
19h. **#50** — catch-up digest: 10 items, cap-3, full per-competitor pool (dogfood iter 3, "still all Lattice") ✅
20. **#32** — `/app/profile` view + edit ✅
21. **#16** — admin app (`/admin/users/*`) ✅
22. **#11** — Resend email template + send (reactivate after dogfood)
23. **#17** — per-TZ send scheduling
24. **#18** — onboard 5–10 betas
25. **#20** — PostHog wiring ✅
26. **#51** — PostHog error tracking + Slack alerts ✅
27. **#19** — launch + monitor

---

## Foundation (do first)

### #1 Init TanStack Start + Railway + Postgres + Pino — ✅
Bootstrap TanStack Start (pnpm). Install Drizzle + drizzle-kit, pg-boss, Pino, posthog-node, `@anthropic-ai/sdk`, resend, react-email. Create Neon project (with a `main` branch for prod and `dev` branch for migrations). Create Railway project with two services: web (TanStack Start) + worker (long-running pg-boss host). Wire env config (Neon `DATABASE_URL`, Anthropic, Firehose, Firecrawl, Resend, Product Hunt, PostHog). Implement `/healthz` that proves DB is reachable. Set up Pino structured logging baseline.
**Blocks:** #21

### #2 Define schema + Drizzle migrations — ✅
Implement schema per `SCOPE.md` §5: `users`, `competitors`, `user_competitors`, `raw_items` (unique on `source+source_id`), `digest_items`, `digests`, `feedback`. Write initial migration, seed script for a handful of known competitors.

### #21 Design system foundations (tokens + Tailwind v4 + shadcn + fonts) — ✅
Create `src/design/tokens.ts` mirroring `executive-summary.html` CSS variables (ink/paper/accent/coral palette, font families, radii). Configure Tailwind v4 `@theme` to consume tokens. Run `npx shadcn@latest init` with Base UI primitives. Install components: button, input, label, form, combobox, dialog, toast, select. Add Lucide. Self-host Inter + JetBrains Mono via `@fontsource`. Prereq for all UI work.
**Blocked by:** #1 · **Blocks:** #14, #16, #29, #31, #32

---

## Week 1 — Ingestion pipeline

### #5 RSS source adapter — ✅
Wrap a feed parser. Input: competitor + `rss_url`. Output: normalized `raw_item` rows. Handle malformed feeds, missing `pubDate`, dedupe via guid/link. Includes an autodetect helper that tries `/feed`, `/rss`, `/changelog.rss`, `/blog/feed` for a given homepage URL — used by the FTE agent (#28) as a tool.

### #3 Product Hunt source adapter — ✅
Use the PH public GraphQL API. Query recent posts; filter by competitor name/slug/domain. Normalize to `raw_items`. Token from env.

### #6 Firehose source adapter — ✅

### #23 Verify Firehose buffer is flowing — ☐
Follow-up to #6. The initial probe ran minutes after `firehose-sync-rules.ts --apply` created the 7 rules; Firehose's buffer is forward-looking, so zero events was expected and is not a regression signal yet. Re-run `pnpm tsx scripts/test-source-firehose.ts --twice` ≥24h after rule creation (so realistically from 2026-05-15 onwards). Expectations: at least one of the seeded competitors returns ≥1 event; `--twice` shows sourceId overlap across runs. If still zero across all 7, investigate: Lucene query may be too narrow (e.g., common-word names like "Linear" / "Resend" filtered by quality flag), or Firehose simply hasn't crawled matching pages yet. Tune the template in `scripts/firehose-sync-rules.ts:buildLuceneQuery` and re-`--apply`. Block #7 (orchestrator) on this only if zero items persist past 48h.
**Blocked by:** #6

### #4 Firecrawl pricing-page scraper — ✅
Daily scrape of competitor `pricing_url` via Firecrawl (https://docs.firecrawl.dev/api-reference/introduction). Store latest snapshot; on change emit a `raw_item` with a unified diff in the body. Skip competitors without a `pricing_url`.

### #7 Ingestion orchestrator job — ✅
pg-boss scheduled job (04:00 UTC) that fans out per competitor: invoke all 4 source adapters in parallel, write `raw_items` with dedupe (on conflict do nothing). Emit per-source metrics via Pino + a PostHog server event (`ingestion_run` with counts per source). Retries via pg-boss config.

### #8 Seed competitors + validate end-to-end ingestion — ✅
Seed 5 real competitors (mix of analytics/CRM/devtools SaaS). Run ingestion locally end-to-end. Eyeball `raw_items` — confirm signal is real and dedupe holds across 2 consecutive runs. Note: the seeded competitors are scaffolding for ingestion validation; the FTE agent (#28) populates per-user competitors from scratch in the real flow.

---

## Synthesis pipeline

### #9 Anthropic SDK + classify-and-score job (Haiku) — ✅
Wire `@anthropic-ai/sdk` with `claude-haiku-4-5-20251001`. Prompt: given a `raw_item` (title + body excerpt), output JSON `{ category: launch|pricing|feature|positioning|noise, score: 0-100, why: string }`. Batched per user (only items for that user's competitors, last 24h). Persist scores.

### #10 Synthesis job (Sonnet) → digest_items + digests — ✅
Use `claude-sonnet-4-6`. Input per user: top-N scored items (drop noise, cap at ~5). Output: per-item headline + snippet + impact_note in Product Flash editorial tone (see the digest sample on the landing route `/`, sourced from `src/data/landing.ts`). Persist `digest_items` + `digests`. If fewer than 1 item qualifies, persist an empty-digest record so the send job emits the "nothing notable" template.

### #12 Feedback redirect endpoint — ✅
`GET /r/:digest_item_id/:rating` — records feedback row (upsert on user+item), then redirects to a static thanks page. Validate rating in `{up, down}`. Use a signed token to prevent third-party tampering.

---

## Landing (public marketing)

### #14 Port executive-summary.html to public landing route (1:1 visual) — ✅
Ported the original `executive-summary.html` into TanStack Start route `/` as componentized React. Components: `TopBar`, `Hero`, `ProblemSection` (+ `StatCard` x3), `SolutionSection` (+ `FeatureCard` x4), `DigestPreview` (+ `DigestItem` x3), `AudienceSection` (+ `PersonaCard` x3), `ProofSection`, `CTASection`, `Footer`. Page content (stats, features, personas, sample digest items) lives in `src/data/landing.ts`. Styled with Tailwind v4 against design tokens — zero custom CSS. After pixel parity was confirmed, the source `executive-summary.html` and the temporary `/executive-summary` route (originally #24) were removed; the React port is the canonical landing. CTA buttons link to `/signup` (entry point to the agentic FTE in #29).
**Blocked by:** #21

### #33 Waitlist capture + invite-gated landing — ✅
Pivot the public funnel from open signup to waitlist + invite. Concrete deliverables:

- **Schema** — new `waitlist` table: `id uuid PK`, `email text NOT NULL UNIQUE`, `name text`, `position text`, `company_url text`, `source text` (e.g. `'hero'`, `'cta-section'`, `'footer'`), `created_at`, `invited_at timestamptz` (NULL until an admin issues an invite later). Drizzle migration + types.
- **Server endpoint** — POST `/api/waitlist` (or TanStack server fn): validates with Zod, `INSERT … ON CONFLICT (email) DO NOTHING` so re-submits are silent no-ops, emits a Pino info line. PostHog `waitlist_joined` event is wired once #20 lands; for now Pino is enough.
- **Landing UI** — update `src/data/landing.ts` so the primary CTA is `{ label: 'Join the waitlist', href: '#waitlist' }` everywhere (Hero, CTASection, any embedded `Get the daily brief`-style anchors). Replace `TOPBAR.meta = 'Executive Summary · 2026'` with a real **Log in** link aligned to the top-right of the dark header (links to `/login`, uses the existing brand palette — small pill or text link, not a heavy button). Add a `<WaitlistForm>` section anchored at `#waitlist` (Hero CTA scrolls to it; CTASection embeds it) — minimal: email + optional position dropdown + optional company URL + submit. Render an inline confirmation state ("Got it — we'll be in touch") after submit.
- **`/signup` gating** — without a `?invite=<token>` search param, render an "invite-only" placeholder pointing back to the waitlist. Don't yet validate the token cryptographically (admin invite issuance is its own work) — for now any non-empty `invite` param shows the magic-link form unchanged, empty/missing param shows the gate.

Out of scope (later tasks):
- Admin UI for issuing invites — folds into #16 (extend with an "invite" action that signs a token + opens a mail draft / shareable URL with `?invite=<token>`).
- Cryptographic invite-token validation — reuse the HMAC pattern from `src/lib/feedback-token.ts`; wire in alongside the admin invite UI.
- Magic-link redemption that flips `waitlist.invited_at` and seeds `users.email` from the waitlist row — overlaps with #29 once admin invite UI exists.

Validation: real submit lands a `waitlist` row; landing has no public `/signup` link in CTAs; `Log in` is visible top-right and routes to `/login`; bare `/signup` shows the invite gate.

**Blocks:** #29 (signup form must accept `?invite=<token>`), #16 (admin invite UI), #34 (admin invite issuance).

### #34 Admin waitlist + invite issuance — ✅
The minimum viable admin surface to invite real beta users off the waitlist. Lives at `/admin/waitlist` and ships its own minimal admin scaffold so we don't have to wait on the full users admin (#16) — the two converge later. Required because #33 currently accepts any non-empty `?invite=` value, so there's no auditable record of who was invited and no way to revoke.

Concrete deliverables:

- **Token signing** — new helper `src/lib/invite-token.ts` mirroring the HMAC pattern in `src/lib/feedback-token.ts`. Token payload: `waitlist.id` + `email` + `issuedAt`. `signInviteToken({ id, email })` returns the token, `verifyInviteToken(token)` returns `{ id, email } | null`. Reuse `INVITE_TOKEN_SECRET` (new env var, generate alongside `BETTER_AUTH_SECRET`).
- **`/signup` cryptographic verification** — replace the "any non-empty `?invite=`" check in `src/routes/signup.tsx` with `verifyInviteToken`. Invalid/expired tokens render the gate, valid tokens prefill the email field from the token payload (read-only) before showing the magic-link form.
- **Admin route shell** — `/admin/waitlist` gated by `requireAdminSession()` in `src/lib/auth-server.ts` (already exists from #26). Single-page list view: email · joined date · position/company · invited_at status. Sort newest first. No pagination yet — fine until we cross ~500 rows.
- **Invite action** — per-row "Invite" button calls a TanStack server fn that (1) signs a token via `signInviteToken`, (2) sets `waitlist.invited_at = now()`, (3) returns the full `https://<host>/signup?invite=<token>` URL. Render the URL inline with a "Copy" button; manual outreach (email, Slack, DM) until #11 reactivates and we can auto-send. A second "Send via Resend" button is a follow-up once Resend templates are wired — explicitly out of scope here.
- **Re-issue / revoke** — re-issuing on a row that already has `invited_at` just re-signs a fresh token (helpful when the user lost the link). No revoke action yet; if needed, manually clear `invited_at` and re-issue.

Out of scope (deferred):
- Magic-link redemption that flips waitlist row → users row (overlaps with #29 — the FTE signup form has access to the verified invite payload via `Route.useSearch()` and can seed `users.email` from it).
- Bulk invite ("invite next 10") — fine to add later if manual clicks get tedious.
- Auto-send via Resend — folds into #11 once the template + send infra is back online.

Validation: bare `/signup` still shows the gate; `/signup?invite=<bogus>` shows the gate; `/signup?invite=<valid-signed-token>` shows the magic-link form with the email prefilled; clicking Invite on the admin row produces a working URL and stamps `invited_at`; second click on the same row re-issues.

**Blocked by:** #26, #33 · **Blocks:** #16 (admin shell can adopt the same nav/layout when it lands), #18.

---

## Agentic SaaS + dogfood loop (current focus)

### #26 Better Auth + magic-link via Resend — ✅
Installed `better-auth` 1.6 with the Drizzle adapter (`usePlural: true`, `generateId: false` so Postgres `defaultRandom()` supplies UUIDs). Magic-link plugin delivers via the existing Resend client (reuses `RESEND_API_KEY` / `RESEND_FROM`); when the key is absent in dev, the link is printed to the Pino log instead. Admin-role plugin replaces a hand-rolled `is_admin` boolean — role lives on `users.role` (default `'user'`). Schema additions: `sessions`, `accounts`, `verifications` plus `email_verified`, `image`, `updated_at`, `role`, `banned`, `ban_reason`, `ban_expires` on `users`. `users.name` and `users.tz` are now nullable since magic-link signup creates a row before the FTE agent (#28) fills those in — the synthesis job (#10) falls back to the email local-part when `name` is null. Auth handler mounted at `/api/auth/$`; `src/lib/auth-server.ts` exposes `getSession()`, `requireSession()`, `requireAdminSession()`. `routes/app.tsx` + `routes/admin.tsx` use these in `beforeLoad` server fns to gate every child route; non-admins hitting `/admin` bounce to `/app`. Minimal `/signup`, `/login`, `/logout` routes shipped (full FTE entry is #29). `BETTER_AUTH_SECRET` + `BETTER_AUTH_URL` added to env schema + `.env.example`. Validated end-to-end: POST `/api/auth/sign-in/magic-link` → verify URL → session cookie → 200 on `/app` → 307 on `/admin` → `/logout` clears cookies and the next get-session returns `null`.
**Blocked by:** #2 · **Blocks:** #28, #29, #31, #32

### #27 Profile schema expansion — ✅
Add nullable columns to `users` for the AI-generated profile:
- `position` (text) — e.g. "Head of Product"
- `company_name` (text)
- `company_url` (text)
- `ultimate_goal` (text) — free-form, what success looks like
- `focus_areas` (text[]) — themes the user wants amplified
- `profile_confirmed_at` (timestamptz, nullable)
- `status` enum gains `'onboarding'` value (joins existing `'pending'`/`'active'`)

Drizzle generate + migrate. Drop the seeded `competitors` rows from `db:seed` — agent populates per user. Keep the schema as-is otherwise.
**Blocked by:** #2 · **Blocks:** #28, #32

### #31 App shell + `/app/digests` list + `/app/digests/:id` detail — ✅
Auth-gated TanStack Start layout under `/app`. Header w/ user menu, sign-out, link to `/app/profile`. Routes:
- `/app` → redirect to `/app/digests`
- `/app/digests` — list of past digests, newest first (date, item_count, one-line peek)
- `/app/digests/:id` — full digest rendered natively with shadcn + brand tokens (NOT the email template — in-app rendering is intentionally higher fidelity than email; the two surfaces diverge by design)

Components: `DigestHeader`, `DigestItem` (matches executive-summary mock), `FeedbackButton` (👍/👎 hits the existing `/r/:digest_item_id/:rating` endpoint). Read-only at this stage — profile edit is #32.
**Blocked by:** #21, #26 · **Blocks:** #13, #16, #18, #25

### #25 Dev digest preview route — ✅
Dev-only variant of `/app/digests/:id` that bypasses auth. Same React components as #31, exposed at `GET /debug/digest/:user_id`. Optional `?refresh=1` query param re-runs `score → synthesize` for the most recent 24h of `raw_items` before render — fast-iteration escape hatch for prompt tuning. Gated by `NODE_ENV !== 'production'` (returns 404 in prod).
**Blocked by:** #31

### #28 FTE agent backend — ✅
pg-boss singleton job per user (`fte:${user_id}`). Anthropic SDK tool-use loop with `claude-sonnet-4-6` as the planner. Tools:
- `web_search_20250305` (Anthropic server tool) — competitor + market research
- `fetch_url(url)` — plain-text extraction of a URL (reuse Firecrawl scrape if richer content is needed)
- `discover_rss(homepage_url)` — wraps the autodetect helper shipped in #5
- `add_competitor({ name, homepage_url, rss_url? })` — upserts `competitors` + `user_competitors`
- `save_profile({ position, ultimate_goal, focus_areas })` — writes back to `users`

Stream every event (model output, tool call, tool result, decision) to a new `fte_events` table keyed by `(user_id, run_id, ts)` with `kind` + `payload jsonb`, so the frontend can replay/tail. Bound the loop by `max_iterations` + `max_tool_calls` to avoid runaways. On exit, flip `users.status` to `'active'` only if `save_profile` was called at least once.
**Blocked by:** #26, #27 · **Blocks:** #29, #30

### #29 FTE flow frontend — ✅
`/signup` is now an invite-gated TanStack Start route that renders the FTE intake form when `verifyInviteToken(?invite=…)` succeeds (email locked from the signed payload). Submit upserts the `users` row with `status='onboarding'` + the seed profile fields (`company_url`, `position`, `ultimate_goal`), enqueues the FTE agent via a lazy pg-boss web client (`src/lib/boss.ts`), then sends the magic-link via Better Auth's server API — all in one request. The "check your inbox" card replaces the form after submit.

`/app/onboarding` is auth-gated under the existing `/app` shell. The loader replays the latest run's `fte_events` for the user + the current profile + linked competitors; the client opens an SSE stream against `/api/onboarding/stream` and tails NOTIFYs on the per-user `fte_events:<userId>` + `fte_events_delta:<userId>` channels via a dedicated direct-pg listener (`src/lib/notify.ts`, honoring `DATABASE_URL_DIRECT`). The terminal-feel event log renders each event kind (planner_text / tool_use / tool_result / server_tool_use / web_search_tool_result / iteration / run_started / run_finished) in JetBrains Mono with colored prefixes; transient text_delta + block_start deltas drive a typewriter line that flushes when the durable block lands.

Once `run_finished` arrives and a profile is saved, the profile preview card reveals: role / company / goal / focus-area chips / linked competitors with RSS badges. `Edit fields` toggles an inline form (position, company_name, ultimate_goal, focus_areas as comma-separated tags); `Looks good →` calls `confirmProfile` which stamps `profile_confirmed_at = now()` + `status='active'` (idempotent via `WHERE profile_confirmed_at IS NULL`) and navigates to `/app/digests`. `/app/index.tsx` now gates the landing redirect: unconfirmed users → `/app/onboarding`, everyone else → `/app/digests`.

Out of scope here (deferred to #30): on-demand ingest → score → synthesize fast-path. `confirmProfile` will enqueue that chain once #30 lands.
**Blocked by:** #21, #26, #28 · **Blocks:** #30

### #30 Time-to-first-digest fast path — ✅
On profile confirmation in `/app/onboarding` (#29), the `confirmProfile` server fn enqueues a one-off `fast-path-run` pg-boss job (singleton on `userId`) via the web-side `getBoss()` client. The handler in `src/jobs/fast-path.ts` runs the same `ingest → score → synthesize` chain the daily crons use, but scoped to one user: `runIngestionForUser(userId)` (new — extracted shared `runIngestionForRefs` so the orchestrator now has both global-cron and per-user paths) then the already-existing `runScoringForUser` + `runSynthesisForUser`. Each stage stays idempotent — the cron path can still overwrite later that day.

`/app/digests` polls the loader every 4s while the user has zero digests, rendering a "Brewing your first brief" card with a live elapsed counter; when the first row lands it auto-navigates to `/app/digests/:id`. Returning users with existing digests skip the brewing state entirely (auto-route gate keyed on whether the page mounted brewing).

A failed enqueue is non-fatal — the 05:30 UTC synthesis cron is the safety net, so `confirmProfile` always returns ok and the user lands on the brewing state regardless.
**Blocked by:** #28 · **Blocks:** #13

### #35 Personalize classify + synthesize on user profile — ✅
**Critical for product–market fit.** Today the AI-generated profile (`position`, `company_name`, `ultimate_goal`, `focus_areas`) is UI-only: the FTE agent (#28) writes it, `/app/profile` (#32) and `/app/onboarding` (#29) display/edit it, but neither the Haiku classifier nor the Sonnet synthesizer reads it. Same item ⇒ same category, same score, same headline regardless of reader. The product reduces to a competitor-news aggregator filtered by company list — *not* the personalized brief the landing page promises. If we run #13 dogfood on the current chain, we'll be testing whether universal classification is acceptable, which is the wrong question.

Concrete deliverables:

- **Classify prompt — profile-aware scoring.** Extend `classifyItem({...})` in `src/lib/classify.ts` to accept an optional `reader: { position, ultimateGoal, focusAreas }` and inject a short "Reader context" block. Score tilts up when an item resonates with a focus area or goal, down when off-axis (even when globally newsworthy). The `category` enum stays unchanged — it's a property of the item, not the reader. Update `runScoringForUser` + `runScoring` in `src/jobs/score.ts` to fetch the profile (one SELECT per user) and thread it through.

- **Synthesize prompt — profile-aware framing.** Extend `SynthesisInput` in `src/lib/synthesize.ts` to carry the same `reader` shape; render it in the system message ("Reader is a Head of Product at Linear; their goal is …; they care about pricing changes, AI features, …"). The `impactNote` is the load-bearing surface — it must explicitly reference the reader's goal/focus where relevant ("Pressures *your* enterprise pricing positioning" beats a generic "Pricing pressure on the category"). Update `runForUser` in `src/jobs/synthesize.ts` to fetch + pass the profile.

- **Cache invalidation on profile change.** Now that scores carry profile-derived weights, edits to `position` / `ultimate_goal` / `focus_areas` must invalidate `item_scores` for that user so the next score run re-classifies. Wire this into both write paths: `editProfile` server fn in `src/routes/app/profile.tsx` AND the FTE agent's `save_profile` tool in `src/agents/fte/tools.ts`. Simple `DELETE FROM item_scores WHERE user_id = $1` is fine for the PoC. The fast path (#30) will then re-score from scratch on profile confirm — exactly the desired behavior.

- **Empty-profile fallback.** Magic-link signup creates a user row before the FTE agent fills it in. Classifier + synthesizer must gracefully degrade to the current generic prompts when the reader is absent — never block scoring on a missing profile.

- **Eval evidence before merging.** Capture before/after digest markdown for one seeded user (e.g. `fte-iso-b`) — run the current generic chain, snapshot to `/tmp/eval-generic-<userId>.md`; deploy the personalized chain, snapshot to `/tmp/eval-personalized-<userId>.md`. Eyeball whether `impact_note` actually shifts from generic ("Pricing pressure on the category") to reader-specific ("Pressures your enterprise positioning vs. Asana"). Don't merge unless the diff is visible.

Out of scope:
- Per-focus_area numeric boost weights — the prompt does this work, not a multiplier.
- Long-term memory of 👍/👎 feedback influencing future scoring (separate task — feedback loop).
- Position/goal flowing into the FTE planner prompt — already there as the seed input to the agent.

**Blocked by:** none (all surfaces exist) · **Blocks:** #13 (dogfood is the test of whether personalization lands well), #18 (beta launch).

### #13 Maxime full FTE dogfood — ⏳
Sign up at `/signup` against your own company. Watch the FTE agent run end-to-end at `/app/onboarding`. Read the resulting profile critically: did it identify the right competitors? Right framing of your role + goal? Confirm and check the fast-path digest. Repeat for 3 consecutive days: open the daily digest at `/app/digests/:id`, look for quality, missed items, hallucinations. Tune prompts in #28 / #10 / #9 / #35 between runs. **Block real beta launch until 3 clean days in a row.**

Iteration log:
- **2026-05-16 (iter 1)** — surfaced #36, #37, #38, #39, #40, #41, #42. All landed.
- **2026-05-16 (iter 2)** — smoother overall. Three issues left: streaming still flickers (#43 — root cause is durable planner_text events being written only after stream.finalMessage(), so the live card vanishes the moment a block ends and reappears once the full iteration completes); streaming status scrolls out of view on long runs and there's no auto-scroll (#44); digest content was 100% Lattice — one competitor monopolizing the 5 slots (#45). Pause iter 3 until those land.
- **2026-05-16 (iter 3)** — pending queue helped the disappear/reappear feel but introduced its own regression: the step count climbed to ~#13 then collapsed to ~6 when save_profile cleared pending (#46 — nested setState double-pushed pending under concurrent rendering). Sticky-top status got lost again on long runs — user proposed moving the indicator to the BOTTOM and auto-scrolling into it (chat-app pattern, #47). Markdown lagged because pending cards rendered as plain text and waited for the durable event before parsing (#47 — fix: pending cards parse markdown immediately). Steps were too verbose and the final card duplicated the competitor list already shown in the profile preview (#48 — agent prompt tightened to ≤2-sentence cards, ban recaps).
- **2026-05-16 (iter 3, polish pass)** — pill polish (#49): align left (centered felt floaty), add bottom margin matching the top so the scroll anchor has equal breathing room, scroll smoothly to the profile preview on the running→finished transition (block: 'start' to top-align the panel), and switch ALL stream auto-scrolls to behavior: 'smooth' (browsers redirect a mid-tween smooth scroll toward the new target rather than fighting it, so the previous text-delta-uses-auto compromise wasn't needed). Pause iter 4 until #49 lands.

**Blocked by:** #30, #35, #43, #44, #45, #46, #47, #48, #49

### #32 `/app/profile` view + edit — ✅
TanStack Start route at `/app/profile` (auth-gated under the existing `/app` shell) renders an inline view + edit of the AI-generated profile: position, company name, company URL, ultimate goal, and focus_areas chips. "Edit" toggles the card into a form (re-uses the same Zod schema between client validation and the server fn). A second card lists tracked competitors with homepage + RSS badge (links open in new tab), an "Add" button that opens an inline form, and a per-row `×` to remove. `addCompetitor` server fn runs the same RSS autodetect helper the onboarding form uses, so newly added competitors get an RSS badge automatically when one resolves. Toasts confirm save / add / remove. A `Profile` pill link was added to `AppHeader` so the page is reachable from anywhere in `/app`.

Deviations from spec, kept as follow-ups rather than expanding scope:
- **Soft-delete deferred.** Remove is still a hard delete on `user_competitors`, matching the existing onboarding behavior. Adding `removed_at` would have required touching all four readers (ingest / score / FTE tools / onboarding) and an upsert path so re-adding clears the tombstone — out of scope for a viewer/editor screen.
- **focus_areas cache invalidation skipped.** `focus_areas` isn't currently read by the classifier or synthesizer, so there's no cached weight to invalidate. The hook lands naturally when scoring starts consuming the profile.

**Blocked by:** #26, #27, #31

### #16 Admin app (`/admin/users/*`) — ✅
TanStack Start route at `/admin/*` gated by Better Auth's admin-role plugin (#26). Views:
- `/admin/users` — list with email, status, last digest date, competitor count
- `/admin/users/:id` — profile, recent digests (rendered via #31's components), FTE event timeline (from `fte_events`), button to re-run FTE / re-trigger digest

Used for personal QA + future beta babysitting.
**Blocked by:** #26, #31

### #36 Admins skip onboarding — ✅
Admin users hit `/app` and get redirected to `/app/onboarding` because their `profile_confirmed_at` is null — but onboarding is irrelevant to admins, who use the product as operators. Surfaced in dogfood iteration 1 (2026-05-16).

In `src/routes/app/index.tsx`, when the session has `role === 'admin'`, redirect to `/admin` (which itself bounces to `/admin/users`) regardless of `profile_confirmed_at`. Admins who *also* want to dogfood the user-facing app can navigate to `/app/digests` or `/app/onboarding` manually — we just stop dropping them into the onboarding flow.

Validation: log in as an admin with `profile_confirmed_at = NULL`, hit `/app`, land on `/admin/users`. Log in as a regular user with the same null state, still land on `/app/onboarding`.

**Blocked by:** none

### #37 Pre-fill `/signup` from the waitlist row — ✅
Waitlist capture (#33) collects `email`, `name`, `position`, `company_url`. The `/signup` FTE intake then asks for `position`, `company_url`, and `ultimate_goal` again — flagged in dogfood iteration 1 (2026-05-16) as duplicate effort that erodes trust.

In `src/routes/signup.tsx`'s loader, after `verifyInviteToken` succeeds, look up the matching `waitlist` row (by email, or by `waitlist.id` if added to the token payload) and pass `{ position, companyUrl }` as form defaults. Goal stays empty (no waitlist counterpart). Defaults are editable, not locked — a user might want to revise.

Validation: submit the waitlist with email + position + company_url → admin issues invite → opening the invite URL pre-fills both fields in the FTE intake form.

**Blocked by:** none (#33 + #34 already shipped)

### #38 Auto-sign-in after `/signup` submit — ✅
The HMAC invite token (#34) is already proof-of-ownership, so the magic-link email after `/signup` submit was redundant friction. Now the submit path mints a single-use Better Auth verification row server-side (`issueAutoSignInUrl` in `src/lib/auth-server.ts`: `randomBytes(32)` → `verifications` insert with 60s TTL, identifier=token, value=`{email}`) and returns the `/api/auth/magic-link/verify?token=…&callbackURL=/app` URL to the client. The client does a full-page `window.location.href` nav so Better Auth's standard verify route can consume the row, create the session, set the signed `session_token` cookie via `tanstackStartCookies`, and 302 to `/app` — which then routes to `/app/onboarding` for unconfirmed non-admins.

Reused the existing magic-link verify endpoint instead of hand-rolling cookie signing: same trust anchor, same cookie attributes, no parallel auth path to maintain. `/login` for returning users still goes through `auth.api.signInMagicLink` and emails the link — unchanged. `SentCard` ("Check your inbox") component removed; the form button transitions `submitting → redirecting → /app/onboarding`.

**Blocked by:** #34

### #39 Polish FTE streaming UI clunkiness — ✅
The agentic thinking stream (#29) lands in a usable but jittery state. Dogfood iteration 1 (2026-05-16) flagged:

- Current step appears, then disappears, as streaming progresses — a partial card flashes, then vanishes, then a different durable card lands.
- Markdown formatting flickers as text streams in (raw `**bold**` syntax briefly visible before re-rendering).
- Cards flicker on update.
- Some content is shown temporarily and replaced by the final answer — user can't tell what will persist.

Per [[feedback_agentic_ui]] the user surface is "thinking steps", not the raw event log — the current implementation surfaces too much transience.

**Scope expanded mid-task (2026-05-16):** the user's second pass on this clarified that the *content* of `planner_text` is also part of the clunkiness — phrases like "Good — Workleap is..." or "Now let me search..." leak internal reasoning instead of reading as a story to the user. Two architectural changes folded in:

1. **Story-form planner_text.** Rewrite `SYSTEM_PROMPT` in `src/agents/fte/agent.ts` so each text block is a user-facing observation written in narrative third-person ("Workleap is a manager enablement platform focused on…"). No filler openers, no first-person reasoning narration.
2. **Ephemeral status line ≠ historical cards.** Cards = durable narrative paragraphs (planner_text). A new live status line — derived on the frontend from the latest `tool_use` / `server_tool_use` event — replaces the previous status as activity moves forward. Status humanization is a frontend-only mapping (fetch_url → "Reading X", web_search → "Searching for 'Y'", add_competitor → "Adding Z", save_profile → "Saving your profile"). No new agent surface or tool needed.

Concrete deliverables:

- **Prompt rewrite** — narrative third-person planner_text. Drop "Good —", "Now let me", "Okay so". Each paragraph adds substantive evidence (positioning, decisions about competitors), not internal commentary.
- **`LiveStatusLine` component** above the cards. Reads the latest tool_use / server_tool_use event, humanizes to a short present-tense line. Hides on `run_finished`.
- **Cards refactor** — durable + live cards share identical visuals (border, shadow, number badge). The only differences: live renders plain text + cursor (no markdown parsing); durable renders parsed markdown without cursor. The swap on `planner_text` arrival becomes a one-frame seamless transition.
- **Drop the fake `Reading your homepage…` placeholder Thought card.** Pre-stream state is the new status line + WarmingPanel if no run yet.
- **Suppress streaming after `save_profile`.** Once the agent's save_profile tool_use fires, hide the live composing card so Sonnet's occasional post-recap doesn't flash up only to be filtered out by the planner_text cutoff.

Validation: run a fresh FTE end-to-end. Status line updates with each tool action and reads naturally. Cards land sequentially as story paragraphs, no filler openers, no flicker, no disappearing content. Markdown shows one transition only (plain → formatted) per card.

Out of scope: an agent-side `set_status` tool (kept the status frontend-derived for now — can revisit if humanized tool-use mapping feels generic).

**Blocked by:** none

### #40 Catch-up framing + visible date ranges on digests — ✅
The first digest a user receives covers ~7 days (fast-path #30 pulls a wider window so there's enough material to synthesize). Subsequent digests cover 24h. Today both render with identical "five things that mattered overnight" framing — misleading for the first digest, which the user noticed in dogfood iteration 1 (2026-05-16).

Concrete deliverables:

- **Digest record carries the window.** Add `period_start` + `period_end` (timestamptz) to `digests`; the synthesizer writes the actual ingestion window it used. Drizzle migration.
- **Framing differs by digest index.** In `src/lib/synthesize.ts`, when this is the user's first digest (`count(digests) for user === 0` before insert), produce a "Your catch-up brief — past 7 days" header + an opening line that acknowledges the wider window. Subsequent digests use the existing daily framing.
- **Range visible on `/app/digests/:id`** (and on the list peek at `/app/digests`). Catch-up renders e.g. `May 9 → May 16`; daily renders `May 16` (or `May 15 → May 16`).
- **No hallucinated ranges.** Legacy rows with null `period_start` render without a range, not with a guess.

Validation: brand-new user → first digest reads "catch-up brief" + 7-day range. Next day's run for the same user → "Today's brief" + 1-day range. Both ranges match the actual `raw_items` ingested.

Out of scope: per-item timestamps (#41). Configurable catch-up window length.

**Blocked by:** none

### #41 Per-item timestamps when truthful, omit when unknown — ✅
Each digest item has no visible timestamp today, which makes the "this week's news" framing impossible for the user to verify. The user wants to see *when* each item happened — but **only when we know**.

**No hallucination.** Per [[feedback_rtfm]] (broader principle: don't fabricate data we don't have), missing timestamps must render as no-timestamp, not as "today" or "recently" or current-date.

Concrete deliverables:

- **Carry `occurred_at` raw_item → digest_item.** `raw_items` already stores a publication timestamp from each source. Plumb it through to `digest_items` as a nullable `occurred_at`. Drizzle migration.
- **Sonnet does not invent the timestamp.** `src/lib/synthesize.ts` takes `occurred_at` as input *metadata*; the LLM-generated text does not reference it. The frontend renders the timestamp separately, beside the headline.
- **Frontend: friendly + truthful.** `DigestItem` shows `May 14 · 2 days ago` when present; renders nothing when null. No placeholder, no "recently", no current-day fallback.
- **Source adapters surface their best-available date.** Each of #3/#4/#5/#6 must set `raw_items.published_at` when the source provides one. When the source genuinely has no date (some Firehose events), leave it null — that's the truthful answer.

Validation: one digest mixing sources. RSS items show feed pubDate. PH items show post creation. Firehose events with no date render cleanly without a placeholder. The strings "today" / "recently" / current date never appear unless the source itself said so.

Out of scope: client-side relative-time auto-update (server-rendered static is fine — page reloads pick up newer relativity).

**Blocked by:** none

### #43 Fix planner_text disappear/reappear flicker — ✅
Dogfood iter 2 (2026-05-16) confirmed the streaming UI still flickers — each paragraph appears as it streams, then vanishes, then re-appears (with markdown) seconds later. #39 made the chrome consistent but didn't fix the underlying timing.

Root cause: the Anthropic SDK's `contentBlock` event fires *at the END* of each content block. The agent code (`src/agents/fte/agent.ts`) emits this as a `block_start` delta on the wire. The frontend handler in `src/routes/app/onboarding.tsx` then resets `streamingText` to `''`, blanking the live card. Meanwhile, the durable `planner_text` event isn't written until *after* `stream.finalMessage()` resolves for the whole iteration — which can be several seconds later if a tool_use follows the text. So the user sees: text streams in fully → live card blanks → (multi-second gap) → durable card lands.

Fix: introduce a `pendingThoughts` FIFO queue on the frontend. On `block_start` with `blockKind: 'text'` (which is misnamed in the SDK — really means "text block just ended"), snapshot `streamingText` into the queue instead of dropping it. Render pending entries as durable-looking cards with plain (unparsed) text. When the durable `planner_text` event lands, FIFO-pop the queue — the durable card with parsed markdown takes the same slot. The transition becomes a single style swap, not a disappear/reappear.

Validation: run a fresh FTE. Each paragraph should stay visible continuously from the moment its last character streams in through the swap to the parsed markdown version — no blank gap.

**Blocked by:** none

### #44 Sticky status header + auto-scroll for streaming — ✅
Dogfood iter 2 (2026-05-16) flagged that on longer runs the streaming status indicator at the top of the page scrolls out of view, leaving the user unable to tell *what* the agent is doing as new paragraphs land. The auto-scroll-to-latest-step is also missing — users have to manually scroll to follow.

Fix:
- Promote `LiveStatusLine` into a `StickyStatusBar` that pins to the viewport top (`sticky top-0`, backdrop-blur, high z-index) for the duration of the run. Hides itself once `run_finished` lands.
- Add an auto-scroll effect: on each change to `streamingText` / `thoughts.length` / `pendingThoughts.length`, scroll the bottom-of-stream sentinel into view, but only when the user is already within ~320px of the bottom (so manual scrolling up to re-read doesn't get hijacked).

Validation: as the agent emits paragraph after paragraph, the live status stays visible at the top regardless of scroll depth; the latest card pulls itself into view as it grows; manually scrolling up freezes auto-scroll until the user returns to the bottom.

**Blocked by:** none

### #45 Diversify digest items across competitors — ✅
Dogfood iter 2 (2026-05-16) opened a digest where all five slots were occupied by Lattice. The synthesis pipeline (`src/jobs/synthesize.ts`) was selecting the top N items globally by score, with no diversity guarantees — a single high-volume competitor with strong scores can monopolize the digest.

Fix: two-pass selection inside `runForUser`. First pass pulls a wider candidate pool and applies `MAX_ITEMS_PER_COMPETITOR = 2`. Second pass relaxes the cap and fills any remaining slots from the leftover pool (still ordered by score) — protects the small-N case where the user genuinely only has news from one or two competitors and we'd rather ship a full 5-item digest from one competitor than half-fill it.

With `MAX_ITEMS_PER_DIGEST=5` + cap=2, any digest with ≥3 competitors emitting non-noise items in the window is guaranteed ≥3 distinct competitors.

**Follow-up (#50 fold) on 2026-05-16:** the original implementation capped the candidate pool at `min(100, maxItems*6) = 60` rows by score — which silently re-introduced the original bug at a different layer. A high-volume competitor (Lattice, 68 non-noise items, max score 92) consumed every pool slot before low-volume competitors (15Five, 2 non-noise items, max score 42) were ever considered. The selection algorithm was correct; the pool simply didn't contain the diverse-pick candidates. Removed the score-based pool limit; the WHERE filter (userId + non-noise + window) bounds the row count to a few hundred at most, with a 2000-row warn-threshold safety net for runaway classifier noise filter regressions. This also tightens daily digests retroactively — high-volume competitor tails no longer crowd out low-volume competitor heads.

Validation: synth run for a user whose pool is skewed toward one competitor should produce a digest where no single competitor exceeds 2 items unless the pool is itself <3 competitors deep.

**Blocked by:** none

### #50 Catch-up digest: 10 items, cap-3, full per-competitor pool — ✅
Dogfood iter 3 (2026-05-16) on a re-run of the catch-up flow: with the iter-2 diversity fix the digest landed at 5/5 split across two competitors (Lattice + Leapsome), still no 15Five. User asked whether the first digest should be wider so users see the breadth of what the product will surface over time.

Two changes, both fast-path only:
- `FAST_PATH_MAX_ITEMS_PER_DIGEST = 10` (vs daily 5). Meatier first impression without doubling Sonnet cost much.
- `FAST_PATH_MAX_ITEMS_PER_COMPETITOR = 3` (vs daily 2). At 10 items, cap-2 leaves the second pass to backfill 4+ slots from the top-scored competitor — 60% Lattice. Cap-3 lands closer to a 50/30/20 split.

Threaded `maxItemsPerCompetitor` through `SynthesisOptions`. Removed the score-based pool limit (rolled into #45's writeup since same root cause). Re-run against Maxime's pool: 6 Lattice + 3 Leapsome + 1 15Five = 10 items, 3 competitors. The 15Five count is 1 (not 2) because the new user's classifier marked one of their two non-noise items differently — that's the classifier's call, not the selection's.

**Open follow-up:** feedback signal loop. The 👍/👎 plumbing exists end-to-end (#12 endpoint + #31 buttons surface on every digest item card). What's missing: the captured ratings don't feed back into scoring or synthesis prompts. Designing that loop is a separate task (per-user "what resonates" aggregate flowed into the reader profile? per-item reweighting in score.ts?).

**Blocked by:** none

### #46 Fix pending-push double-counting + smoother auto-scroll — ✅
Dogfood iter 3 (2026-05-16) surfaced a regression introduced by #43's pending queue. The block-end snapshot was written as a nested setState:

```ts
setStreamingText((prev) => {
  if (prev.trim().length > 0) {
    setPendingThoughts((q) => [...q, prev])  // ← nested
  }
  return ''
})
```

Under React 18 concurrent rendering the outer updater can be discarded and replayed; when it replays, the nested `setPendingThoughts` fires again with the same `prev`, pushing the same text twice. After a handful of iterations the pending queue carries 6+ ghost duplicates — the live card index climbs to ~#13 while only ~6 distinct text blocks have actually streamed. When `save_profile` lands the `wrappingUp` gate empties pending and the count collapses to the durable count (~6). Reads to the user as the step counter "jumping around".

Fix: mirror the streamed text in a `useRef` (`streamingTextRef`). On block-end, read from the ref, push to pending sequentially (not nested), then clear both ref and state. setState calls are now flat in the event-loop callback — no replay hazard.

Same task also widens the auto-scroll follow threshold (320px → 600px), defers the scroll to `requestAnimationFrame` so layout has settled, and uses `behavior: 'auto'` for text-delta updates (smooth tween fights itself when called every few chars) while reserving `behavior: 'smooth'` for structural changes (new card / pending card / live toggle). Tracks the structural key in a ref so rapid text deltas don't re-trigger the smooth animation.

Validation: run a fresh FTE. The numbered card index should grow monotonically and match the durable count + pending + live. The page should follow the bottom of the stream as new content lands; manually scrolling up >600px should freeze the follow until returning to the bottom.

**Blocked by:** none

### #47 Status at bottom + parse markdown in pending cards — ✅
Dogfood iter 3 (2026-05-16) flagged two issues with the iter-2 fixes:

1. **Sticky-top status got lost again.** Even though `sticky top-0` is set, on longer runs the user perceives the status as scrolling out of view (likely because the user is scrolling actively and the top doesn't catch their eye). User proposed moving the status to the BOTTOM of the stream and auto-scrolling into it — chat-app pattern. The status is then always at the user's natural reading position.
2. **Markdown rendering lagged.** Pending cards rendered as plain text (`PlainBody`) and only swapped to parsed markdown when the durable `planner_text` event landed — which can be several seconds after the block ended on the wire (`stream.finalMessage()` only resolves at end of iteration). Reads as a delayed "reformat".

Fix:
- Replace `StickyStatusBar` with `BottomStatusLine` rendered AFTER the cards (and before the scroll sentinel). Auto-scroll target is the sentinel just below it, so the status is always in view as the page follows downward.
- `PendingThought` now renders with `ThoughtBody` (parsed markdown) instead of `PlainBody`. The text is complete by the time it lands in pending — no risk of half-typed `**bold` flickering. The durable arrival is now a no-op visual swap rather than a delayed reformat.

Validation: status pill sits at the bottom of the stream throughout the run, follows the auto-scroll target, hides on completion. Markdown formatting (bold, paragraph breaks) appears the instant a block ends, not seconds later.

**Blocked by:** none

### #48 Agent prompt: ≤2-sentence cards, ban competitor recaps — ✅
Dogfood iter 3 (2026-05-16) flagged that the planner_text cards were too verbose (multi-paragraph walls) and that the final card before `save_profile` was a recap of the competitor list — which the user immediately sees again in the profile preview card directly below the stream. Pure duplication.

Fix: tighten `SYSTEM_PROMPT` in `src/agents/fte/agent.ts`:
- Hard cap: **≤ 2 sentences per text block, often 1**. Cards longer than that "bury the signal".
- Each block must ADD information the user can't see elsewhere on the page. The profile preview is right below; do NOT re-list competitors in a card.
- Explicit ban on recaps / summaries / sign-offs / competitor lists either BEFORE or after `save_profile`.

No code change in the agent loop or tools — just prompt edits. Effect verifiable from the next FTE run.

Validation: run a fresh FTE. Each card reads as 1–2 sentences. No final "Here's a summary of competitors:" card before save_profile. The competitor list appears only in the profile preview.

**Blocked by:** none

### #49 Status pill polish + smooth scrolling + jump to profile on completion — ✅
Dogfood iter 3, second pass (2026-05-16). Three small polish items on top of #46/#47/#48:

- **Status pill** — was center-aligned at the bottom of the stream, which felt "floaty" relative to the left-aligned cards above. Switch to `justify-start` so the pill sits flush with the card column. Add `my-5` (matching top/bottom margin) so the scroll anchor sentinel beneath the pill has the same breathing room as the gap above — no more pill-butting-against-bottom-of-viewport.
- **Smooth scrolling everywhere** — the iter-3-round-1 fix used `behavior: 'auto'` for text-delta updates to avoid mid-tween interruption, but visually that read as snap-snap-snap. Browsers actually handle a smooth-scroll being re-issued mid-animation by gracefully redirecting toward the new target, so the auto/smooth split wasn't buying anything. All stream auto-scrolls now use `behavior: 'smooth'`.
- **Jump to profile on completion** — on the running → finished transition, smooth-scroll the profile preview section to ~24px below the viewport top. First implementation used `scrollIntoView({block: 'start'})` inside a single `requestAnimationFrame`, but the page consistently overscrolled to the bottom of the profile preview — the section had just mounted and `scrollIntoView` was measuring its top before late-mounting children had finalized layout. Fixed by switching to a double-rAF (guarantees one full paint has completed) + `window.scrollTo` with an explicit `getBoundingClientRect`-based target. Captured `wasFinishedOnMountRef` on first render to skip the jump when the user revisits an already-completed run.

Validation: pill sits flush left with matching whitespace top and bottom; scrolling visibly animates as content streams in (the browser chases the moving end-of-stream); on completion the profile preview slides into view with its title at the top of the viewport; reloading onto a completed run does NOT auto-jump.

**Blocked by:** none

### #42 Next-digest banner on `/app/digests` listing — ✅
The list page at `/app/digests` shows only past digests, with no indication of when the next one arrives or where it'll land. Dogfood iteration 1 (2026-05-16) flagged this as a missed anticipation/engagement moment.

Above the list, render a card or banner:

- **When the next digest arrives.** Computed from the user's TZ + the cron schedule (today: 05:30 UTC daily; per-TZ scheduling lands with #17). Show as "Tomorrow morning, ~6 AM UTC" or "in ~14h" — pick what reads cleanest. Once #17 ships, this becomes the user's actual local delivery time.
- **Where it'll be delivered.** Today: "in-app only" (email send #11 is deferred). Once #11 ships, "in-app + email to you@example.com". Stay honest — don't promise email before #11 lands.
- **Anchor copy.** "Your next brief is on the way — [time, channel]." Or similar; communicate confidence without being cute.

Validation: user with prior digests opens `/app/digests` → banner appears with sensible next-time + "in-app only" channel. After #11 + #17 ship, banner reflects email delivery + per-TZ time with no further changes here.

Out of scope: per-user delivery time customization (folds into #17). Slack/Teams channels (not in roadmap). Empty-digest preview (separate concern).

**Blocked by:** none for the in-app version. #11 + #17 unlock the richer copy.

---

## Email + send + launch (later phase)

### #11 Resend email template + send — ☐
Resend client + a React Email template for the daily digest. **Intentionally distinct from #31's in-app rendering** — the email template is constraint-bound (inline styles, limited CSS, no JS, ~600px width), while the in-app surface uses the full shadcn + Tailwind stack. Both consume `src/design/tokens.ts` so brand stays unified. Props: greeting line, items (tag/headline/snippet/impact), tracking pixel, per-item feedback URLs (`/r/:digest_item_id/up` and `/down`). Configure Resend webhook → server function for open/click events. Reactivate this task after #13 confirms the in-app digest is good — sending bad digests by email is worse than not sending at all.
**Blocked by:** #13

### #17 Per-TZ send scheduling — ☐
pg-boss scheduled job groups users by TZ bucket and dispatches send jobs so each user receives the digest before 08:00 local. Skip users with `status != active`. Idempotent — never send the same `digest_id` twice (unique constraint or processed flag).
**Blocked by:** #11

### #18 Onboard 5–10 real beta users — ☐
Recruit from network. Each goes through `/signup` → agentic FTE → first-digest fast path on their own. Confirm their generated profile + first digest look sane (admin app, #16). Flip status to active if FTE failed for any reason and manually re-run.
**Blocked by:** #13, #16

### #20 PostHog integration for funnel + digest events — ✅
posthog-js on landing route (page views) + posthog-node in server functions and worker. Events: `signup_started`, `fte_completed` (with `competitor_count`, `tool_call_count`, `duration_seconds`), `profile_confirmed`, `digest_rendered_in_app` (with `item_count`), `digest_sent` (when #11/#17 live), `digest_opened` (forwarded from Resend webhook), `digest_feedback` (up/down). Project key via env.

### #19 Launch + monitor first 2 weeks — ☐
First broadcast day. Track open rate, click rate, feedback ratio, FTE completion rate, time-to-first-digest, LLM + Firehose + Firecrawl + web-search cost. Talk to each user at end of week 1. Decide go/no-go against success criteria in `SCOPE.md` §8.
**Blocked by:** #11, #17, #18, #20

### #51 PostHog error tracking + Slack alerts — ✅
Reuse the PostHog wiring from #20 as an error aggregator so unhandled exceptions surface in one place (client + server), with Slack pings for new issues. Avoids standing up a second vendor (Sentry) at PoC scale; trades depth for "errors correlated with the user's funnel state and events."

Concrete deliverables:

- **Client autocapture.** Flip `enable_exception_autocapture: true` in `src/lib/posthog-client.ts` so `window.onerror` + `unhandledrejection` ship stacks via posthog-js. No-op when `VITE_POSTHOG_KEY` is unset.
- **React error boundary.** Wrap the app tree in `__root.tsx` with a `<PostHogErrorBoundary>` that catches render errors, calls `posthog.captureException(err)`, and renders the existing `DefaultCatchBoundary` as fallback. Stays usable without PostHog (catches errors, just doesn't ship them).
- **Server helper.** Add `captureServerException(err, distinctId?, extra?)` to `src/lib/posthog.ts` mirroring `captureServerEvent`'s no-op behavior. Internally calls `posthog.captureException(err, distinctId, extra)`.
- **Wire server captures.** Three spots:
  1. `src/worker/index.ts` — `boss.on('error', …)` already logs; also call `captureServerException`.
  2. `src/agents/fte/agent.ts` — the existing catch block that writes the `error` event also captures.
  3. The `main().catch(…)` at the worker entry — fatal start-up errors get captured before exit.
- **Source maps.** Out of scope for the first cut — production stacks will look minified. Add as a follow-up task once we see what shape errors actually take.
- **Slack subscriptions.** No code. PostHog → Settings → Integrations → install Slack app → subscribe to "New issues" in Error Tracking + a threshold subscription on `fte_completed where finished_reason='error'`. Document the steps in the commit / `.env.example` comment so it's reproducible.

Out of scope:
- A Pino transport that mirrors `logger.error` into PostHog. Tempting, but most useful errors are already thrown (not just logged) — wire explicit captures first; tap Pino if signal is missing.
- Source-map upload via `posthog-cli` in the Railway build.
- Replacing or augmenting Sentry. We're not running Sentry; the trade is "PostHog as the single observability vendor" vs adding a second one.

Validation: throw in a route's loader (e.g. add `throw new Error('test')` to a debug route), hit it, see the issue in PostHog → Error Tracking with the user's funnel events alongside. Repeat on the worker side by raising in a job handler.

**Blocked by:** #20

---

## Dependency graph (top-down)

```
#1 ✅, #2 ✅
 ├── #21 ✅ (design system)
 │    ├── #14   (landing)
 │    ├── #31   (app shell + digest views) ── #25 (debug preview)
 │    │                                    ── #13 (dogfood)
 │    │                                    ── #16 (admin)
 │    │                                    ── #18 (betas)
 │    ├── #29   (FTE flow frontend)
 │    └── #32   (profile edit)
 │
 ├── #26 (auth) ── #28, #29, #31, #32, #16
 ├── #27 (profile schema) ── #28, #32
 │
 └── #28 (FTE agent) ── #29 ── #30 ── #35 ── #13 ── #18 ──┐
                                                           ├── #19 (launch)
                                              #11 ── #17 ──┘

#6 ── #23 (Firehose buffer verify)
```

Tasks #3, #4, #5, #7, #8, #9, #10, #12, #24 have no inter-task blockers — they were ordered by milestone, not strict deps.

## Editing this file

This is the durable copy. If you import to Linear:
1. Each `###` heading becomes an issue title.
2. Body below is the description.
3. Hand-translate "Blocked by:" lines to Linear relations.
4. Apply labels by section.

Retired (deleted from this file, kept in git history):
- #15 — Competitor picker with RSS autodetect (replaced by FTE agent tool, #28)
- #22 — Signup form section on landing page (replaced by `/signup` + agentic FTE, #29)
- #24 — Serve `executive-summary.html` at `/executive-summary` (temporary share path; removed after #14 landed and the React port at `/` became canonical)
