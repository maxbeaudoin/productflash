# Changelog

Product Flash — what we've shipped, framed for the people who use it.

> Format follows [Keep a Changelog](https://keepachangelog.com/). Dates are when work landed on `main`. This is a product changelog, not a git log — items that didn't ship user-visible value (refactors, infra plumbing) aren't listed here.

---

## Pre-launch — private beta (May 2026)

The PoC. Invite-only; we're validating with 5–10 beta users before opening the waitlist.

### Added

**The agentic first-time experience.** Sign up with an invite link and an AI agent runs end-to-end while you watch: it reads your company's homepage, identifies your real competitors, figures out where to track each one (RSS, Product Hunt, pricing pages), and writes a first draft of your profile — your role, company, ultimate goal, and the themes you want amplified in your brief. You can edit anything before confirming.

**Your first brief within five minutes.** The moment you confirm your profile, we start pulling the last week of news from each competitor in parallel and synthesize a "catch-up brief" of up to 10 items, capped at 3 per competitor so one noisy launch doesn't drown out everyone else. A "Brewing your first brief" screen counts up while it works.

**Personalized to you, not the category.** The brief isn't a generic news roundup. Your role, your goal, and your focus areas are threaded into both the scoring step (which items rise to the top) and the synthesis step (how each item is framed) — so an enterprise pricing change reads differently for a Head of Product at a 50-person SaaS than it does for a founder in a different segment.

**Truthful timestamps.** Each item shows when it actually happened ("May 14 · 2 days ago") when the source tells us. When we don't know, we say nothing — no "today" or "recently" fillers, no fabricated dates.

**Daily email at 7 AM your time.** Mon–Fri at your local 7 AM (we detect your timezone at signup). Monday's brief automatically catches you up on Friday, Saturday, and Sunday so weekend ingestion doesn't disappear. Weekends stay quiet — no email if nothing notable shipped.

**A "next brief" preview.** The brief list page shows when your next one arrives and where it'll land. Today: "in-app only." Once email is on for your account: "in-app + email to you@example.com." We won't promise what we haven't built.

**Up/down feedback on every item.** Tap 👍 or 👎 inline (in-app or in the email — same link, signed so nobody can spoof your ratings). Feedback is the channel by which the brief learns what resonates.

**Profile + competitor management.** A `/app/profile` page lets you edit your role, goal, and focus areas any time, and add or remove competitors. New competitors are RSS-auto-detected the moment you add them.

**The public landing.** A real `productflash.ai` website explaining what the product is, who it's for, and a live sample brief — built from the same design tokens as the in-app experience, so the marketing site and the actual product look like the same product.

**Waitlist with invite issuance.** No self-serve signup during private beta. Visitors join a waitlist (email, role, company URL); an admin issues a cryptographically-signed invite link per person. The signup form pre-fills what you told us on the waitlist, so you're not retyping anything.

**One-step sign-in.** Once invited, clicking your invite link, filling the form, and submitting drops you straight into the product — no "check your inbox" detour. Returning users get a magic link (or Google SSO) at `/login`.

### Improved

**The agent's thinking now reads like a story, not a log.** Each paragraph the agent emits is a narrative observation written in third-person ("Workleap is a manager enablement platform focused on…"), capped at one or two sentences. No internal reasoning ("Good — let me check…"), no summaries before saving, no recapping the competitor list you can already see below.

**Streaming UI that doesn't flicker.** During the agent's run, paragraphs land cleanly: no disappear-and-reappear, no markdown popping in seconds late, no flashing live cards. The "what is the agent doing right now?" status sits at the bottom of the stream and auto-scrolls into view as the conversation grows. Manual scroll-up freezes the follow until you return.

**On completion, the page eases you to your finished profile** with a smooth scroll, instead of dumping you at the bottom. Reload onto a finished run? It just shows you the result — no surprise auto-scroll.

**Brief diversity.** A high-volume competitor used to monopolize all five item slots. Now we cap at 2 items per competitor on daily briefs (3 on the catch-up brief), with a second pass that backfills if you genuinely only had news from one or two competitors that day.

**Catch-up framing.** The first brief explicitly reads "Your catch-up brief — past 7 days"; subsequent briefs read as daily. No misleading "five things that mattered overnight" header on the 7-day version.

**Faster delivery.** When you confirm your profile, the brief generation pipeline runs in the background scoped just to you — you don't wait for the next daily cron.

**Admins go to the admin app, not onboarding.** Admin users hitting `/app` are routed directly into operator tools instead of the user-facing FTE flow.

### Fixed

**The brief no longer hallucinates dates.** Earlier prototypes filled missing publication dates with "today" or the current date. Items now show a timestamp only when the source provided one.

**Streaming step counter is stable.** The number of cards in the agent's thinking stream now grows monotonically instead of jumping forward and then collapsing back when the agent saves your profile.

### Reliability

**Error tracking with team alerts.** Unhandled exceptions in the browser and on the server now flow into our error tracker with the user's funnel state attached, and the on-call team gets a Slack ping when a new issue appears.

---

## Coming up

The active backlog lives in [Linear](https://linear.app/) (team: ProductFlash). The next user-visible items in priority order:

- **Onboarding 5–10 real beta users.** The empirical test of whether the agentic flow lands on someone other than us.
- **Admin feedback feed + per-source rollups.** So we can see which sources and item categories the cohort consistently likes (and which they skip).
- **Optional "what was wrong with this?" comment on 👎.** Free-text follow-up to upgrade a binary signal into something actionable.
- **Feedback as a synthesis signal.** Your disliked items feed back into the synthesis prompt, so the brief learns what to avoid for you specifically.
- **Launch + monitor.** First broadcast day; track open rate, click rate, feedback ratio, FTE completion rate, and time-to-first-digest for two weeks.
