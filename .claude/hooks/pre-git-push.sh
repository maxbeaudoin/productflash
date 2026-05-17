#!/usr/bin/env bash
# PreToolUse hook for Bash, gated to `git push`.
# Runs checks scoped to the *diff between local HEAD and upstream*:
#   1. vite build           — full production build (cannot be scoped)
#   2. vitest related       — integration tests touching changed TS/JS
#   3. smoke                — skipped locally; lives in .github/workflows/smoke.yml
#
# E2E is *not* run pre-push — it takes ~30s+ for container boot alone and
# CI already covers it on every PR. Run it manually with `pnpm test:e2e`
# when touching landing pages, the FTE flow, auth, or anything user-facing.
#
# Exit 0: allow. Exit 2: block + feed stderr back to Claude.

set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO"

payload="$(cat)"
command="$(jq -r '.tool_input.command // ""' <<<"$payload")"

if ! grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+push([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

# Resolve a base ref to diff against. Prefer the branch's upstream; fall back
# to origin/main; fall back to main. If none exist (first push of a new repo),
# diff against the empty tree so every file counts as changed.
if base=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  :
elif git rev-parse --verify origin/main >/dev/null 2>&1; then
  base="origin/main"
elif git rev-parse --verify main >/dev/null 2>&1; then
  base="main"
else
  base=$(git hash-object -t tree /dev/null) # empty tree SHA
fi

mapfile -t CHANGED < <(git diff --name-only "$base"...HEAD)
if [[ ${#CHANGED[@]} -eq 0 ]]; then
  echo "pre-push: no changes vs $base, skipping heavy checks" >&2
  exit 0
fi

TS_JS=()
for f in "${CHANGED[@]}"; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) TS_JS+=("$f") ;;
  esac
done

fail() { echo "pre-push BLOCKED: $*" >&2; exit 2; }

# 1. Production build — catches TanStack Start router codegen / SSR-only
#    breakage that typecheck + unit tests miss.
pnpm build || fail "vite build failed"

# 2. Integration tests scoped to changed TS/JS.
if [[ ${#TS_JS[@]} -gt 0 ]]; then
  pnpm exec vitest related --run --config vitest.integration.config.ts "${TS_JS[@]}" \
    || fail "integration tests failed"
fi

# 3. Smoke — .github/workflows/smoke.yml pings PRODUCTION_URL/healthz on
#    a schedule. Nothing to run locally pre-push.

exit 0
