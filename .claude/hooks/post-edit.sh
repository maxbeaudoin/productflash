#!/usr/bin/env bash
# PostToolUse hook for Write | Edit | NotebookEdit.
# Formats the single file Claude just modified.
#
# Stdin payload (relevant fields):
#   .tool_name              -> "Write" | "Edit" | "NotebookEdit"
#   .tool_input.file_path   -> absolute path of the file just modified
#
# Exit 0: allow. Exit 2: block + feed stderr back to Claude.

set -euo pipefail

REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$REPO"

payload="$(cat)"
file_path="$(jq -r '.tool_input.file_path // ""' <<<"$payload")"

# Nothing to format if no path was supplied.
[[ -z "$file_path" ]] && exit 0

# Skip anything outside the repo root (e.g. /tmp scratch files).
case "$file_path" in
  "$REPO"/*) ;;
  *) exit 0 ;;
esac

# Skip files that no longer exist (Write may have been a no-op, etc.).
[[ -f "$file_path" ]] || exit 0

# Only format file types oxfmt understands. Extend as needed.
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json) ;;
  *) exit 0 ;;
esac

# oxfmt is fast and idempotent; rewriting the just-edited file is fine.
pnpm exec oxfmt "$file_path" >/dev/null 2>&1 || {
  echo "oxfmt failed on $file_path" >&2
  exit 2
}

exit 0
