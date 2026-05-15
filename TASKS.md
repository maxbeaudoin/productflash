# Product Flash — PoC Tasks

_Generated 2026-05-13, restructured 2026-05-15 for the agentic-SaaS pivot. Source of truth for active work behind `SCOPE.md`._

**Legend:**
- ☐ pending · ⏳ in-progress · ✅ completed
- **Blocked by:** task must finish first
- **Blocks:** other tasks that wait on this one

## Priority overrides

The default pickup rule is "lowest ID among unblocked tasks". When this section has entries, take them in the order listed instead — they reflect explicit owner priorities that override numeric ordering.

Current focus is the **agentic SaaS + dogfood loop** — single app for marketing, user app, and admin; magic-link auth; agentic FTE writes a user profile (competitors + position + goal) on signup; first digest visible in-app within ~5 minutes. Email send + per-TZ broadcast are deferred until the in-app dogfood loop is clean.

1. **#14** — landing port (`/`)
2. **#26** — Better Auth + magic-link via Resend
3. **#27** — profile schema expansion
4. **#31** — app shell + `/app/digests` list + detail
5. **#25** — debug digest preview (wraps #31's component)
6. **#28** — FTE agent backend
7. **#29** — FTE flow frontend
8. **#30** — fast-path time-to-first-digest
9. **#13** — Maxime full FTE dogfood
10. **#32** — `/app/profile` view + edit
11. **#16** — admin app (`/admin/users/*`)
12. **#11** — Resend email template + send (reactivate after dogfood)
13. **#17** — per-TZ send scheduling
14. **#18** — onboard 5–10 betas
15. **#20** — PostHog wiring
16. **#19** — launch + monitor

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
Use `claude-sonnet-4-6`. Input per user: top-N scored items (drop noise, cap at ~5). Output: per-item headline + snippet + impact_note in Product Flash editorial tone (see `executive-summary.html` digest sample). Persist `digest_items` + `digests`. If fewer than 1 item qualifies, persist an empty-digest record so the send job emits the "nothing notable" template.

### #12 Feedback redirect endpoint — ✅
`GET /r/:digest_item_id/:rating` — records feedback row (upsert on user+item), then redirects to a static thanks page. Validate rating in `{up, down}`. Use a signed token to prevent third-party tampering.

---

## Landing (public marketing)

