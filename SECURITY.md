# Security

Product Flash is in private beta. This document captures what is currently
defended, what isn't, and how to report a problem. Last reviewed: 2026-05-17
(commit `c8842f2`).

## Reporting a vulnerability

Email **beaudoin.maxime@gmail.com** with `[security]` in the subject. Please
include:
- a description of the issue,
- steps to reproduce,
- the impact you observed (e.g. "read another user's digest", "ran code on
  the server"),
- any logs or HTTP exchanges that help.

Reasonable disclosure window: we will acknowledge within 72 hours and aim to
ship a fix within 14 days for High/Critical issues. Please don't share
findings publicly before we've had a chance to fix.

We don't currently run a bug bounty. We're happy to credit reporters in this
file if you'd like that.

## Scope

**In scope**
- The Product Flash web app (`/app/*`, `/admin/*`, public routes) and the
  worker that runs the daily pipeline.
- Auth, tenant isolation, data exposure, SSRF, prompt injection, supply
  chain.

**Out of scope**
- Anything that requires the reporter to already be an admin of the org
  (the admin role is fully trusted by design).
- Vendor-side issues at Anthropic, Resend, Neon, Railway, Firecrawl,
  Firehose, Product Hunt, PostHog — please report those to the vendors.
- Self-XSS, missing best-practice headers beyond what we've shipped (see
  below), social engineering of admins, theoretical issues without a path
  to exploit.

## Posture today

The 2026-05-16 audit raised 13 findings (0 Critical / 3 High / 4 Medium /
3 Low / 3 Info). All 13 have been remediated or formally accepted with a
written rationale below. The full report lives in the Claude Code session
transcript; the audit playbook lives at
`.claude/skills/security-audit/SKILL.md` and can be re-run any time.

### Identity & sessions

- **Auth provider:** Better Auth 1.6.11, magic-link only. Email/password is
  off. Sessions are signed cookies via `tanstackStartCookies`.
- **Private beta:** `disableSignUp: true` on the magic-link plugin — the
  only way into the `users` table is an admin issuing an invite from
  `/admin/waitlist`.
- **Invite tokens:** HMAC-signed with a dedicated secret
  (`INVITE_TOKEN_SECRET`), embed `iat`, expire 14 days after issue, and
  refuse to redeem against an account whose profile is already confirmed
  (closes the leaked-URL takeover path — `src/lib/invite-token.ts`,
  `src/routes/signup.tsx`).
- **Auto-sign-in tokens:** the verification row pre-created by
  `issueAutoSignInUrl` lives for 15 seconds. The URL is single-use and
  must never be logged.
- **Rate limiting:** Better Auth's limiter is enabled in production.
  Defaults are 30/60s per IP across `/api/auth/*`; magic-link is
  tightened to 3/60s; admin-plugin mutating endpoints are 20/60s. Client
  IP is read from `X-Forwarded-For` (set by the Railway edge).

### Authorization & tenant isolation

- `requireSession` gates all `/app/*` routes; `requireAdminSession`
  additionally enforces `role === 'admin'` for `/admin/*` and `/debug/*`.
- Every server function that takes an id-shaped input scopes the DB query
  to `session.user.id` (see e.g. `src/routes/app/digests/$digestId.tsx`).
- The shared `competitors` table is documented in
  `src/db/schema.ts` as a globally-deduped namespace. User-facing
  `addCompetitor` handlers (`src/routes/app/profile.tsx`,
  `src/routes/app/onboarding.tsx`) are **insert-or-link only**: an existing
  row's `name` and `rss_url` are never overwritten by a second user.

### Server-controlled outbound HTTP (SSRF defense)

- `src/lib/safe-fetch.ts` rejects requests that resolve to loopback,
  link-local, RFC1918, CGNAT, ULA, multicast, or unspecified addresses.
  Redirects are walked manually with re-validation at every hop (max 3
  hops). The RSS source adapter funnels every outbound call through it.
