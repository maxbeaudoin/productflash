---
name: checkout
description: Pick up a Linear task and execute it end-to-end on a fresh branch. Invoked via `/checkout` (no args → pick the highest-priority unblocked issue in the ProductFlash team) or `/checkout <LINEAR-ID>` (e.g. `/checkout PF-12` → work that specific issue). Loads the Linear issue into context, branches from main, executes, validates, opens a PR, squash-merges. Pairs with CLAUDE.md (Karpathy rules + stack + hard rules — don't restate them here).
---

# /checkout — Linear-driven task execution

You've been delegated end-to-end execution of one Linear task. Goal: ship it cleanly. Optimize for correctness, not the appearance of progress. CLAUDE.md has the Karpathy rules, stack, and hard rules — they apply throughout; do not restate them.

Linear team: `ProductFlash` (id `3f3a4fdb-a805-4032-b921-f1314e957e93`, key `PF`).

---

## Step 1 — Resolve the task

**With an argument** (`/checkout PF-12`, `/checkout 12`, full UUID, or a Linear URL): pass it directly to `mcp__linear-server__get_issue` as the `id` field — it accepts identifiers, slugs, and URLs.

**Without an argument**: call `mcp__linear-server__list_issues` with:

- `team: "3f3a4fdb-a805-4032-b921-f1314e957e93"`
- `state: "Todo"` (and/or `"Backlog"` if Todo is empty)
- `orderBy: "updatedAt"`
- `includeArchived: false`

Then pick the first issue where ALL hold:

- Priority is highest available (Urgent → High → Medium → Low → No priority).
- No open blocking relations (check `relations` for `blocks`/`blocked_by`; if blockers aren't all Done, skip).
- Assignee is `me` or unassigned. (Don't poach someone else's task.)

If everything is blocked, surface which issue is the blocker and stop. If the backlog is empty, say so and stop.

## Step 2 — Load into context, then confirm

Read the issue's title, description, labels, project, and any linked documents. Skim recent comments. If the issue references files or PRs, open them. Then:

1. Make sure you understand the requirements, ask multi-choice questions, and flag blockers.

If the task is ambiguous or you see two plausible interpretations, use `AskUserQuestion` with concrete options. Don't pick silently.

If the working tree is dirty, do NOT start a new task — surface the dirty files and ask whether to stash, commit, or resume the implicit in-progress work.

## Step 3 — Branch from main

2. Checkout a new branch from main and make sure your local main is up to date:

```
git checkout main
git status --porcelain
git pull --ff-only
git checkout -b feat|fix|chore|docs|refactor|test/<branch-name>
```

Branch slug must include the Linear identifier (e.g. `feat/pf-12-add-waitlist-form`) so PRs trace back automatically. Move the Linear issue to "In Progress" via `mcp__linear-server__save_issue` with `state: "In Progress"` as soon as the branch is checked out.

## Step 4 — Execute

Follow CLAUDE.md. Karpathy's 4 rules + hard rules + tech-stack discipline apply — they are not repeated here.

When the task needs external access you can't perform (Neon console, Railway dashboard, Resend domain, recruiting beta users): do everything you can offline, then pause with a concrete numbered list of what the user needs to do. Don't move the Linear issue to "Done" until those external steps are confirmed.

Commit incrementally with explicit file paths (never `git add .` / `-A`). Use HEREDOC commit messages. Never `--amend`, never `--no-verify`. Reference the Linear ID in the commit footer (e.g. `Refs PF-12`).

## Step 5 — Validate your own work

Using `mcp__chrome-devtools__`, and the `psql` and `curl` CLIs:

1. Write tests for your code and make sure they pass.
2. Start the development server and test your changes in the browser.
3. Query the database to verify that your changes are reflected correctly.
4. Send requests to test your API endpoints if applicable.
5. Check the console for any errors or warnings and address them.
6. Write tmp ts scripts to validate more intricate changes if necessary.

* Only run relevant e2e tests locally (they can be slow); the full suite will run in CI.
* Always ask the user to validate the screenshots and provide feedback before moving to the PR stage.

Capture screenshots of any visible surface to `/tmp/<linear-id>-<slug>.png` and embed them in your report. Non-UI work (schema, adapter, internal pipeline) → note "no UI surface affected" and skip cleanly.

## Step 6 — Definition of done

Using the `gh` CLI:

1. Open a pull request.
2. Make sure all checks have passed.
3. Squash merge into main.

**Checklist:**
- [ ] Code is complete and you validated your own work
- [ ] User has approved screenshots and feedback is incorporated (if applicable)
- [ ] All PR checks have passed
- [ ] Code is merged into main

* Use `Monitor` to watch for CI checks: 15s timeout.

PR title: short imperative, <70 chars. PR body must include `Closes PF-<n>` so Linear auto-transitions the issue to Done on merge. After squash-merge, verify the Linear issue moved to Done; if not, move it manually via `mcp__linear-server__save_issue`.

Then stop. Do not auto-chain into another `/checkout`.

---

## Anti-patterns

- Marking the Linear issue Done while typecheck fails, tests fail, or the feature visibly doesn't work.
- Picking a task assigned to someone else.
- Picking a task whose blockers aren't all Done.
- Inventing scope mid-task. Real follow-up work → create a new Linear issue, don't expand the current one.
- Committing screenshots into the repo. They live in `/tmp/` and ship inline in the report.
- Skipping the user's screenshot review for UI work because "it's obvious."
- Running destructive git ops (force-push, reset --hard, branch -D) without explicit authorization.
