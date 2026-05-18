#!/usr/bin/env bash
# PreToolUse hook for Bash, gated to `git push`.
# Runs the CI "fast" job locally before letting a push through:
#   1. pnpm typecheck   — tsr generate + tsgo --noEmit
#   2. pnpm test        — vitest run (unit suite)
#
# Mirrors .github/workflows/ci.yml `fast` job. Integration + e2e are NOT
# run here (Docker boot + Chromium pull would put pushes in the multi-min
# range); CI still gates those. Goal is to cut CI red-bar churn without
# making the loop unusably slow.
#
# Exit 0: allow. Exit 2: block + feed stderr back to Claude.

set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO"

payload="$(cat)"
command="$(jq -r '.tool_input.command // ""' <<<"$payload")"

# Only act on `git push` (not push-to-checkout, push --help, etc.).
if ! grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+push([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

# Cheap escape hatches that shouldn't pay the typecheck/test tax.
if grep -Eq -- '--help|--dry-run|--delete' <<<"$command"; then
  exit 0
fi

fail() { echo "pre-push BLOCKED: $*" >&2; exit 2; }

echo "pre-push: running typecheck + unit (CI fast-job equivalent)…" >&2

pnpm typecheck >&2 || fail "typecheck failed — fix before pushing (pnpm typecheck)"
pnpm test      >&2 || fail "unit tests failed — fix before pushing (pnpm test)"

exit 0
