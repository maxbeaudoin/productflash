---
name: security-audit
description: >
  Perform a comprehensive read-only security audit of a web/SaaS codebase. Covers
  authentication & tenant isolation, route/endpoint exposure, secret leaks,
  SQL/ORM injection, XSS/CSRF/SSRF/open redirect, LLM cost-abuse and prompt
  injection, dependency supply-chain risks, and OWASP basics. Produces a single
  ranked report with severity, likelihood, impact, evidence (file:line), and
  remediation. Use whenever the user asks for a "security audit", "security
  review", "pentest of the code", "look for vulns", "OWASP review", "LLM abuse
  surface", or similar. Never modifies files — read-only by contract.
allowed-tools: Bash(rg:*), Bash(grep:*), Bash(find:*), Bash(ls:*), Bash(wc:*), Bash(cat:*), Bash(sort:*), Bash(uniq:*), Bash(head:*), Bash(tail:*), Bash(awk:*), Bash(sed:*), Bash(jq:*), Bash(node:*), Bash(npm:*), Bash(pnpm:*), Bash(git:*), Read, Write
---

# Security Audit

A read-only, end-to-end security audit playbook for modern TypeScript web apps
(React/TanStack/Next/Remix + ORM + LLM). The skill is **methodology, not magic**:
work the checklist below in order, gather concrete `file:line` evidence, then
emit one ranked report.

## Operating contract

1. **Read-only.** Do not edit application code.
2. **Evidence-first.** Every finding cites `path/to/file.ts:LINE` and a short
   code excerpt. No vague claims like "consider hardening auth."
3. **No false confidence.** When something would require runtime access to
   verify (e.g., does this endpoint actually return data for another tenant?),
   say so explicitly under "Verification needed."
4. **Severity discipline.** Use the rubric below; do not inflate. A theoretical
   issue with no exploit path is Info, not High.

## Severity rubric

| Severity     | Definition                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Critical** | Trivially exploitable by an unauthenticated attacker → data breach, account takeover, RCE, or unbounded financial loss. Fix immediately, before next deploy. |
| **High**     | Exploitable by an authenticated low-privilege user → cross-tenant data access, privilege escalation, significant cost abuse. Fix this sprint.                |
| **Medium**   | Requires user interaction, chained conditions, or limited blast radius. Fix soon.                                                                            |
| **Low**      | Defense-in-depth gap; no current exploit path but reduces resilience.                                                                                        |
| **Info**     | Hygiene/observation; not a vuln but worth noting.                                                                                                            |

Likelihood is `High | Medium | Low` based on attacker effort and required
preconditions. Impact follows the same scale based on what the attacker gains.
**Severity is the function of both** — bias toward the higher of the two when
they disagree.

## Audit phases

Work these in order. Don't skip phases even if early ones look clean — different
classes of bugs surface in different phases.

### Phase 1 — Recon

Build a mental map before looking for bugs.

```bash
# Repo shape
find src -type d | head -60
find src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l

# Framework + key deps
cat package.json | jq '.dependencies, .devDependencies'

# Public assets / static
ls public/ 2>/dev/null

# Routes / endpoints
find src/routes src/app src/pages -type f 2>/dev/null
```

Note: framework (TanStack Start / Next / Remix), ORM (Drizzle / Prisma / raw),
auth library (Better Auth / NextAuth / Clerk / custom), email provider, LLM
SDK, queue/worker setup, deployment target.

### Phase 2 — Authentication & session

For the auth library in use:

- Locate the server config (provider list, session strategy, cookie flags).
- Check `disableSignUp` / equivalent if the product is private beta.
- For each provider: does the OAuth/email flow validate state/nonce? Are
  callback URLs allow-listed?
- Session cookie flags: `HttpOnly`, `Secure`, `SameSite`, lifetime, rotation.
- Magic-link / token flows: single-use? Expiration? Bound to email?
- Password reset / email change: revalidates the new email?
- Sign-out: server-side session invalidation, not just cookie clear?

```bash
rg -n 'createAuth|betterAuth|NextAuth|authOptions|jwt\.sign|session\(' src/
rg -n 'disableSignUp|allowedEmails|emailVerification' src/
rg -n 'httpOnly|sameSite|secure:\s*(true|false)' src/
```

### Phase 3 — Authorization & tenant isolation

For every server function / API route / mutation:

