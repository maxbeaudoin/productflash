#!/usr/bin/env bash
# Installs a project-local gitleaks binary at ./bin/gitleaks.
# Idempotent: if the requested version is already present, exits 0 quickly.
# Invoked from package.json's `postinstall` so fresh clones get it automatically.

set -euo pipefail

VERSION="${GITLEAKS_VERSION:-8.30.1}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/bin"
BIN="$BIN_DIR/gitleaks"

if [[ -x "$BIN" ]] && "$BIN" version 2>/dev/null | grep -q "$VERSION"; then
  exit 0
fi

OS_RAW="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH_RAW="$(uname -m)"

case "$OS_RAW" in
  linux)  OS="linux" ;;
  darwin) OS="darwin" ;;
  msys*|mingw*|cygwin*) OS="windows" ;;
  *) echo "install-gitleaks: unsupported OS '$OS_RAW'" >&2; exit 1 ;;
esac

case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "install-gitleaks: unsupported arch '$ARCH_RAW'" >&2; exit 1 ;;
esac

if [[ "$OS" == "windows" ]]; then
  ASSET="gitleaks_${VERSION}_${OS}_${ARCH}.zip"
else
  ASSET="gitleaks_${VERSION}_${OS}_${ARCH}.tar.gz"
fi

URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ASSET}"

mkdir -p "$BIN_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install-gitleaks: downloading $ASSET" >&2
curl -fsSL "$URL" -o "$tmp/$ASSET"

if [[ "$ASSET" == *.zip ]]; then
  (cd "$tmp" && unzip -q "$ASSET")
else
  tar -xzf "$tmp/$ASSET" -C "$tmp"
fi

# Tarball ships the binary at the archive root.
src="$tmp/gitleaks"
[[ "$OS" == "windows" ]] && src="$tmp/gitleaks.exe"
[[ -f "$src" ]] || { echo "install-gitleaks: binary not found in archive" >&2; exit 1; }

install -m 0755 "$src" "$BIN"
echo "install-gitleaks: installed $("$BIN" version) at $BIN" >&2
