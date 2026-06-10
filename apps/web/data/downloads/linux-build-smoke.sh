#!/usr/bin/env bash
# Mirror the GitHub Actions Linux job locally inside WSL Ubuntu 24.04.
set -euo pipefail
SRC=/mnt/e/gh/rekordbox-mwrty/server
WORK=/tmp/companion-linux-build
echo "==SYNC=="
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a --delete \
  --exclude node_modules \
  --exclude release \
  --exclude dist \
  --exclude .next \
  "$SRC/" "$WORK/"
cd "$WORK"
echo "==INSTALL (pnpm)=="
pnpm install --no-frozen-lockfile 2>&1 | tail -3
echo "==REBUILD natives=="
pnpm rebuild audify electron better-sqlite3 2>&1 | tail -3
echo "==BUILD=="
pnpm build 2>&1 | tail -3
echo "==FLATTEN with npm=="
rm -rf node_modules
npm install --ignore-scripts --no-audit --no-fund 2>&1 | tail -2
npm rebuild audify better-sqlite3 2>&1 | tail -2 || true
echo "==ASSETS=="
ls assets/virtual-audio/
echo "==ELECTRON-BUILDER --linux --x64=="
USE_SYSTEM_FPM=false ./node_modules/.bin/electron-builder --linux --x64 --publish never 2>&1 | tail -50
echo "==RELEASE ARTIFACTS=="
ls -lh release/