- Is `auth()` / `getSession()` / equivalent called _before_ the DB query?
- Does the DB query filter by `userId` / `orgId` / equivalent, or does it
  trust an `id` passed by the client?
- Admin endpoints: is the role check on the **server**, not just the UI?
- IDOR: any route that takes an id as a param and returns data without a
  `WHERE owner_id = currentUser` clause?

```bash
# Every server function / route file
rg -n 'createServerFn|defineHandler|export\s+(async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH)' src/

# Queries that look at an id param
rg -nB2 -A4 'eq\(\s*\w+\.id\s*,' src/

# Admin gating
rg -n 'isAdmin|role\s*===\s*["\']admin' src/
```

For each route, classify as `public | authed | admin` and verify the gate
matches the classification.

### Phase 4 — Input handling & injection

- **SQL/ORM injection.** Grep for raw SQL escape hatches:
  ```bash
  rg -n 'sql\.raw|sql`|client\.query\(|knex\.raw|\$queryRaw|executeRaw' src/
  ```
  Any of these with user input interpolated → flag.
- **NoSQL injection** if Mongo is in use: unsanitized `$where`/`$regex`.
- **Command injection.** Any `child_process`, `execSync`, `spawn` with user
  input? Any shell out at all?
  ```bash
  rg -n "child_process|execSync|spawn\(|exec\(" src/
  ```
- **Path traversal.** `fs.readFile`/`fs.createReadStream` with user-controlled
  paths?
  ```bash
  rg -n 'readFile|createReadStream|path\.join.*req\.|path\.resolve.*body\.' src/
  ```
- **Zod / schema validation.** Are inputs validated? Does the validator strip
  unknown keys (mass-assignment risk)?

### Phase 5 — XSS, CSRF, redirect, SSRF

- **XSS.** Any `dangerouslySetInnerHTML`? Untrusted markdown/HTML rendered in
  the app or in emails?
  ```bash
  rg -n 'dangerouslySetInnerHTML|innerHTML|v-html' src/
  ```
- **CSRF.** State-changing endpoints accessed via cookies — does the framework
  enforce CSRF, or is there an explicit token? Server functions in TanStack
  Start / RSC actions in Next are generally fine; old REST POST handlers are
  not.
- **Open redirect.** Any redirect that takes a destination from query/body?
  ```bash
  rg -n 'redirect\(|res\.redirect|Location:|window\.location\s*=' src/
  ```
- **SSRF.** Fetching from user-controlled URLs (web scrapers, oEmbed, webhook
  validators) without an allow-list?
  ```bash
  rg -n 'fetch\(|axios|got\(|undici|http\.get' src/ | rg -v node_modules
  ```

### Phase 6 — Secrets & client/server boundary

- **Server secrets bundled to client.** In Vite, only `VITE_*` env vars ship
  to the browser. In Next, only `NEXT_PUBLIC_*`. Verify no server keys are
  prefixed with the public marker.
  ```bash
  rg -n 'import\.meta\.env\.|process\.env\.' src/
  rg -n 'VITE_|NEXT_PUBLIC_' src/ .env* 2>/dev/null
  ```
- **Keys in source.** Grep for high-entropy strings, common provider prefixes:
  ```bash
  rg -n 'sk-ant-|sk_live_|sk_test_|AIza|ghp_|xox[bp]-|AKIA|re_[A-Za-z0-9]{20}' src/ scripts/ 2>/dev/null
  ```
- **.env in git.** Is `.env` git-ignored? Is `.env.example` placeholder-only?
  ```bash
  git ls-files | rg '^\.env$'
  cat .env.example 2>/dev/null | rg -v '^#|^$|=$|=\s*$|placeholder|example'
  ```
- **Logging.** Are secrets/PII logged? Pino redact config present?
  ```bash
  rg -n 'log(ger)?\.(info|debug|warn)\(.*(password|token|secret|email)' src/
  ```

### Phase 7 — LLM-specific risks

Modern apps have a unique attack surface around LLM calls.

- **Cost abuse / DoS.**
  - Is every LLM-invoking endpoint behind auth?
  - Is there a per-user rate limit? A daily budget cap?
  - Is `max_tokens` set on every call? (Unbounded streaming = unbounded $)
  - Loops over user input (fan-out classification, per-item synthesis) → is
    there an upper bound on the input set?
  ```bash
  rg -n 'anthropic|openai|messages\.create|chat\.completions' src/
  rg -nB2 -A8 'messages\.create\(' src/ | rg 'max_tokens|max_output_tokens' || echo 'MISSING max_tokens somewhere'
  ```
- **Prompt injection / context poisoning.**
  - Any untrusted text (RSS feeds, scraped pages, user-submitted notes) fed
    directly into a system prompt or used to drive tool calls?
  - Are tool-using agents constrained to a safe tool set, or could a poisoned
    document trigger destructive tool calls?
  - For agents that write to DB/email/etc., is there a confirmation gate, or
    does the agent's output become an action automatically?
- **Data exfiltration via LLM.** If the agent has DB read tools, can a
  poisoned input cause it to dump a different user's data into its response?
- **Output handling.** LLM output rendered as HTML/markdown without sanitization
  is an XSS vector — model-controlled `<script>` is still XSS.

### Phase 8 — Email / outbound abuse

- **Tracking pixel / open endpoints.** Validate the id is opaque (not an
  incrementing integer that lets an attacker enumerate recipients).
- **Unsubscribe.** One-click unsub should not require login _and_ should not
  let an attacker unsub arbitrary users (token must be HMAC'd to recipient).
- **From-address spoofing.** Resend/SES `from:` field — server-controlled?

### Phase 9 — Headers, cookies, transport

- CSP, HSTS, X-Frame-Options, Referrer-Policy. Configured?
  ```bash
  rg -n 'Content-Security-Policy|Strict-Transport|X-Frame|helmet' src/
  ```
- Cookie flags (see Phase 2).
- CORS: `Access-Control-Allow-Origin: *` on any state-changing route?
  ```bash
  rg -n 'Access-Control|cors\(' src/
  ```

### Phase 10 — Dependencies & supply chain

```bash
# Quick triage
cat package.json | jq '.dependencies + .devDependencies | to_entries | sort_by(.key) | .[] | "\(.key)@\(.value)"' -r

# If npm/pnpm available, run advisory check
pnpm audit --prod 2>&1 | head -50  # or: npm audit --omit=dev
```

Flag: pre-1.0 deps on critical paths, deprecated packages, packages with no
GitHub stars / single maintainer, version pins to a non-existent or yanked
release, `overrides` that downgrade a transitive dep below its patched version.

### Phase 11 — Misc OWASP basics

- **Mass assignment.** `db.update(users).set(req.body)` without an allow-list.
- **Insecure deserialization.** `JSON.parse` of cookie/header values? `eval`?
  `Function()` constructor?
- **Timing attacks** on token compare: `===` vs `crypto.timingSafeEqual`.
- **Information disclosure.** Stack traces or DB errors returned to client?
  ```bash
  rg -n 'error\.stack|err\.message|JSON\.stringify\(err' src/
  ```
- **Rate limiting.** Any login / password-reset / magic-link endpoint without
  a per-IP/per-email throttle?

## Report format

Emit a single markdown report. Structure:

````markdown
# Security Audit — <project> (<YYYY-MM-DD>)

## Executive summary

- N findings: X Critical, Y High, Z Medium, W Low, V Info
- Top three risks (one line each)
- Overall posture verdict (1–2 sentences)

## Scope & methodology

- What was reviewed (paths, commit SHA)
- What was NOT reviewed (runtime, infra, third-party config)
- Tools/commands used

## Findings (ranked, Critical → Info)

### F-001 — <Short title> [Severity: High] [Likelihood: Medium] [Impact: High]

**Where:** `src/routes/api/foo.ts:42–58`
**What:**

> ```ts
> // 3–10 line excerpt
> ```
>
> The handler does X without checking Y, so an attacker can …

**Why it matters:** concrete attacker scenario in one paragraph.

**Recommendation:** specific fix, ideally a one-line code change or a named
pattern already used elsewhere in the codebase.

**Verification needed (if any):** what would confirm exploitability at runtime.

### F-002 — …
````

Order findings strictly by severity, then by likelihood. Use stable IDs
(`F-001`, `F-002`) so they can be referenced in follow-up commits.

## Anti-patterns to avoid in the report

- ❌ "Consider adding CSRF protection." → ✅ "POST `/api/foo` accepts a
  cookie-authenticated request with no token; an attacker-controlled page can
  trigger it cross-site."
- ❌ Listing every dependency version. → ✅ Naming the specific advisory and
  whether the vulnerable code path is reachable.
- ❌ "Auth might be broken." → ✅ Show the missing check at `file:line`.
- ❌ Marking everything High to look thorough. Follow the rubric.
