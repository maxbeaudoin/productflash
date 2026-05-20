#!/usr/bin/env bash
# Usage:
#   pnpm db                            # local .env, interactive psql
#   pnpm db -c "select 1"              # local one-shot
#   pnpm db staging [psql args...]     # staging via Railway, read-only
#   pnpm db prod    [psql args...]     # prod via Railway, read-only
#   pnpm db prod --write [psql args]   # prod writable (confirm prompt)
set -euo pipefail

env="local"
if [[ "${1:-}" == "staging" || "${1:-}" == "prod" ]]; then
  env="$1"; shift
fi

write=false
if [[ "${1:-}" == "--write" ]]; then
  write=true; shift
fi

if [[ "$env" == "local" ]]; then
  if [[ ! -f .env ]]; then echo ".env not found" >&2; exit 1; fi
  url="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
  url="${url%\"}"; url="${url#\"}"
  if [[ -z "$url" ]]; then echo "DATABASE_URL not found in .env" >&2; exit 1; fi
  url="$(echo "$url" | sed -E 's/[&?]channel_binding=[^&]*//')"
  exec psql "$url" "$@"
fi

case "$env" in
  staging) rail_env=staging ;;
  prod)    rail_env=production
           if [[ "$write" == true ]]; then
             read -r -p "PROD WRITE. type 'prod-write' to confirm: " c
             [[ "$c" == "prod-write" ]] || { echo aborted >&2; exit 1; }
           fi ;;
esac

# Neon's pooler rejects `default_transaction_read_only` as a startup option,
# so we set it post-connect via PSQLRC. psql sources PSQLRC after connecting
# but before -c queries / interactive input, which gives us the same guard.
psqlrc=""
if [[ "$write" != true ]]; then
  psqlrc="$(mktemp)"
  trap 'rm -f "$psqlrc"' EXIT
  echo "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;" >"$psqlrc"
fi

exec railway run --environment="$rail_env" --service=worker \
  -- bash -c 'PSQLRC="$1" exec psql "$DATABASE_URL" "${@:2}"' _ "$psqlrc" "$@"