### #24 Serve executive-summary.html via web route — ✅
Quick share path while the full React port (#14) is blocked. Mount `executive-summary.html` as a TanStack Start route at `/executive-summary` (literal, matches filename, no collision risk with future SaaS surfaces; `/` stays free for #14). Implementation: raw-string import via Vite's `?raw` suffix returned from a server route with `Content-Type: text/html`. The HTML stays at repo root unchanged (still the QA reference for #14).

### #14 Port executive-summary.html to public landing route (1:1 visual) — ✅
Port `executive-summary.html` into TanStack Start route `/` as componentized React. Components: `TopBar`, `Hero`, `ProblemSection` (+ `StatCard` x3), `SolutionSection` (+ `FeatureCard` x4), `DigestPreview` (+ `DigestItem` x3), `AudienceSection` (+ `PersonaCard` x3), `ProofSection`, `CTASection`, `Footer`. Page content (stats, features, personas, sample digest items) extracted to `src/data/landing.ts`. Styled with Tailwind v4 against design tokens — zero custom CSS. **Must look pixel-identical to the original when compared side-by-side.** Original `executive-summary.html` stays at repo root as the QA reference. CTA buttons link to `/signup` (entry point to the agentic FTE in #29).
**Blocked by:** #21

---

## Agentic SaaS + dogfood loop (current focus)

### #26 Better Auth + magic-link via Resend — ☐
Install `better-auth` with the Drizzle adapter against Neon. Enable the email magic-link plugin (delivery via the Resend client; reuse the existing API key, do not introduce a separate "auth email" provider) and the admin-role plugin. Better Auth manages its own session/user/account tables — wire its schema generator + drizzle-kit migration; preserve the existing `users` columns by mapping or namespacing. Expose:
- Server middleware that gates `/app/*` and `/admin/*` routes
- `auth.getSession(request)` helper for server functions
- Minimal `/signup`, `/login`, `/logout` routes (UI is intentionally bare — full FTE entry lives at #29's `/signup`)

The admin-role plugin replaces a hand-rolled `users.is_admin` boolean.
**Blocked by:** #2 · **Blocks:** #28, #29, #31, #32

### #27 Profile schema expansion — ☐
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

### #31 App shell + `/app/digests` list + `/app/digests/:id` detail — ☐
Auth-gated TanStack Start layout under `/app`. Header w/ user menu, sign-out, link to `/app/profile`. Routes:
- `/app` → redirect to `/app/digests`
- `/app/digests` — list of past digests, newest first (date, item_count, one-line peek)
- `/app/digests/:id` — full digest rendered natively with shadcn + brand tokens (NOT the email template — in-app rendering is intentionally higher fidelity than email; the two surfaces diverge by design)

Components: `DigestHeader`, `DigestItem` (matches executive-summary mock), `FeedbackButton` (👍/👎 hits the existing `/r/:digest_item_id/:rating` endpoint). Read-only at this stage — profile edit is #32.
**Blocked by:** #21, #26 · **Blocks:** #13, #16, #18, #25

### #25 Dev digest preview route — ☐
Dev-only variant of `/app/digests/:id` that bypasses auth. Same React components as #31, exposed at `GET /debug/digest/:user_id`. Optional `?refresh=1` query param re-runs `score → synthesize` for the most recent 24h of `raw_items` before render — fast-iteration escape hatch for prompt tuning. Gated by `NODE_ENV !== 'production'` (returns 404 in prod).
**Blocked by:** #31

### #28 FTE agent backend — ☐
pg-boss singleton job per user (`fte:${user_id}`). Anthropic SDK tool-use loop with `claude-sonnet-4-6` as the planner. Tools:
- `web_search_20250305` (Anthropic server tool) — competitor + market research
- `fetch_url(url)` — plain-text extraction of a URL (reuse Firecrawl scrape if richer content is needed)
- `discover_rss(homepage_url)` — wraps the autodetect helper shipped in #5
- `add_competitor({ name, homepage_url, rss_url? })` — upserts `competitors` + `user_competitors`
- `save_profile({ position, ultimate_goal, focus_areas })` — writes back to `users`

Stream every event (model output, tool call, tool result, decision) to a new `fte_events` table keyed by `(user_id, run_id, ts)` with `kind` + `payload jsonb`, so the frontend can replay/tail. Bound the loop by `max_iterations` + `max_tool_calls` to avoid runaways. On exit, flip `users.status` to `'active'` only if `save_profile` was called at least once.
**Blocked by:** #26, #27 · **Blocks:** #29, #30

### #29 FTE flow frontend — ☐
Two routes:
1. **`/signup`** — minimal TanStack Form: `email`, `company_url`, `position`, `ultimate_goal`. Submit → create user (`status='onboarding'`), enqueue #28's job with a fresh `run_id`, send magic link via Better Auth. Redirect to a "check your email" page.
2. **`/app/onboarding`** — auth-gated, first visit after magic-link click. Streams `fte_events` for the user's active run via pg `LISTEN/NOTIFY` (or a polling fallback). UI: terminal-feel event log in JetBrains Mono (one line per event), followed by a profile preview card that hydrates from `users` + `user_competitors`. "Edit" lets the user adjust fields; "Looks good →" calls a server fn that flips `profile_confirmed_at` + `status='active'` and enqueues #30.
**Blocked by:** #21, #26, #28 · **Blocks:** #30

### #30 Time-to-first-digest fast path — ☐
On profile confirmation (from #29), dispatch one-off pg-boss jobs synchronously: `ingest(user_id) → score(user_id) → synthesize(user_id)`. Each is idempotent (on-conflict-do-nothing). Target: first digest at `/app/digests/:id` within ~3–5 minutes of signup. `/app/digests` polls (or subscribes via pg `LISTEN/NOTIFY`) for the first row to land and auto-routes to it.
**Blocked by:** #28 · **Blocks:** #13

### #13 Maxime full FTE dogfood — ☐
Sign up at `/signup` against your own company. Watch the FTE agent run end-to-end at `/app/onboarding`. Read the resulting profile critically: did it identify the right competitors? Right framing of your role + goal? Confirm and check the fast-path digest. Repeat for 3 consecutive days: open the daily digest at `/app/digests/:id`, look for quality, missed items, hallucinations. Tune prompts in #28 / #10 / #9 between runs. **Block real beta launch until 3 clean days in a row.**
**Blocked by:** #30

### #32 `/app/profile` view + edit — ☐
Read current AI-generated profile + allow inline edits: `position`, `company_url`, `ultimate_goal`, `focus_areas`, competitor list. Adding a competitor calls `discover_rss` as a server fn and shows the detected feed for confirmation. Removing a competitor is a soft delete (`user_competitors.removed_at`, keeps the relation row for digest history). Updating `focus_areas` invalidates cached score weights so the next synthesize run reflects new preferences.
**Blocked by:** #26, #27, #31

### #16 Admin app (`/admin/users/*`) — ☐
TanStack Start route at `/admin/*` gated by Better Auth's admin-role plugin (#26). Views:
- `/admin/users` — list with email, status, last digest date, competitor count
- `/admin/users/:id` — profile, recent digests (rendered via #31's components), FTE event timeline (from `fte_events`), button to re-run FTE / re-trigger digest

Used for personal QA + future beta babysitting.
**Blocked by:** #26, #31

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

### #20 PostHog integration for funnel + digest events — ☐
posthog-js on landing route (page views) + posthog-node in server functions and worker. Events: `signup_started`, `fte_completed` (with `competitor_count`, `tool_call_count`, `duration_seconds`), `profile_confirmed`, `digest_rendered_in_app` (with `item_count`), `digest_sent` (when #11/#17 live), `digest_opened` (forwarded from Resend webhook), `digest_feedback` (up/down). Project key via env.

### #19 Launch + monitor first 2 weeks — ☐
First broadcast day. Track open rate, click rate, feedback ratio, FTE completion rate, time-to-first-digest, LLM + Firehose + Firecrawl + web-search cost. Talk to each user at end of week 1. Decide go/no-go against success criteria in `SCOPE.md` §8.
**Blocked by:** #11, #17, #18, #20

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
 └── #28 (FTE agent) ── #29 ── #30 ── #13 ── #18 ──┐
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
