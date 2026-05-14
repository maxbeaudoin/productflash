# Product Flash — PoC Tasks

_Generated 2026-05-13 from in-conversation task list. Source of truth for the 22 work items behind `SCOPE.md`. Can be imported to Linear/GitHub Issues later._

**Legend:**
- ☐ pending · ⏳ in-progress · ✅ completed
- **Blocked by:** task must finish first
- **Blocks:** other tasks that wait on this one

## Priority overrides

The default pickup rule is "lowest ID among unblocked tasks". When this section has entries, take them in the order listed instead — they reflect explicit owner priorities that override numeric ordering.

_None currently._

---

## Foundation (do first)

### #1 Init TanStack Start + Railway + Postgres + Pino — ✅
Bootstrap TanStack Start (pnpm). Install Drizzle + drizzle-kit, pg-boss, Pino, posthog-node, `@anthropic-ai/sdk`, resend, react-email. Create Neon project (with a `main` branch for prod and `dev` branch for migrations). Create Railway project with two services: web (TanStack Start) + worker (long-running pg-boss host). Wire env config (Neon `DATABASE_URL`, Anthropic, Firehose, Firecrawl, Resend, Product Hunt, PostHog). Implement `/healthz` that proves DB is reachable. Set up Pino structured logging baseline.
**Blocks:** #21

### #2 Define schema + Drizzle migrations — ✅
Implement schema per `SCOPE.md` §5: `users`, `competitors`, `user_competitors`, `raw_items` (unique on `source+source_id`), `digest_items`, `digests`, `feedback`. Write initial migration, seed script for a handful of known competitors.

### #21 Design system foundations (tokens + Tailwind v4 + shadcn + fonts) — ☐
Create `src/design/tokens.ts` mirroring `executive-summary.html` CSS variables (ink/paper/accent/coral palette, font families, radii). Configure Tailwind v4 `@theme` to consume tokens. Run `npx shadcn@latest init` with Base UI primitives. Install components: button, input, label, form, combobox, dialog, toast, select. Add Lucide. Self-host Inter + JetBrains Mono via `@fontsource`. Prereq for all UI work and email template.
**Blocked by:** #1 · **Blocks:** #11, #14, #15, #16

---

## Week 1 — Ingestion pipeline

### #5 RSS source adapter — ✅
Wrap a feed parser. Input: competitor + `rss_url`. Output: normalized `raw_item` rows. Handle malformed feeds, missing `pubDate`, dedupe via guid/link. Includes an autodetect helper that tries `/feed`, `/rss`, `/changelog.rss`, `/blog/feed` for a given homepage URL — used by signup.

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

### #8 Seed competitors + validate end-to-end ingestion — ☐
Seed 5 real competitors (mix of analytics/CRM/devtools SaaS). Run ingestion locally end-to-end. Eyeball `raw_items` — confirm signal is real and dedupe holds across 2 consecutive runs.

---

## Week 2 — Synthesis + delivery

