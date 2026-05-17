# First-Time Experience (FTE) — from zero to your first digest

A walkthrough of the Product Flash onboarding flow as a brand-new user
sees it. End state: you've confirmed an AI-generated profile and
you're reading your first digest at `/app/digests/:id`.

**Who this is for:**

- **Maxime, dogfooding (#13)** — a reference you can read top-to-bottom
  before each run instead of re-reading the codebase, plus reflection
  prompts and a known-gaps list so you spend time _judging_ the
  experience instead of _remembering_ it.
- **Beta babysitting (#18 onwards)** — share with a confused beta user
  to unstick them without a live walk-through.
- **Future-you** — keep this current as the FTE evolves; if you change
  a step's behavior in code, change the matching section here in the
  same PR. The file→section map at the bottom is how you find what to
  edit.

Expected total time: **5–8 minutes of active attention**, plus however
long it takes an admin to issue your invite.

---

## Setup — log in as admin (one-time, dogfood prep)

To dogfood end-to-end you need to wear two hats: **admin** (issues the
invite from `/admin/waitlist`) and **user** (walks through Steps 1–10
with a fresh inbox).

### 1. Grant yourself the admin role

There's no seed script — `users.role` defaults to `'user'` and the
admin plugin checks `role === 'admin'` (`src/lib/auth-server.ts:29`).
You promote yourself once, manually.

If you don't already have a `users` row for your admin email, create
one by signing in first (Step 2 below), then promote, then sign in
again — Better Auth re-reads `role` on session creation.

```sh
# easiest: Drizzle Studio
pnpm db:studio
# → opens https://local.drizzle.studio in your browser
# → open `users` → find your row → set role = 'admin' → save

# or psql against DATABASE_URL
psql "$DATABASE_URL" -c "UPDATE users SET role = 'admin' WHERE email = 'you@example.com';"
```

Verify: visit `/admin/waitlist` — if you land on the page, you're in.
If you're bounced to `/app/digests`, the role didn't stick (check you
hit the right row and that you re-signed-in after the update).

### 2. Sign in as admin

There's no separate admin login UI. The same magic-link form at
[`/login`](https://productflash.io/login) handles both:

1. Open `/login`.
2. Enter your admin email.
3. Click **Send magic link**.
4. Open the email, click the link from the same browser.
5. You land on `/app` (admins are users too — admin status is
   additive, not exclusive).
6. Navigate to `/admin/waitlist` manually — there's no header link to
   it from `/app` (intentional; the admin nav lives under `/admin/*`).

If you also want the user app shell visible while signed in as admin,
just navigate between `/app/*` and `/admin/*` freely — same session
gates both.

### 3. Dogfood prep — use a fresh email for the user side

Once you're signed in as admin, **don't dogfood as your admin email**.
Two reasons:

- Your admin user row likely already has `profile_confirmed_at` set,
  so `/signup` will upsert without flipping you back to `'onboarding'`,
  and `/app/index.tsx` will route you straight to `/app/digests` —
  you'd skip Steps 6–9 entirely.
- You want a clean event timeline + clean `competitors` join + clean
  first-digest brewing state for each dogfood run.

The clean recipe:

1. **As admin user (logged in):** open `/` in a normal tab, submit the
   waitlist form with a fresh email — e.g. `you+dogfood-2026-05-16@…`
   (Gmail/most providers route `+suffix` to your main inbox, so you
   keep one mailbox while getting a fresh `users` row).
2. **Still as admin:** open `/admin/waitlist`, find the row, click
   **Invite**, copy the URL.
3. **In a different browser, incognito window, or after `/logout`:**
   open the invite URL. From here you're the user — proceed to Step 4
   of the main flow.

Why a different browser/incognito: magic links are tied to the
browser session that requested them. If you're still logged in as
admin in the same browser, clicking the user's magic link will sign
you in as the user _but the admin session may interfere with the
post-click redirect._ Cleanest is a fully separate session.

**Tearing down between runs:** do it in Drizzle Studio (`pnpm
db:studio`) — no script to maintain.

1. Open the `users` table, filter `role != 'admin'`, select all,
   delete. Cascades handle `sessions`, `accounts`, `user_competitors`,
   `digests`, `digest_items`, `item_scores`, `fte_events`, `feedback`
   automatically (see `src/db/schema.ts` for the FK map).
2. Open the `waitlist` table, delete any rows for dogfood emails (no
   FK to users, so they don't cascade).

What survives — and you _want_ to survive: `competitors`, `raw_items`,
`competitor_pricing_snapshots`. The next FTE run reuses these via the
`homepage_url` unique constraint instead of re-researching and
re-ingesting, which saves the expensive web-search + Firehose +
Firecrawl round.

**Don't nuke users while a job is in flight.** If the FTE agent or
fast-path job is mid-run, the next tool call explodes because
`user_id` no longer exists. Wait for `run_finished` in
`/admin/users/:id` (or for the digest to land), then teardown.

---

## Step 1 — Join the waitlist

**Where:** [`/`](https://productflash.io) → scroll to any `Join the waitlist` CTA (hero, mid-page, footer).

The public funnel is invite-only. You can't reach `/signup` directly; a
bare `/signup` shows an invite gate that points you back here.

1. Click **Join the waitlist** (or scroll to the `#waitlist` form in the
   CTA section).
2. Fill in:
   - **Email** (required) — the address the invite + magic link will land at.
   - **Role** (optional) — free-text with suggestions (Head of Product,
     PM, Product Marketing, Founder / CEO); type anything that fits.
   - **Company URL** (optional) — bare domains work (`acme.com`); the
     server normalizes the value and runs a short HEAD verify to capture
     the canonical URL. If verification fails (timeout, bot block, 4xx),
     we silently store the normalized form so the form never punishes
     the visitor for a flaky upstream. Strict policy: http(s) only,
     real domains only — ports, IP literals, `localhost`, credentials,
     and non-http(s) schemes (`mailto:`, `javascript:`, …) are all
     rejected as suspicious before the row is written.
3. Submit. You'll see _"Got it — we'll be in touch"_ inline. No
   confirmation email is sent at this stage.

**Behind the scenes:** the form POSTs to `/api/waitlist`, which inserts
a row into `waitlist` (or silently no-ops on duplicate email).

**What can go wrong:**

- _"Couldn't reach the server"_ — network blip; retry.
- _"That doesn't look like a URL — try something like acme.com."_ inline
  under the Company URL field — fires only when the input has no TLD
  (e.g. `acme` alone). Add a `.com` or similar.
- _"That email doesn't look right"_ — typo in the email; fix and resubmit.
- Re-submitting the same email looks identical to a first submit; that's
  by design — admins see one row.

---

## Step 2 — Wait for an invite (admin step)

**Where you wait:** your inbox. **Where the admin works:** `/admin/waitlist`.

There is no auto-invite yet. An admin (today: Maxime) reviews the
waitlist and clicks **Invite** on your row. That:

- Stamps `waitlist.invited_at = now()`.
- Signs a token (HMAC over `waitlist.id + email + issuedAt`).
- Surfaces a URL like `https://productflash.io/signup?invite=<token>`.

The admin sends that URL by whatever channel makes sense — email,
Slack, DM. (Resend auto-send via #11 is a future task.)

**If you're dogfooding yourself:** open `/admin/waitlist`, click your
own row's Invite button, copy the URL, paste into a new tab.

**What can go wrong:**

- _Lost the link?_ Ask the admin to click Invite again — it re-signs a
  fresh token; the old one is invalidated when re-issued.
- _URL is malformed or truncated?_ The signup page will show the gate.
  Get a clean re-issued link.

---

## Step 3 — Open the invite link

**Where:** `https://productflash.io/signup?invite=<token>`

The page verifies the token server-side (`INVITE_TOKEN_SECRET`). Three
outcomes:

| State                   | What you see                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| Valid token             | The FTE intake form, email field locked to the address the invite was issued to. |
| Missing/empty `?invite` | The invite gate: _"Private beta, by invite."_ + a link back to the waitlist.     |
| Bogus or tampered token | Same gate as missing.                                                            |

If you see the gate when you expected the form, the token didn't verify
— ask for a fresh one.

---

## Step 4 — Tell us who you are (4 fields)

**Where:** `/signup` (with valid invite).

You fill four fields:

1. **Email** — read-only, locked to the invite payload.
2. **Company URL** — `https://yourcompany.com`. The agent uses this as
   the root of its research.
3. **Your role** — free text. Examples: `Head of Product`, `PM Lead at
ACME`, `Founder/CEO`. Used both for personalized scoring (#35) and
   to brief the FTE planner.
4. **What's your goal** — one sentence. Example: _"Catch every
   competitor launch and pricing change so I can react before my CEO
   asks."_ Load-bearing — this drives both what the agent researches
   and how the Sonnet synthesizer frames `impact_note` later.

Click **Start onboarding**.

**What happens server-side, in one request:**

1. The token is re-verified.
2. A `users` row is upserted with `status='onboarding'` + your seed
   fields.
3. The FTE agent run is enqueued on pg-boss (`fte:${user_id}`,
   singleton — double-clicking is a no-op).
4. A magic-link email is dispatched via Better Auth + Resend.

You'll see the _Onboarding running_ card: _"Check your inbox."_

**What can go wrong:**

- _"This invite link looks invalid or expired"_ — token didn't verify
  on submit. Probably you opened the page with a valid token, then it
  was re-issued. Reload the latest URL.
- _"The magic-link email didn't go through"_ — Resend hiccup; click
  submit again. The user row + the agent run are already in flight, so
  retry only re-sends the email.

---

## Step 5 — Click the magic link

**Where:** your inbox.

Sender: `hello@productflash.io` (Resend). Subject mentions Product
Flash. Click the link **from the same browser** you submitted the form
in — magic links are tied to the session that requested them.

- Link expires in ~5 minutes.
- If it expires, re-run Step 4 with the same invite URL — that
  re-sends the magic link and re-uses the in-flight FTE run.

You land on `/app`, which immediately redirects to `/app/onboarding`
(because your `profile_confirmed_at` is still null).

---

## Step 6 — Watch the agent think

**Where:** `/app/onboarding`.

While you were checking email, the FTE agent has been working. The
page now shows:

- **Header:** _"Your AI analyst is thinking…"_ with a live pulse dot.
- **Progress chips:** counters for `pages read`, `web searches`,
  `competitors`, and `elapsed` — fill in as tool calls complete.
- **Thinking stream:** numbered cards (`01`, `02`, …), one per
  `planner_text` event. The currently-streaming thought renders with a
  typewriter effect and an _"thinking"_ badge.

You can leave the tab open and watch, or close it and come back — the
page loader replays the full event history when you return, and the
SSE stream tails any new events via per-user Postgres `LISTEN`/`NOTIFY`.

Typical run: **60–120 seconds**, 3–6 thinking cards, 2–5 web searches,
3–8 pages read, 3–6 competitors added. If you go past 3 minutes with
no progress, something's wedged (see Troubleshooting).

**What the agent is doing under the hood** (read-only, not surfaced
here — see `/admin/users/:id` for the raw event log):

- `web_search` your company name + space.
- `fetch_url` your homepage + any competitor pages it discovers.
- `discover_rss` to find changelog/blog feeds per competitor.
- `add_competitor` for each one that looks load-bearing.
- `save_profile` to write back `position`, `ultimate_goal`,
  `focus_areas`.

---

## Step 7 — Review the profile preview

**Where:** still `/app/onboarding`, after `run_finished` arrives.

The header flips to _"Your AI analyst is ready."_ and a **Profile
preview** card reveals below:

- **Role** — what it inferred from your input + research.
- **Company** — name (often refined from the URL).
- **Goal** — usually a tightened version of what you typed.
- **Focus areas** — 3–6 chips (e.g. `pricing`, `ai-features`,
  `enterprise`).
- **Competitors** — list with homepage URL + an `rss` badge when a
  feed was auto-detected.

**Read it critically.** This is the highest-leverage moment of the
whole flow — every future digest is scored and framed against these
fields (see #35). Things to check:

- **Wrong role?** Click **Edit profile fields**, fix, save.
- **Missing focus area you care about?** Edit, add as comma-separated
  tag.
- **Competitor missing?** Click **+ Add** in the Competitors list; the
  inline form auto-detects RSS on submit.
- **Competitor that doesn't actually compete with you?** Click `×` on
  the row to remove.

Editing the profile invalidates this user's cached `item_scores`, so
the next score run re-classifies against the fresh profile (#35).

---

## Step 8 — Confirm

**Where:** the **Looks good →** button at the bottom of the profile
card.

This stamps `profile_confirmed_at = now()` + flips your status to
`'active'` + enqueues a `fast-path-run` pg-boss job that runs the
`ingest → score → synthesize` chain for just your user (#30). The job
is singleton on `user_id`, so double-clicking the button is harmless.

You're navigated to `/app/digests`.

**Safety net:** if the fast-path enqueue fails for any reason (queue
down, network blip), `confirmProfile` still returns ok and you land on
the digests list. The 05:30 UTC daily synthesis cron will pick you up
the next morning regardless.

---

## Step 9 — Brewing the first digest

**Where:** `/app/digests`.

If you have zero digests (you will, immediately after step 8), the
page shows a _"Brewing your first brief"_ card with a live elapsed
counter. It polls the loader every 4 seconds.

Expected wait: **1–5 minutes**. Breakdown:

- Per-user RSS + Firecrawl + Firehose ingestion: ~30–60s.
- Haiku classification fan-out: ~15–30s.
- Sonnet synthesis: ~30–60s.

When the first digest row lands, the page auto-navigates you straight
into `/app/digests/:id`.

**What can go wrong:**

- _Stuck past 5 minutes_ — open `/admin/users/:id` to see the
  fast-path job status and any error events.
- _Zero items synthesized_ — empty-digest record is fine; you'll see
  the _"Nothing notable"_ state. Either your competitors were
  genuinely quiet in the last 24h, or your competitor list is too
  narrow (go back to `/app/profile` and add more).

---

## Step 10 — Read your first digest

**Where:** `/app/digests/:id`.

Native shadcn + brand-token rendering — intentionally higher fidelity
than the eventual email template (#11), which is constraint-bound to
inline styles.

Each digest item shows:

- **Tag** — category (launch / pricing / feature / positioning).
- **Headline** — Sonnet-generated, in Product Flash editorial tone.
- **Snippet** — 1–2 sentence summary of the underlying `raw_item`.
- **Impact note** — _the load-bearing line_, framed against your goal +
  focus areas (e.g. _"Pressures your enterprise positioning vs.
  Asana"_, not _"Pricing pressure on the category"_).
- **👍 / 👎** — react. These hit `/r/:digest_item_id/:rating` with a
  signed token; clicking writes a `feedback` row and redirects to a
  thanks page.

That's it. You're fully onboarded. Future digests land daily at the
same `/app/digests` list.

---

## Where to go next

- **`/app/profile`** — view + edit your AI profile, manage competitors
  outside the onboarding flow (#32). Edits invalidate score cache.
- **`/app/digests`** — list of all past digests, newest first.
- **`/admin/users/:id`** — admin view of any user's profile, recent
  digests, FTE event timeline, and re-run controls (#16).

---

## Dogfooding lens — what to ask at each step

When you (Maxime) run through this for #13, the goal is to find
friction _before_ a beta user does. Use these prompts.

**Step 1 (waitlist):**

- Did you understand within 5 seconds what you'd get if you submitted?
- Is the role dropdown's set of options aligned with who we actually
  want? Anything missing or condescending?

**Step 4 (signup intake):**

- Did the 4-field ask feel proportionate to "your AI analyst goes to
  work"? Too long? Too short?
- The Goal field is the load-bearing one for #35 personalization. Did
  the placeholder steer you toward a useful answer, or did you stare?

**Step 6 (thinking stream):**

- Is the planner*text \_interesting* to read, or does it feel like log
  spew? (Remember: per [[feedback_agentic_ui]], the user surface is
  "thinking steps", not the raw event log.)
- Do the progress chips actually _say something_ (pages read, web
  searches), or do they feel decorative?
- 60–120s wall time — did it feel fast, on-time, or slow? At what
  second did you start to doubt it was working?

**Step 7 (profile preview) — the most important reflection:**

- Did the agent identify the _right_ competitors? Score yourself: out
  of 5 listed, how many would you keep?
- Did it frame your role/goal in a way you'd actually claim, or did it
  put words in your mouth?
- Are the focus areas the ones you'd use to filter your own reading?
- If you had to add or remove something inline, did the UI make that
  easy? (Per [[feedback_inline_edit_at_creation]], edit must live where
  state is created — not deferred to `/app/profile`.)

**Step 10 (first digest):**

- Does each `impact_note` actually reference _your_ goal/role, or does
  it read as a generic category summary? (#35 is the whole point — if
  this fails, the personalization didn't land.)
- Would you have caught any of these items from your existing reading
  routine? If yes, why are we duplicating? If no, is _this specific
  item_ something you'd want flagged?
- Open the digest tomorrow + the next day. Three clean days in a row
  is the gate for #18 beta launch.

---

## Known gaps + things to watch

Living list of friction we know exists but haven't fixed yet. Update as
you find more.

- **No auto-send of invite emails.** Admin copies the URL from
  `/admin/waitlist` and pastes it manually. Folds into #11 once Resend
  templates are reactivated.
- **Lost magic links require a full re-submit.** Step 4 has no "resend
  link" affordance — re-running the form re-uses the in-flight FTE run
  but it's not obvious. Could add an inline "didn't get it?" link on
  the SentCard.
- **No abort/retry on a wedged FTE run from the user side.** If the
  agent stalls past 3 min, the user has no UI button to retry. Admin
  has to re-run from `/admin/users/:id`.
- **The brewing state has no error surface.** If the fast-path job
  silently fails, the user sees an indefinite elapsed counter. The
  cron is the safety net but the user doesn't know that.
- **`focus_areas` are agent-only at signup time.** The user can't pre-
  seed them in Step 4 — they only get to edit in Step 7. Possibly
  fine, possibly a missed expectation-setting opportunity.
- **No tz capture in onboarding.** `users.tz` is nullable; #17 (per-TZ
  send scheduling) will need to backfill or ask later.
- **Profile edits invalidate score cache, but the user isn't told.**
  After clicking save, no toast says "we'll re-score your next
  digest." Silent magic = mistrust.
- **Empty-digest UX is untested.** Step 10's "Nothing notable" path
  has been built (`SCOPE.md` §6) but Maxime hasn't hit it for real
  yet — first-day dogfood may surface awkwardness.
- **Send + email are deferred (#11, #17).** This guide stops at "read
  in-app." Once email lands, Step 10 will need a sibling section for
  the inbox view.

---

## Keeping this guide current

This file drifts the moment FTE behavior changes. Some discipline:

- **If you change behavior in any file in the maintainer map below,
  update the matching step in the same PR.** The map exists so you
  can grep the other direction too: changing `signup.tsx`? Re-read
  Step 4.
- **If you add a new step (e.g. team invite, billing prompt),
  renumber.** Don't bolt "Step 4.5" — readers won't trust it.
- **If you fix a known-gap, delete it from the list.** Don't strike
  through; a clean list is more useful than a history of past fixes
  (that's what git log is for).
- **When task IDs land (e.g. #11 ships email send), drop the "deferred"
  language and write the new step in present tense.** Future-you
  reading this on Day 14 of beta shouldn't have to mentally translate
  "later" into "now."

---

## Troubleshooting

| Symptom                                    | Likely cause                                     | Fix                                                                                        |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `/signup` shows the invite gate            | Token missing, expired, or tampered              | Ask admin to re-issue from `/admin/waitlist`                                               |
| Magic-link email never arrived             | Resend hiccup, or wrong inbox                    | Re-submit the `/signup` form (re-sends link); check spam                                   |
| `/app/onboarding` is blank, no events      | FTE worker is down                               | Check `pnpm worker` is running locally / Railway worker logs                               |
| Thinking stream stalls mid-run             | Anthropic timeout, or `max_iterations` hit       | Look at `/admin/users/:id` event timeline; re-run from there                               |
| `run_finished` arrived but no profile card | Agent never called `save_profile`                | Re-run FTE; if persistent, check tool definitions in `src/agents/fte/tools.ts`             |
| Brewing state past 5 min                   | Fast-path job failed silently                    | Admin: check pg-boss `job` table for `fast-path-run` row; the 05:30 cron is the safety net |
| First digest shows "Nothing notable"       | Genuine quiet day, OR competitor list too narrow | Add more competitors at `/app/profile`; the next daily run will pick them up               |

---

## For maintainers — what files own each step

| Step                        | File                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Admin login + role gate     | `src/routes/login.tsx`, `src/routes/admin.tsx`, `src/lib/auth-server.ts` (`requireAdminSession`) |
| Waitlist form               | `src/components/landing/WaitlistForm.tsx`, `src/routes/api/waitlist.ts`                          |
| Admin invite issuance       | `src/routes/admin/waitlist.tsx`, `src/lib/invite-token.ts`                                       |
| Signup intake + magic link  | `src/routes/signup.tsx`, `src/lib/auth.ts`                                                       |
| FTE agent loop              | `src/agents/fte/agent.ts`, `tools.ts`, `job.ts`, `events.ts`                                     |
| Onboarding UI + SSE         | `src/routes/app/onboarding.tsx`, `src/routes/api/onboarding/stream.ts`, `src/lib/notify.ts`      |
| Profile confirm + fast path | `confirmProfile` in `src/routes/app/onboarding.tsx`, `src/jobs/fast-path.ts`                     |
| Brewing → digest            | `src/routes/app/digests/index.tsx`, `src/routes/app/digests/$digestId.tsx`                       |
