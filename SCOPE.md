# Product Flash — PoC Scope & Plan

_Draft: 2026-05-13 · Owner: Maxime · Target first send: ~2026-06-03_

## 1. Goal

Validate that product leaders in SaaS will open, read, and rely on a daily personalized competitive-intel email. Concretely: prove that 5–10 beta users open the digest ≥3 days/week and react (👍/👎) on items they find load-bearing.

This is a **demand-validation PoC**, not a feature-complete MVP. Everything below is sized to that goal.

## 2. Scope

### In scope (v1)

- **Single pillar**: competitor moves only — launches, pricing changes, feature releases, positioning shifts.
- **Per-user personalization**: each user picks 3–10 competitors at signup.
- **Email-only delivery**: one daily digest, sent before 08:00 local time per user.
- **Public signup**: landing page + self-serve competitor picker (typeahead + RSS autodetect).
- **Thumbs up/down feedback**: one-click links in every digest item.
- **Internal admin preview**: see today's digest per user before send.

### Out of scope (deferred)

- Market signal pillar (funding, M&A, analyst coverage)
- Voice-of-customer pillar (G2, Capterra, Reddit, X)
- Slack delivery
- LinkedIn / X scraping
- Weekly trend roll-up
- Billing — beta is free for 90 days
- Multi-org / team accounts

## 3. Sources (priority order)

