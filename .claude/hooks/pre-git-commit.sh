#!/usr/bin/env bash
# PreToolUse hook for Bash, gated to `git commit`.
# Runs scoped checks against the *staged* set — only the FAST ones, so a
# commit never feels slow. CI is the gate of record for typecheck and tests.
#   1. oxfmt   — format staged files (auto-fix + re-stage)
#   2. .only guard — block focused tests from being committed
#   3. oxlint  — lint staged TS/JS files
#   4. gitleaks — secret scan on staged diff (skip with warning if missing)
#   5. drizzle-kit check — only if schema or drizzle/ changed (gated)
#   6. env:lint — only if env files / modules moved (gated)
#
# Dropped (CI covers both, locally they add ~10-30s each per commit):
#   - tsgo --noEmit project-wide typecheck
#   - vitest related (unit tests for staged TS/JS)
# Run them manually before pushing if you want extra confidence.
#
# Exit 0: allow. Exit 2: block + feed stderr back to Claude.

set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO"

payload="$(cat)"
command="$(jq -r '.tool_input.command // ""' <<<"$payload")"

# Only act on `git commit` (not commit-tree, commit-graph, etc.).
if ! grep -Eq '(^|[^[:alnum:]_-])git[[:space:]]+commit([[:space:]]|$)' <<<"$command"; then
  exit 0
fi

# Staged files (Added/Copied/Modified/Renamed; drop Deleted).
mapfile -t STAGED < <(git diff --cached --name-only --diff-filter=ACMR)
if [[ ${#STAGED[@]} -eq 0 ]]; then
  echo "pre-commit: no staged files, nothing to check" >&2
  exit 0
fi

# Subsets used by individual tools.
TS_JS=()
FORMATTABLE=()
TEST_FILES=()
SCHEMA_TOUCHED=0
ENV_TOUCHED=0
for f in "${STAGED[@]}"; do
  [[ -f "$f" ]] || continue
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
      TS_JS+=("$f")
      FORMATTABLE+=("$f")
      ;;
    *.json)
      FORMATTABLE+=("$f")
      ;;
  esac
  case "$f" in
    *.test.ts|*.test.tsx|tests/**) TEST_FILES+=("$f") ;;
  esac
  case "$f" in
    src/db/*|drizzle/*|drizzle.config.ts) SCHEMA_TOUCHED=1 ;;
  esac
  case "$f" in
    .env|.env.example|.env.production|src/lib/env.ts|src/lib/env-keys.ts|scripts/env-lint.ts)
      ENV_TOUCHED=1
      ;;
  esac
done

fail() { echo "pre-commit BLOCKED: $*" >&2; exit 2; }

# 1. Format + re-stage. oxfmt is idempotent and fast.
if [[ ${#FORMATTABLE[@]} -gt 0 ]]; then
  pnpm exec oxfmt "${FORMATTABLE[@]}" >/dev/null || fail "oxfmt failed"
  git add -- "${FORMATTABLE[@]}"
fi

# 2. .only guard — focused tests silently shrink CI coverage.
if [[ ${#TEST_FILES[@]} -gt 0 ]]; then
  if grep -nE '\b(describe|it|test)\.only\s*\(' "${TEST_FILES[@]}" 2>/dev/null; then
    fail "focused tests (.only) in staged files — remove before committing"
  fi
fi

# 3. Lint staged TS/JS.
if [[ ${#TS_JS[@]} -gt 0 ]]; then
  pnpm exec oxlint "${TS_JS[@]}" || fail "oxlint reported issues"
fi

# 4. Secret scan. Prefer the project-local binary (installed by
#    scripts/install-gitleaks.sh via package.json postinstall); fall back to
#    any system gitleaks; otherwise self-heal by running the installer.
GITLEAKS=""
if [[ -x "$REPO/bin/gitleaks" ]]; then
  GITLEAKS="$REPO/bin/gitleaks"
elif command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS="$(command -v gitleaks)"
elif [[ -x "$REPO/scripts/install-gitleaks.sh" ]]; then
  echo "pre-commit: gitleaks missing — running scripts/install-gitleaks.sh" >&2
  "$REPO/scripts/install-gitleaks.sh" >&2 && GITLEAKS="$REPO/bin/gitleaks"
fi
if [[ -n "$GITLEAKS" ]]; then
  "$GITLEAKS" git --pre-commit --staged --redact --no-banner \
    || fail "gitleaks found a secret in the staged diff"
else
  echo "pre-commit: gitleaks unavailable — skipping secret scan" >&2
fi

# 5. Drizzle migration sanity check — only when schema or migrations moved.
if [[ "$SCHEMA_TOUCHED" -eq 1 ]]; then
  pnpm exec drizzle-kit check || fail "drizzle-kit check failed"
fi

# 6. Env cross-check — only when any of the env files / env modules moved.
# Catches drift between .env.example, .env.production and the Zod schema
# before it lands in main and breaks a deploy.
if [[ "$ENV_TOUCHED" -eq 1 ]]; then
  pnpm env:lint || fail "env-lint reported issues"
fi

exit 0