### #9 Anthropic SDK + classify-and-score job (Haiku) — ☐
Wire `@anthropic-ai/sdk` with `claude-haiku-4-5-20251001`. Prompt: given a `raw_item` (title + body excerpt), output JSON `{ category: launch|pricing|feature|positioning|noise, score: 0-100, why: string }`. Batched per user (only items for that user's competitors, last 24h). Persist scores.

### #10 Synthesis job (Sonnet) → digest_items + digests — ☐
Use `claude-sonnet-4-6`. Input per user: top-N scored items (drop noise, cap at ~5). Output: per-item headline + snippet + impact_note in Product Flash editorial tone (see `executive-summary.html` digest sample). Persist `digest_items` + `digests`. If fewer than 1 item qualifies, persist an empty-digest record so the send job emits the "nothing notable" template.

### #11 Resend integration + email template — ☐
Resend client + React Email template matching the executive-summary digest mock. Import design tokens (`src/design/tokens.ts`) and apply as inline styles — brand identical to web surfaces. Props: greeting line, items (tag/headline/snippet/impact), tracking pixel, per-item feedback URLs (`/r/:digest_item_id/up` and `/down`). Configure Resend webhook → server function for open/click events.
**Blocked by:** #21

### #25 Dev digest preview route — ☐
Fast-iteration escape hatch so we don't have to wait for the daily email loop to tweak prompts or template. Unprotected debug route `GET /debug/digest/:user_id` that:
1. Loads the most recent `digests` + `digest_items` for the given user (or runs the score→synthesize pipeline on demand for the last 24h of `raw_items` if `?refresh=1` is passed).
2. Renders the React Email template to HTML server-side and returns it inline with `Content-Type: text/html`.
3. Gated by `NODE_ENV !== 'production'` — returns 404 in prod so an accidental deploy doesn't leak digest content.

The template used here is a minimal v0 — just structure (greeting, item list with tag/headline/snippet/impact). Brand styling against design tokens is #11's job; this route will pick up the polished template automatically once #11 lands. No auth, no email send, no feedback URLs needed for the debug path.
**Blocked by:** #9, #10

### #12 Feedback redirect endpoint — ☐
`GET /r/:digest_item_id/:rating` — records feedback row (upsert on user+item), then redirects to a static thanks page. Validate rating in `{up, down}`. Use a signed token to prevent third-party tampering.

### #13 Dogfood: send 3 days of digests to one hand-onboarded user — ☐
Hand-create one user (yourself or a willing tester), 5 competitors. Run the full pipeline for 3 consecutive days. Eyeball each digest for quality, missed items, hallucinations. **Block real beta launch until 3 clean days in a row.**

---

## Week 3 — Onboarding + launch

### #24 Serve executive-summary.html via web route — ✅
Quick share path while the full React port (#14) is blocked. Mount `executive-summary.html` as a TanStack Start route at `/executive-summary` (literal, matches filename, no collision risk with future SaaS surfaces; `/` stays free for #14). Implementation: raw-string import via Vite's `?raw` suffix (e.g. `import html from '../../executive-summary.html?raw'`) returned from a server route with `Content-Type: text/html` — keeps the URL clean and bundles the file into the build so Railway deploys carry it. The HTML stays at repo root unchanged (still the QA reference for #14). No componentization, no design-token wiring — that's #14's job. Verify by loading the route in `pnpm dev` and visually comparing to opening `executive-summary.html` directly: must look identical.

### #14 Port executive-summary.html to public landing route (1:1 visual) — ☐
Port `executive-summary.html` into TanStack Start route `/` as componentized React. Components: `TopBar`, `Hero`, `ProblemSection` (+ `StatCard` x3), `SolutionSection` (+ `FeatureCard` x4), `DigestPreview` (+ `DigestItem` x3), `AudienceSection` (+ `PersonaCard` x3), `ProofSection`, `CTASection`, `Footer`. Page content (stats, features, personas, sample digest items) extracted to `src/data/landing.ts`. Styled with Tailwind v4 against design tokens — zero custom CSS. **Must look pixel-identical to the original when compared side-by-side.** Original `executive-summary.html` stays at repo root as the QA reference. CTA buttons are placeholder anchors at this stage — signup form is #22.
**Blocked by:** #21 · **Blocks:** #22

### #15 Competitor picker with RSS autodetect — ☐
React component in signup flow using shadcn combobox: typeahead against existing competitors table via server function. If not found, accept a homepage URL and run the RSS autodetect helper server-side. Show detected feed for user confirmation. Create new competitor records as needed. TanStack Form integration for validation.
**Blocked by:** #21 · **Blocks:** #22

### #22 Signup form section on landing page — ☐
Layer a signup form section into the landing page (#14) — replaces/extends the CTA section. TanStack Form + Zod: email + name + TZ + 3-10 competitors (using competitor picker from #15). Server function persists user (status: pending), queues competitor records, fires PostHog `signup_completed` event. Success state renders a confirmation inside the same page.
**Blocked by:** #14, #15

### #16 Admin preview view — ☐
TanStack Start route at `/admin/*` protected by env-based basic auth. List users, click into today's digest preview rendered via the React Email template (same component used for actual sends). Spot-check quality before per-TZ send job fires. Uses design tokens + shadcn components.
**Blocked by:** #21

### #17 Per-TZ send scheduling — ☐
pg-boss scheduled job groups users by TZ bucket and dispatches send jobs so each user receives the digest before 08:00 local. Skip users with `status != active`. Idempotent — never send the same `digest_id` twice (unique constraint or processed flag).

### #20 PostHog integration for funnel + digest events — ☐
posthog-js on landing route (page views) + posthog-node in server functions and worker. Events: `signup_completed` (with `competitor_count`, `source_breakdown`), `digest_sent` (with `item_count`), `digest_opened` (forwarded from Resend webhook), `digest_feedback` (up/down, on `/r/:item/:rating`). Project key via env.

### #18 Onboard 5-10 real beta users — ☐
Recruit from network. Walk each through signup. Confirm their competitors have at least one usable source (RSS or PH presence). Flip status to active.

### #19 Launch + monitor first 2 weeks — ☐
First broadcast day. Track open rate, click rate, feedback ratio, LLM + Firehose + Firecrawl cost. Talk to each user at end of week 1. Decide go/no-go against success criteria in `SCOPE.md` §8.

---

## Dependency graph (top-down)

```
#1 (init)
 └── #21 (design system)
      ├── #11 (email template) ──── #25 (debug digest preview, also needs #9 #10)
      ├── #14 (landing port) ──┐
      ├── #15 (competitor picker) ──┐
      │                              ├── #22 (signup form)
      └── #16 (admin preview)

#9 + #10 (classify + synthesize) ──── #25 (debug digest preview)
#6 ──── #23 (verify Firehose buffer)
```

Tasks #2–#10, #12–#13, #17–#20, #24 have no inter-task blockers — order is driven by milestone (or by the priority overrides section above), not strict deps.

## Editing this file

This is the durable copy. If you import to Linear:
1. Each `###` heading becomes an issue title.
2. Body below is the description.
3. Hand-translate "Blocked by:" lines to Linear relations.
4. Apply labels by milestone (Week 1 / Week 2 / Week 3).
