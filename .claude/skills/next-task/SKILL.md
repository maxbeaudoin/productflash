---
name: next-task
description: Pick up the next unblocked task from TASKS.md and execute it end-to-end with high quality. Use only when the user explicitly invokes /next-task or asks to "work the next task" / "do the next thing" on the Product Flash PoC. Reads SCOPE.md + CLAUDE.md, updates TASKS.md status, commits incrementally, reports back. Do not auto-chain to the following task.
---

# /next-task — Product Flash PoC executor

You've been delegated task selection + execution for the Product Flash PoC. The user is intentionally not specifying which task. Your job is to pick the right one, do it well, and report honestly. Optimize for correctness, not the appearance of progress.

---

## Step 1 — Orient (always)

Read these before touching anything else:
1. `CLAUDE.md` — locked stack + hard rules (re-read even if auto-loaded; rules drift if you don't)
2. `TASKS.md` — current task statuses: ☐ pending · ⏳ in-progress · ✅ done
3. `git log --oneline -10` and `git status --short` — see what's actually been done and what's uncommitted

If there is uncommitted work, do NOT pick a new task. Either resume the implicit in-progress task or ask the user what to do with the dirty tree.

## Step 2 — Pick the next task

From `TASKS.md`, select the first task where ALL hold:
- Status is ☐ (pending)
- All entries in its `Blocked by:` line are ✅ in `TASKS.md`
- Lowest task ID among eligible candidates

Edge cases:
- A task is already ⏳ in `TASKS.md` → resume it; check git for partial work first.
- All remaining tasks are blocked → tell the user which task is the blocker and stop.
- Backlog empty (all ✅) → tell the user, suggest the next thing per `SCOPE.md` §7.

## Step 3 — Frame the work

State in one sentence what you're picking up. Don't ask for permission — the user invoked you to act. Then read the SCOPE.md sections that touch the task:
- Schema work → §5 Data model
- Source adapter → §3 Sources + §4 Architecture
- Pipeline job → §6 Daily pipeline
- Frontend → §4.1 Frontend & design system + §4.2 Landing page
- Email → §4.1 (tokens module is shared)
- Launch / success → §7 Milestones + §8 Success criteria

Read any existing code in the area. Actually open the files — don't trust grep alone.

## Step 4 — Mark in-progress

In `TASKS.md`, change the task's status icon from ☐ to ⏳. Do NOT commit yet — the status flip ships with the work in one commit.

## Step 5 — Execute

Hard rules from `CLAUDE.md` are non-negotiable. Restating the load-bearing ones:
- **Use existing APIs for ingestion** (Firehose / Firecrawl / RSS / PH). No custom crawlers.
- **pg-boss for scheduling.** Never Railway cron, never Redis/BullMQ.
- **Shared design tokens** (`src/design/tokens.ts`) — web UI and React Email import from the same file.
- **Pixel-identical landing port** — task #14 must compare 1:1 to `executive-summary.html`.
- **No scope creep** — competitor moves pillar only. Refuse "while we're at it…" expansions.

Coding conventions:
- Use Edit / Write for file changes, not Bash heredocs.
- Match style of any existing code. If repo is empty, default to: 2-space indent, ESM, named exports, no default exports, async/await over .then.
- Default to writing no comments. Add one only when WHY is non-obvious.
- Don't add features, fallbacks, or validation beyond the task scope.

### When the task needs external access you can't perform

Tasks that touch external accounts (Neon, Railway, Resend, Anthropic, PostHog, Firehose, Firecrawl, Product Hunt, recruiting beta users): do everything you can offline, then pause with concrete next steps. Example:

> "I've scaffolded the Drizzle config and added the env schema. To proceed I need you to:
> 1. Create a Neon project at console.neon.tech
> 2. Paste the `DATABASE_URL` into `.env`
> 3. Tell me when done — I'll run the first migration."

Don't mark the task ✅ until those external steps are confirmed.

## Step 6 — Validate before declaring done

Pick the relevant checks; never skip them to look productive.

| Task type | Required validation |
|---|---|
| Schema (#2) | Migration generates cleanly; applies to dev DB; one insert + select works |
| Source adapter (#3–#6) | Real call returns real items; dedupe holds across 2 runs; normalizer output matches `raw_items` shape |
| Pipeline job (#7, #9, #10, #17) | `pnpm typecheck` clean; manually trigger job once; verify rows in DB |
| Email template (#11) | Renders without errors via React Email preview; tokens consumed correctly; sends to a test address |
| Feedback endpoint (#12) | `GET /r/<id>/up` records row and redirects; signed-token tampering rejected |
| Landing port (#14) | `pnpm dev` running; open `/` and `executive-summary.html` side-by-side; eyeball each section for pixel match |
| Competitor picker (#15) | Typeahead works, RSS autodetect resolves at least one real homepage |
| Admin (#16) | Basic auth blocks anon; preview renders the same React Email template the worker uses |
| Design system (#21) | `pnpm typecheck` clean; one shadcn component renders with brand tokens; Inter + JetBrains Mono load self-hosted |
| Signup form (#22) | Form submits; user + competitor rows appear in DB; PostHog event fires |
| Dogfood / launch (#13, #18, #19) | Real send to real inbox; user confirmation |

If validation fails, fix the root cause. Don't ship known-broken work behind a ✅.

## Step 7 — Commit + flip TASKS.md to ✅

When the work is genuinely complete:
1. Update the task's status icon in `TASKS.md` from ⏳ to ✅
2. Stage changes with explicit file paths (NOT `git add .` / `-A`)
3. Commit via HEREDOC:

```
git commit -m "$(cat <<'EOF'
<short imperative subject, <70 chars>

<2-4 lines on what changed and why, when non-obvious>

Refs TASKS.md #<id>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Never `--amend`, never `--no-verify`. If a pre-commit hook fails, fix and commit anew.

## Step 8 — Report and STOP

Three lines max:
- ✅ **Task #N done** — one-sentence outcome
- ➡️ **Next eligible:** #M `<subject>` (or "all blocked on …" / "backlog clear")
- ⚠️ **User action needed:** anything they must do before the next task can start (env vars, account setup, recruiting calls)

Then stop. Do not auto-chain into the next task — let the user re-invoke `/next-task` when ready.

---

## Anti-patterns (don't do these)

- Marking ✅ while typecheck fails, tests fail, or the feature visibly doesn't work.
- Letting in-session `TaskList` and `TASKS.md` drift. `TASKS.md` is the durable source — flip statuses there, in commits. The in-session list is scratchpad only.
- Inventing new scope mid-task. If you discover real follow-up work, append a new entry to `TASKS.md` rather than expanding the current one.
- Committing `.env`, generated `dist/` / `node_modules/`, or large binaries. Stage explicitly.
- Running destructive ops (force-push, reset --hard, branch -D) without user authorization.
- Skipping the side-by-side visual check on task #14 — pixel match is the entire acceptance bar.
