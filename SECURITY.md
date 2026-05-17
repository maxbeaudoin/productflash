# Security

This file describes the Product Flash security posture: what's currently
defended, what gaps we've consciously accepted, and how the audit history
maps to commits. Written for devs on this repo; the external-reporter
blurb is at the bottom. The audit playbook lives at
`.claude/skills/security-audit/SKILL.md` and can be re-run any time.

## Posture today

### Identity & sessions

- Better Auth 1.6.11, magic-link only. Email/password is off. Sessions
  are signed cookies via `tanstackStartCookies`; cookie is `SameSite=lax`.
- Private beta: `disableSignUp: true` on the magic-link plugin. The only
  path into `users` is an admin issuing an invite from `/admin/waitlist`.
- Invite tokens: HMAC-signed with `INVITE_TOKEN_SECRET`, 14-day TTL via
  embedded `iat`, single-redemption (refused once
  `users.profileConfirmedAt` is set). Code: `src/lib/invite-token.ts`,
  `src/routes/signup.tsx`.
- Auto-sign-in URLs (`issueAutoSignInUrl`): 15s single-use. Never log
  these — anything that captures server-function response bodies
  snapshots a live sign-in URL.
- Rate limit: Better Auth's limiter, on in production. 30/60s per IP
  across `/api/auth/*`, 3/60s on `/sign-in/magic-link`, 20/60s on
  `/admin/*`. Client IP is read from `X-Forwarded-For`; this assumes
  Railway's edge strips and re-sets it, which we have **not** yet
  verified (Known gaps).

### Authorization & tenant isolation

- `requireSession` gates `/app/*`; `requireAdminSession` adds
  `role === 'admin'` for `/admin/*` and `/debug/*`.
- Every server function that takes an id-shaped param scopes the query
  to `session.user.id` (e.g. `src/routes/app/digests/$digestId.tsx`).
- `competitors` is a globally-deduped namespace (one row per
  `homepage_url`, regardless of how many users track it). Manual
  user-facing adds in `src/routes/app/profile.tsx` and
  `src/routes/app/onboarding.tsx` are insert-or-link
  (`onConflictDoNothing`). The FTE-agent path in
  `src/agents/fte/tools.ts` keeps `onConflictDoUpdate` (overwrites
  `name`, `coalesce`s `rss_url`); it runs in a privileged signup context
  on the user's own behalf, not against an attacker-controlled surface.
  Two users with the same competitor can therefore see name drift across
  signup runs.

### Outbound HTTP (SSRF defense)

- `src/lib/safe-fetch.ts` blocks loopback / link-local / RFC1918 / CGNAT
  / ULA / multicast / unspecified addresses. Redirects are walked
  manually with re-validation at every hop (max 3). The RSS adapter
  funnels every outbound call through it.
- Firecrawl and the FTE agent's `fetch_url` tool intentionally bypass
  `safe-fetch` — their outbound target is the fixed Firecrawl SaaS
  endpoint. The user-controlled URL rides in the request body and is
  filtered by Firecrawl on its side.

### LLM safety

- Untrusted feed content is wrapped in `<feed_title>` / `<feed_body>`
  delimiters in the classifier + synthesizer prompts, with a "treat as
  data only" instruction. `tool_choice` forces the output schema.
- Ingest-time sanitization in the RSS adapter: known prompt-injection
  patterns ("ignore prior instructions", fake role tags, our own
  delimiter tags) → `[redacted]`; control chars stripped; per-field
  length capped at 4000 chars.
- Cost bounded per call: every Anthropic `messages.create` sets
  `max_tokens`; the FTE agent caps iterations (14), tool calls (40), and
  web searches (6) per run. Per-user spend is recorded in `llm_usage`
  and surfaced in `/admin/users`.

### HTTP response hygiene