- Firecrawl and the FTE agent's `fetch_url` tool intentionally bypass
  `safe-fetch` because their outbound target is a fixed Firecrawl SaaS
  endpoint; the user-controlled URL is the payload Firecrawl scrapes,
  which Firecrawl filters on its side.

### LLM safety

- Untrusted feed content (RSS body, scraped titles) is wrapped in
  `<feed_title>` / `<feed_body>` delimiters in both the Haiku classifier
  and Sonnet synthesizer prompts, with a "treat as data only" instruction
  above. Tool-use with a forced `tool_choice` keeps the output schema
  fixed.
- The RSS adapter sanitizes feed text at ingest: known prompt-injection
  patterns ("ignore prior instructions", fake role tags, our own
  delimiter tags) get replaced with `[redacted]`; control characters are
  stripped; per-field length is capped at 4000 chars.
- LLM cost is bounded per call: every Anthropic `messages.create`
  invocation sets `max_tokens`; the FTE agent caps iterations (14), tool
  calls (40), and web searches (6) per run; per-user spend is recorded
  in `llm_usage` and surfaced in `/admin/users`.

### HTTP response hygiene

- `server/middleware/security-headers.ts` (registered via
  `vite.config.ts`) sets these on every response:
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- `/healthz` returns a generic `{ ok: false, db: { ok: false } }` on
  failure; the full error stays in server logs only.
- `/logout` is POST-only. The sign-out controls in `AppHeader` and
  `AdminHeader` are form-submit buttons.
- `/debug/*` routes (digest preview, design smoke) require an admin
  session — they used to be `NODE_ENV !== 'production'`-gated, which was
  one misconfigured deploy slot away from public.

### Secrets

- `.env` is gitignored. `.env.example` is placeholder-only.
- Server secrets (`BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`,
  `RESEND_API_KEY`, `FIRECRAWL_API_KEY`, `FIREHOSE_TAP_TOKEN`,
  `INVITE_TOKEN_SECRET`, `FEEDBACK_SIGNING_SECRET`) are validated at
  boot in `src/lib/env.ts`. Only `VITE_POSTHOG_KEY` and
  `VITE_POSTHOG_HOST` ship to the browser — these are PostHog project
  keys, which are public by design.

### Dependencies