| # | Source | Why | How |
|---|--------|-----|-----|
| 1 | RSS (changelog/blog) | Highest signal-to-noise; most SaaS publishes one | Per-competitor RSS URL stored in DB; autodetect at signup |
| 2 | Product Hunt API | Free, public, great for launch detection | Match by competitor slug / name |
| 3 | Firehose API ([docs](https://firehose.com/api-docs)) | Broader news + post coverage | Per-competitor query, batched |
| 4 | Firecrawl ([docs](https://docs.firecrawl.dev/api-reference/introduction)) | Catch pages without RSS (pricing, marketing) | Daily pricing-page scrape + diff |

**Policy**: prefer existing APIs/services over custom crawlers. No bespoke scraping unless Firecrawl can't handle it.

## 4. Architecture

- **Runtime**: Node.js + TypeScript
- **Framework**: TanStack Start — full-stack React; routes for landing, signup, admin preview, feedback redirect; server functions for form handling and job triggers
- **ORM**: Drizzle
- **DB**: Postgres (Neon — chosen for pgvector availability + branching for safe migrations; auto-suspend is irrelevant for cron-driven workloads)
- **Queue + cron**: pg-boss — Postgres-backed job queue + cron scheduling + retries; runs in our long-running worker. Railway's native cron is available as an escape hatch but not used.
- **LLM**: Anthropic SDK (`@anthropic-ai/sdk`) — direct, no abstraction layer
  - `claude-haiku-4-5-20251001` — per-item classify + score (high fan-out, cheap)
  - `claude-sonnet-4-6` — final digest synthesis (per user, once a day)
- **Email**: Resend + React Email templates
- **Analytics**: PostHog cloud — signup funnel + per-event tracking
- **Logging**: Pino structured JSON → Railway logs
- **Hosting**: Railway (single TanStack Start app + worker process), Neon Postgres

### 4.1 Frontend & design system

Brand carries through from `executive-summary.html` — same color tokens, same typography, same editorial feel.

- **Tokens module**: `src/design/tokens.ts` exports raw values for colors, spacing, fonts, radii.
  - Colors: `ink: #0a0a0f`, `ink-soft: #15151c`, `ink-line: #1f1f2a`, `paper: #fafaf7`, `paper-warm: #f4f3ee`, `text: #1a1a22`, `text-muted: #5a5a6a`, `accent: #d9ff3a`, `accent-warm: #ffd60a`, `coral: #ff5b3a`.
  - Fonts: `Inter` (400–900), `JetBrains Mono` (400/500). Self-hosted via `@fontsource` to avoid runtime Google Fonts fetch.
  - Radii: cards 16px, large cards 20px, buttons 999px (pill).
- **Styling**: Tailwind v4. Tokens module wired into `@theme` block — `bg-ink`, `text-accent`, etc. work natively.
- **Components**: shadcn/ui CLI-installed, configured to use Base UI primitives instead of Radix. Components to install: `button`, `input`, `label`, `form`, `combobox` (competitor picker), `dialog`, `toast`, `select`.
- **Forms**: TanStack Form + Zod. Schemas shared between client validation and server function input parsing.
- **Icons**: Lucide.
- **Email**: React Email components import the same tokens module and apply values as inline styles (email clients require inline styles; Tailwind classes don't render in clients). One source of truth for brand across web + email.

### 4.2 Landing page

The marketing page is a real product surface, not throwaway HTML. Plan:

- `executive-summary.html` stays in the repo root untouched as the visual reference for QA comparison.
- Port to a TanStack Start route (`/`) as componentized React: `<TopBar>`, `<Hero>`, `<ProblemSection>`, `<SolutionSection>`, `<DigestPreview>`, `<AudienceSection>`, `<ProofSection>`, `<CTASection>`, `<Footer>`. Sub-components like `<StatCard>`, `<FeatureCard>`, `<PersonaCard>`, `<DigestItem>` are reusable building blocks.
- Page content (stats, features, personas, sample digest items, proof checklist) lives in `src/data/landing.ts` — editable as data, not markup.
- Styled exclusively via Tailwind v4 classes backed by design tokens (no per-component CSS files). Must look pixel-identical to the original when opened side-by-side.
- The signup form section is layered in afterward as its own task — same page, separate concern.

## 5. Data model (sketch)

```
users            (id, email, name, tz, created_at, status)
competitors      (id, name, homepage_url, rss_url, ph_slug, pricing_url, created_at)
user_competitors (user_id, competitor_id)
raw_items        (id, competitor_id, source, source_id, url, title, body, published_at, ingested_at)
                 -- unique (source, source_id) for dedupe
digest_items     (id, user_id, raw_item_id, category, headline, snippet, impact_note, score, digest_id)
digests          (id, user_id, sent_at, opened_at, item_count)
feedback         (id, digest_item_id, user_id, rating /* up|down */, created_at)
```

## 6. Daily pipeline

| Time (UTC) | Job | What it does |
|---|---|---|
| 04:00 | `ingest` | Fan out per competitor → pull RSS, PH, Firehose, Firecrawl → insert `raw_items` w/ dedupe |
| 05:00 | `score` | For each user, take last-24h items for their competitors → Haiku classifies + scores |
| 05:30 | `synthesize` | Sonnet writes headlines/snippets/impact for top-N items per user → persist `digest_items` + `digests` |
| Per-TZ ≤08:00 local | `send` | Resend email out; embed tracking pixel + feedback URLs |
| async | `feedback` | `/r/:digest_item_id/:rating` records and redirects |

## 7. Milestones

### Week 1 — Skeleton + ingestion
Repo, Fly + Postgres + Redis, schema, all 4 source adapters, per-competitor ingestion job, dedupe. Verify with 3–5 seeded competitors.

### Week 2 — Synthesis + delivery
Anthropic SDK + prompts (classify, synthesize), per-user digest assembly, Resend integration, email template, feedback endpoint. Dogfood: send digest to one hand-onboarded user; eyeball quality for 3 days.

### Week 3 — Onboarding + launch
Public landing + signup form (re-use executive-summary.html as styling base), competitor picker w/ RSS autodetect, admin preview view, per-TZ send scheduling. Onboard 5–10 real users. First broadcast day.

## 8. Success criteria (decide go/no-go after 2 weeks of live sends)

- ≥60% open rate across cohort
- ≥30% of items receive any thumbs reaction
- ≥3 of 5–10 users explicitly say "keep sending it"
- <5% missed-launch rate vs. user's own knowledge of their competitors

## 9. Risks

- **Synthesis quality kills opens fast.** Mitigation: 3-day private dogfood window before any real-user send.
- **Quiet competitors look like broken product.** Mitigation: when no items meet threshold, send "we saw nothing notable" — never a blank email.
- **Firehose / Firecrawl quotas.** Track from day 1. Batch per-competitor (not per-user) so cost scales with competitor cardinality, not user count.
- **LLM cost.** Per-user/day estimate: Haiku classify ~$0.001 + Sonnet synth ~$0.02 ⇒ <$10/mo at 10 users. Sanity-check after week 2.
- **Time-zone send-time bugs.** Keep dead simple: TZ at signup, bucket users by TZ, dispatch per bucket.
