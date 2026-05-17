#!/usr/bin/env bash
# PreToolUse hook for Bash, gated to `git push`.
#
# Intentionally a no-op right now — CI runs typecheck + unit + integration
# + e2e + vite build on every PR push, so duplicating those locally was
# adding ~1-2 min per push for redundant signal. If you want extra
# confidence before pushing, run any of these manually:
#
#   pnpm typecheck
#   pnpm test
#   pnpm test:integration   # needs Docker, ~50s
#   pnpm test:e2e           # needs Docker + Chromium, ~30s+ container boot
#   pnpm build              # ~30-60s
#
# Kept as a file (rather than removed from settings.json) so it's easy to
# revive a single targeted check here later without re-wiring the hook
# registration. Exits 0 immediately.

exit 0