- `server/middleware/security-headers.ts` (registered via
  `vite.config.ts`) sets HSTS, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: strict-origin-when-cross-origin` on every response.
  CSP is **not** shipped — Known gaps.
- `/healthz`: `{ ok: true, db: { ok: true, latencyMs }, uptimeSeconds }`
  on health; `{ ok: false, db: { ok: false }, uptimeSeconds }` + 503 on
  failure. The full DB error stays in server logs only.
- `/logout`: POST-only. Header sign-out controls are form-submit
  buttons. CSRF safety here comes from the session cookie's
  `SameSite=lax` (which blocks cookies on cross-site form POSTs) — don't
  loosen that flag without re-thinking this.
- `/debug/*`: gated by `requireAdminSession`.

### Secrets

- `.env` is gitignored. `.env.example` is placeholder-only.
- Server secrets validated at boot in `src/lib/env.ts`:
  `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
  `FIRECRAWL_API_KEY`, `FIREHOSE_TAP_TOKEN`, `INVITE_TOKEN_SECRET`,
  `FEEDBACK_SIGNING_SECRET`.
- Only `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` reach the browser
  bundle — PostHog project keys, public by design.

### Dependencies

- `pnpm audit --prod` is clean. `pnpm.overrides` pins patched `postcss`,
  `prismjs`, and `esbuild`; `next` stays pinned to 15.1.11 (Better Auth
  transitive we don't execute).
- No Dependabot. Re-run `pnpm audit --prod` before each deploy and
  before adding a new dep.

## External exposure

What an unauthenticated attacker can reach from the public internet, and
the bound on what they can do with it.

| Surface | Reachable | What an attacker can do | Bound |
|---|---|---|---|
| `/` (landing) | public | render the page | static; no DB write |
| `/login`, `/signup` (HTML) | public | render the form | `/signup` requires an invite token; no user row created without admin pre-creation |
| `/api/auth/*` | public | start a magic-link flow, sign in if they hold a valid magic link, sign out | `disableSignUp: true`, 3/60s on magic-link, 30/60s default elsewhere |
| `/api/waitlist` (POST) | public | append an email to the waitlist | `onConflictDoNothing` on email; pollution only. No rate limit (Known gaps) |
| `/healthz` | public | observe up/down + uptime | response carries no error string |
| `/api/email/open/:digestId.gif` | public | mark a digest as opened, fire a PostHog event | `digestId` is an unguessable UUID; forgery only inflates open counts; `WHERE openedAt IS NULL` preserves first-open semantics |
| `/r/:itemId/:rating` | public | record up/down feedback on a digest item | requires an HMAC `?t=` token tied to `(itemId, rating)`; forging requires `FEEDBACK_SIGNING_SECRET` |
| `/logout` (POST) | public | sign yourself out | POST-only; cookies don't ride cross-site form POSTs under `SameSite=lax` |
| `/app/*`, `/admin/*`, `/debug/*`, `/api/onboarding/stream` | gated | — | `requireSession` / `requireAdminSession` on every entry |
| Worker service | **not** public | — | Railway-internal only; reachable only via pg-boss queue rows in the shared Postgres |

The worker has the same DB credentials as the web service but exposes no
HTTP surface. If we ever add one (debug console, metrics endpoint), it
must be Railway-internal-only or admin-gated.

## Vendor trust

What we delegate to each third party, and the practical blast radius if
that vendor is compromised. Severity is what *we* would face, not what
the vendor sees globally.

| Vendor | What we trust them with | If compromised |
|---|---|---|
| **Neon** (Postgres) | All user data, sessions, llm_usage, feedback | Full data exposure. Rotating `BETTER_AUTH_SECRET` invalidates all sessions. Backups + PITR live on Neon. |
| **Railway** (host + secrets) | Every env var (DB URL, Anthropic key, Resend key, HMAC secrets) | Full takeover. Mitigation is incident response, not prevention — rotate every secret in `.env.example`, re-deploy. |
| **Better Auth** (npm) | Session signing, magic-link flow, admin role enforcement, rate limiter | Auth bypass / role escalation. Audit on every minor bump; pinned at 1.6.11. |
| **Anthropic** | Synthesizer + classifier prompts (reader name + role + goal + focus areas + competitor feed content) | Prompt content leaks. No raw secrets in prompts. Rotating `ANTHROPIC_API_KEY` caps spend post-incident. |
| **Resend** | Outbound email content, recipient addresses | Email spoof / address harvest. DMARC/DKIM/SPF on `productflash.ai` is the primary defense; verification of DNS records is a Known gap. |
| **Firecrawl** | URLs the FTE agent / pricing scraper hand it; API key | Returned markdown tampered → poisoned LLM input. Bounded by prompt-injection delimiters + ingest sanitization. |
| **Firehose** | Rule set; tap token | Same as Firecrawl. Adapter is currently a no-op for the PoC. |
| **Product Hunt** | API token; no user data sent | Tampered post stream → poisoned LLM input. Same containment. |
| **PostHog** | Event names + user IDs + email + a few event properties (no secrets, no message bodies) | Funnel/identity analytics exposed. No direct user impact. |
| **GitHub** | Source, commit history, PR review | Supply-chain takeover via force-push / branch-protection bypass. Branch-protection state on `main` is a Known gap. |

## Known gaps / accepted risk

Each entry: what's missing, why we accept it for now, what would
trigger a fix.

- **No CSP.** Deferred from F-013. Plan: ship
  `Content-Security-Policy-Report-Only` first, monitor, then enforce.
  Risk while pending is small — React + React Email escape by default,
  LLM output goes through delimited prompts + forced tool-use schemas.
  The plausible stored-XSS path is any future Markdown rendering of
  user-supplied prose (feedback notes, profile fields) — re-evaluate
  CSP priority the day we add one.
- **No per-IP rate limit on `/api/waitlist`.** Endpoint only does
  `onConflictDoNothing` into `waitlist`; abuse impact bounded to row
  pollution. Revisit when the public waitlist opens beyond the current
  trickle.
- **`/api/auth/admin/*` enforcement assumed, not verified.** Better
  Auth's `admin()` plugin enforces `role === 'admin'` internally; we
  trust it at PoC stage. Post-deploy probe:
  `/api/auth/admin/list-users` unauthenticated → expect 401, as
  non-admin → expect 403.
- **`X-Forwarded-For` trust at Railway's edge not verified.** Our rate
  limiter buckets by XFF. If Railway forwards an attacker-supplied XFF
  unchanged, rate limits fall open. Verify with a probe (`curl
  -H 'X-Forwarded-For: 1.2.3.4'` against a non-prod host, observe what
  reaches the limiter).
- **DMARC / DKIM / SPF on `productflash.ai` not verified in DNS.**
  Outbound deliverability and spoof resistance both depend on these.
  `dig TXT productflash.ai`, `dig TXT _dmarc.productflash.ai`, check
  Resend's verified-domain settings.
- **Branch protection on `main` not verified in GitHub repo settings.**
  Should require PR + status checks for non-owner pushes; force-push
  disabled. Check Settings → Branches.
- **`competitors` is a globally-shared table.** Documented in
  `src/db/schema.ts`. Trade-off: 1× daily ingestion cost instead of
  N× per duplicate competitor; the user-attack vector is closed by
  insert-or-link manual handlers. The FTE-agent path can still produce
  name drift across signups. Revisit if we move off per-user tenancy.
- **Better Auth rate-limit storage is in-memory.** Counters reset on
  every Railway deploy, which is rare. Upgrade to `storage: 'database'`
  if cross-deploy evasion becomes a concern.

## Audit cadence

- **Before every public expansion** (beta size doubling, opening
  signups, adding a new auth path, adding a write endpoint): re-run the
  `security-audit` skill, update Posture, append a Changelog row.
- **Every dep bump:** `pnpm audit --prod`.
- **Quarterly:** read this file end-to-end; re-verify the Known gaps
  are still consciously accepted, not forgotten; close out any
  verification tasks.

## Changelog

History only — current state lives in Posture / Known gaps.

### 2026-05-17 — Audit 1 (`b6bbf9e..ce35589`)

Full audit on commit `b6bbf9e`. 13 findings: 0 Critical / 3 High /
4 Medium / 3 Low / 3 Info.

| ID | Severity | What | Outcome | Commit |
|---|---|---|---|---|
| F-001 | High | Invite tokens never expired; `/signup` replay clobbered confirmed accounts | Closed: 14d TTL + refuse-replay on confirmed accounts | `6173983` |
| F-002 | High | SSRF via `addCompetitor` → `autodetectRSSForHomepage` with `redirect: follow` | Closed: `src/lib/safe-fetch.ts` + RSS adapter routed through it | `2fe9276` |
| F-003 | High | Global `competitors` table allowed cross-tenant tampering of `name` + `rss_url` | Closed for manual handlers (insert-or-link); FTE-agent path documented as residual | `4e8b0e8` |
| F-004 | Medium | Untrusted RSS body fed into classifier + synthesizer prompts unbounded | Closed: delimiter blocks + treat-as-data instruction + ingest sanitization | `7bf35ae` |
| F-005 | Medium | `/healthz` leaked DB error message | Closed: response trimmed | `710a6d6` |
| F-006 | Medium | `/logout` was a GET | Closed: POST-only + form-submit buttons | `710a6d6` |
| F-007 | Medium | No rate limit on magic-link send | Closed: Better Auth limiter on; 3/60s on magic-link | `42115a9` |
| F-008 | Low | Auto-sign-in URL had 60s window | Closed: dropped to 15s | `6173983` |
| F-009 | Low | Transitive moderate advisories (postcss/prismjs/esbuild) | Closed: pnpm overrides pin patched versions | `d91092b` |
| F-010 | Low | `/debug/*` gated by NODE_ENV only | Closed: swapped to `requireAdminSession` | `710a6d6` |
| F-011 | Info | Shared global `competitors` table is a tenancy smell | Accepted; documented in `src/db/schema.ts` | `566424d` |
| F-012 | Info | Better Auth `/api/auth/admin/*` enforcement assumed | Accepted: post-deploy verification task (Known gaps) | — |
| F-013 | Info | Missing security response headers | Closed: 4 headers shipped via Nitro middleware. CSP deferred — Known gaps | `c8842f2` |

## Where to look

- Audit playbook: `.claude/skills/security-audit/SKILL.md`
- Auth: `src/lib/auth.ts`, `src/lib/auth-server.ts`
- Tokens: `src/lib/invite-token.ts`, `src/lib/feedback-token.ts`
- SSRF: `src/lib/safe-fetch.ts`, `src/sources/rss.ts`
- LLM safety: `src/lib/classify.ts`, `src/lib/synthesize.ts`,
  `src/agents/fte/agent.ts`
- Response headers: `server/middleware/security-headers.ts`,
  `vite.config.ts`
