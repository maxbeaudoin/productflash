---
name: task
description: Create a new Linear task in the ProductFlash team. Invoked via `/task <one-line description>` or `/task` (then ask). Captures title, description, labels, blockers/dependencies, and optionally fast-tracks it (state=Todo + priority=Urgent) so `/checkout` picks it up next. Optimized for low-friction capture — one round of clarifying questions max.
---

# /task — Create a Linear task

Goal: get an idea into Linear with the minimum number of round trips. Default to acting; only ask when something is genuinely ambiguous or load-bearing.

Linear team: `ProductFlash` (id `3f3a4fdb-a805-4032-b921-f1314e957e93`, key `PF`).

---

## Step 1 — Extract the seed

- **Args present** (`/task <text>`): treat the text as the seed for the issue. Derive the title (short imperative, <70 chars) and use the rest as description fodder.
- **No args**: ask the user in one `AskUserQuestion` round what the task is about (free-text). Don't proceed without a seed.

## Step 2 — Decide what needs clarifying (bundle into ONE AskUserQuestion call)

Only ask about fields that materially change the outcome. Skip every field you can infer or default. Bundle every remaining question into a single `AskUserQuestion` call (max 4 questions). Candidates:

1. **Fast-track?** Always ask unless the user explicitly said "fast-track" / "urgent" / "do this next" in the seed. Options: `Yes — fast-track (Todo + Urgent)` / `No — normal backlog item`.
2. **Labels** — only ask if the seed is ambiguous about area (e.g. could be `frontend` or `worker`). Otherwise infer from the seed and apply silently. First call `mcp__linear-server__list_issue_labels` with `team: "3f3a4fdb-a805-4032-b921-f1314e957e93"` once per session and cache mentally.
3. **Blockers / dependencies** — only ask if the seed hints at an order ("after we ship X", "once Y lands"). Otherwise skip. Accept Linear IDs (e.g. `PF-12`) or full issue identifiers.

**Priority is always inferred from the seed, never asked.** Default `Medium (3)`. Bump to `High (2)` for clear blocker/regression/data-loss/security signals; drop to `Low (4)` for nice-to-haves / polish / "someday". Fast-track always overrides to `Urgent (1)`.

Do NOT ask about: project, milestone, cycle, assignee, estimate, due date. Leave them unset.

If the seed is fully unambiguous AND the user explicitly fast-tracked, you may skip Step 2 entirely.

## Step 3 — Write the description

Markdown. Lead with **why** (the problem / motivation), then **what** (acceptance criteria as a short bullet list), then **notes** if any constraints came up in the seed. Keep it tight — 5–15 lines is the sweet spot. No filler, no "this task involves...".

If the seed already reads like a well-formed description, use it verbatim — don't reformat for the sake of reformatting.

## Step 4 — Create the issue

Call `mcp__linear-server__save_issue` with:

- `team: "3f3a4fdb-a805-4032-b921-f1314e957e93"`
- `title: <derived title>`
- `description: <step-3 markdown>` (use real newlines, not `\n`)
- `labels: [...]` (only if Step 2 produced any)
- `blockedBy: [...]` (only if Step 2 produced any)
- `priority`: `1` if fast-track, else inferred from seed (default `3` Medium)
- `state`: `"Todo"` if fast-track, else `"Backlog"`

Do NOT pass `id` (that's for updates).

## Step 5 — Report back

One line: `Created [PF-NN] <title> — <state>, <priority-name>[, labels: a, b][, blocked by: PF-XX]`. Include the Linear URL from the response. Then stop. Do not auto-chain into `/checkout` or anything else.

---

## Anti-patterns

- Asking a flurry of one-by-one questions when one `AskUserQuestion` call would do.
- Asking about fields the user can't reasonably care about for a backlog capture (estimate, due date, cycle).
- Writing a 30-line description when 8 lines would do. This is a capture tool, not a spec.
- Inventing labels that don't exist in the team — always source from `list_issue_labels`.
- Fast-tracking by default. Fast-track means "this jumps the queue"; it should be a deliberate choice.
- Creating in the wrong team. Always pass the ProductFlash team ID literally.