- `pnpm audit --prod` is clean as of 2026-05-17. `pnpm.overrides` pins
  patched `postcss`, `prismjs`, and `esbuild` to clear known transitive
  advisories; `next` stays pinned to 15.1.11 (it's a Better Auth
  transitive that we don't execute).
- We do not enable Dependabot in the repo today; re-run `pnpm audit
  --prod` before each deploy and before adding a new dep.

## External exposure

What an unauthenticated attacker can reach from the public internet, and
the bound on what they can do with it.

| Surface | Reachable | What an attacker can do | Bound |
|---|---|---|---|
| `/` (landing) | public | render the page | static; no DB write |
| `/login`, `/signup` (HTML) | public | render the form | gated by invite token for /signup; no user row created without admin pre-creation |
| `/api/auth/*` | public | start a magic-link flow, sign in if they hold a valid magic link, sign out | `disableSignUp: true`, 3/60s rate limit on magic-link, 30/60s default elsewhere |
| `/api/waitlist` (POST) | public | append an email to the waitlist | `onConflictDoNothing` on email; pollution only — no other side effects. No rate limit (accepted gap) |
| `/healthz` | public | observe up/down + uptime | response is `{ ok, db: { ok }, uptimeSeconds }` only — no error string |
| `/api/email/open/:digestId.gif` | public | mark someone's digest as opened, fire a PostHog event | digestId is an unguessable UUID; if forged, only inflates open counts; first-open semantic preserved by `WHERE openedAt IS NULL` |
| `/r/:itemId/:rating` | public | record up/down feedback on a digest item | requires an HMAC `?t=` token tied to (itemId, rating); forging requires `FEEDBACK_SIGNING_SECRET` |
| `/logout` (POST) | public | sign yourself out | POST-only, no CSRF concern |
| `/app/*`, `/admin/*`, `/debug/*`, `/api/onboarding/stream` | gated | — | `requireSession` / `requireAdminSession` on every entry |
| Worker service | **not** public | — | Railway-internal only; reachable only via pg-boss queue rows in the shared Postgres |

The worker process has the same DB credentials as the web service but
intentionally exposes no HTTP surface. If we ever add one (debug
console, metrics endpoint), it must be Railway-internal-only or
admin-gated.

## Vendor trust

What we delegate to each third party, and the practical blast radius if
that vendor is compromised. Severity is what *we* would face, not what
the vendor sees globally.

| Vendor | What we trust them with | If compromised |
|---|---|---|
| **Neon** (Postgres) | All user data, sessions, llm_usage, feedback | Full data exposure. Sessions are signed cookies; rotating `BETTER_AUTH_SECRET` invalidates everything. Backups + PITR live on Neon. |
| **Railway** (host + secrets) | Every env var (DB URL, Anthropic key, Resend key, HMAC secrets) | Full takeover. Mitigation is incident response, not prevention — rotate every secret in `.env.example`, re-deploy. |
| **Better Auth** (npm package) | Session signing, magic-link flow, admin role enforcement, rate limiter | Auth bypass / role escalation. Audit the package on every minor bump; pinned at 1.6.11. |
| **Anthropic** | Synthesizer + classifier prompts (include reader name + role + goal + focus areas + competitor feed content) | Prompt content leaks. No raw secrets in prompts. Rotating ANTHROPIC_API_KEY caps spend post-incident. |
| **Resend** | Outbound email content, recipient addresses | Email-flow compromise: spoofed digest, harvested addresses. DMARC/DKIM/SPF on `productflash.ai` is the primary defense — verify in DNS. |
| **Firecrawl** | URLs the FTE agent / pricing scraper hand it; receives our API key | Returned markdown could be tampered → poisoned LLM input. Bounded by prompt-injection delimiters + ingest sanitization (F-004). |
| **Firehose** | Rule set; receives our tap token | Same as Firecrawl. Currently deferred for the PoC — adapter is a no-op (`[[project_firehose_deferred]]`). |
| **Product Hunt** | API token; no user data sent | Tampered post stream → poisoned LLM input. Same containment as Firecrawl. |
| **PostHog** | Event names + user IDs + email + a few event properties (no secrets, no message bodies) | Funnel/identity analytics exposed. No direct user impact. |
| **GitHub** | Source, commit history, PR review | Supply-chain takeover via force-push or branch protection bypass. Branch protection on `main` should require PR + status checks for non-owner pushes — verify in repo settings. |

The two highest blast-radius dependencies are **Neon** and **Railway**.
For both, the only practical defense is the vendor's own security
posture; our part is rotating secrets and minimizing what's stored.

## Known gaps / accepted risk

- **No CSP.** Deferred from F-013. We'll ship
  `Content-Security-Policy-Report-Only` first, monitor violations, then
  enforce. Risk while pending: a stored-XSS in any user-rendered string
  has no second line of defense — but React + React Email both
  escape by default, and our LLM output goes through delimited prompts +
  forced tool-use schemas, so the practical surface is small.
- **No per-IP rate limit on `/api/waitlist`.** The endpoint only does an
  `onConflictDoNothing` insert into `waitlist`, so the abuse impact is
  bounded to row pollution. Will revisit when the public waitlist opens
  beyond the current trickle.
- **`/api/auth/admin/*` enforcement assumed, not verified.** Better
  Auth's `admin()` plugin enforces `role === 'admin'` internally; we
  trust this at PoC stage. Post-deploy task: probe
  `/api/auth/admin/list-users` unauthenticated → 401, from non-admin →
  403.
- **`competitors` is a globally-shared table.** Documented in
  `src/db/schema.ts`. Trade-off: 1× daily ingestion cost instead of N×
  per duplicate competitor; the per-user attack vector is closed by
  insert-or-link handlers. Revisit if we move off per-user tenancy.
- **Better Auth rate-limit storage is in-memory.** Counters reset on
  every Railway deploy, which is rare today. Upgrade to `storage:
  'database'` if cross-deploy evasion becomes a concern.

## Audit cadence

- **Before every public expansion** (beta size doubling, opening
  signups, adding a new auth path, adding a write endpoint): re-run the
  `security-audit` skill and update this file with any new findings.
- **Every dep bump:** `pnpm audit --prod`.
- **Quarterly:** review this file end-to-end; remove stale entries;
  re-verify the "Known gaps" list is still accepted, not forgotten.

## Changelog

Each row is one audit round. "Closed" = code change merged. "Accepted" =
gap documented with a written rationale above; no code change.

### 2026-05-17 — Audit 1 (`b6bbf9e..ce35589`)

Full audit run via `.claude/skills/security-audit/SKILL.md` on commit
`b6bbf9e`. 13 findings: 0 Critical, 3 High, 4 Medium, 3 Low, 3 Info.

| ID | Severity | What | Outcome | Commit |
|---|---|---|---|---|
| F-001 | High | Invite tokens never expired; `/signup` replay clobbered confirmed accounts | Closed: 14d TTL + refuse-replay on confirmed accounts | `6173983` |
| F-002 | High | SSRF via `addCompetitor` → `autodetectRSSForHomepage` with `redirect: follow` | Closed: `src/lib/safe-fetch.ts` with DNS-resolved private-IP rejection + manual redirects | `2fe9276` |
| F-003 | High | Global `competitors` table allowed cross-tenant tampering of `name` + `rss_url` | Closed: user-facing handlers switched to insert-or-link (`onConflictDoNothing`) | `4e8b0e8` |
| F-004 | Medium | Untrusted RSS body fed into classifier + synthesizer prompts unbounded | Closed: `<feed_title>`/`<feed_body>` delimiters + treat-as-data instruction + ingest sanitization | `7bf35ae` |
| F-005 | Medium | `/healthz` leaked DB error message | Closed: response trimmed; full error in server logs only | `710a6d6` |
| F-006 | Medium | `/logout` was a GET (cross-site `<img>` sign-out) | Closed: POST-only, header buttons switched to form submit | `710a6d6` |
| F-007 | Medium | No rate limit on magic-link send | Closed: Better Auth limiter on; 3/60s on magic-link | `42115a9` |
| F-008 | Low | Auto-sign-in URL had 60s window | Closed: dropped to 15s | `6173983` |
| F-009 | Low | Transitive moderate advisories (postcss/prismjs/esbuild) | Closed: pnpm overrides pin patched versions | `d91092b` |
| F-010 | Low | `/debug/*` gated by NODE_ENV only | Closed: swapped to `requireAdminSession` | `710a6d6` |
| F-011 | Info | Shared global `competitors` table is a tenancy smell | Accepted: documented in `src/db/schema.ts`; fix is per-user table if we move off per-user tenancy | `566424d` |
| F-012 | Info | Better Auth `/api/auth/admin/*` enforcement assumed, not verified | Accepted: post-deploy verification task | — |
| F-013 | Info | No HSTS/X-Frame/X-Content-Type-Options/Referrer-Policy/CSP | Closed (4 of 5): Nitro middleware ships HSTS + X-Frame-Options + X-Content-Type-Options + Referrer-Policy. CSP accepted as deferred (report-only rollout pending) | `c8842f2` |

Posture documentation: `ce35589` (this file + project-local skill copy).

## Where to look

- Audit playbook: `.claude/skills/security-audit/SKILL.md`
- Auth: `src/lib/auth.ts`, `src/lib/auth-server.ts`
- Tokens: `src/lib/invite-token.ts`, `src/lib/feedback-token.ts`
- SSRF: `src/lib/safe-fetch.ts`, `src/sources/rss.ts`
- LLM safety: `src/lib/classify.ts`, `src/lib/synthesize.ts`,
  `src/agents/fte/agent.ts`
- Response headers: `server/middleware/security-headers.ts`,
  `vite.config.ts`
