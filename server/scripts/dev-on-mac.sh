#!/usr/bin/env bash
# dev-on-mac.sh — run the Companion in dev mode on the Mac VM with live source.
#
# Strategy:
#   1. rsync src/, ui/, package.json, tsconfig.json from this host to the VM.
#   2. On the VM: npm install (flat tree), tsc build, then launch electron
#      with --inspect / --remote-debugging-port for VS Code attach.
#
# Usage (from inside Ubuntu-24.04 WSL with sshpass):
#   bash dev-on-mac.sh
#
# Env vars (override defaults):
#   MAC_HOST      127.0.0.1
#   MAC_PORT      10022
#   MAC_USER      dragos
#   MAC_PASS      papuci123
#   MAC_DIR       /Users/dragos/companion-dev
#   INSPECT_PORT  9229
#   DEVTOOLS_PORT 9222

set -euo pipefail

MAC_HOST=${MAC_HOST:-127.0.0.1}
MAC_PORT=${MAC_PORT:-10022}
MAC_USER=${MAC_USER:-dragos}
MAC_PASS=${MAC_PASS:-papuci123}
MAC_DIR=${MAC_DIR:-/Users/dragos/companion-dev}
INSPECT_PORT=${INSPECT_PORT:-9229}
DEVTOOLS_PORT=${DEVTOOLS_PORT:-9222}

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "[dev] source: $SRC_ROOT"
echo "[dev] target: $MAC_USER@$MAC_HOST:$MAC_PORT:$MAC_DIR"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$MAC_PORT")
SCP_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -P "$MAC_PORT")

# Non-interactive ssh sessions don't source ~/.zshrc, so we prepend the
# tarball-installed node bin dir explicitly. install-node.sh symlinks
# node/npm/npx into ~/bin.
REMOTE_PATH='export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

run_remote() {
  sshpass -p "$MAC_PASS" ssh "${SSH_OPTS[@]}" "$MAC_USER@$MAC_HOST" "$REMOTE_PATH; $*"
}

echo "[dev] ensuring target dir exists"
run_remote "mkdir -p '$MAC_DIR'"

echo "[dev] syncing source (tar over ssh — rsync may not be on the VM)"
( cd "$SRC_ROOT" && tar -czf - --exclude=node_modules --exclude=dist --exclude=release \
    package.json tsconfig.json src ui assets python scripts ) \
  | sshpass -p "$MAC_PASS" ssh "${SSH_OPTS[@]}" "$MAC_USER@$MAC_HOST" \
    "cd '$MAC_DIR' && tar -xzf -"

echo "[dev] killing previous dev electron"
run_remote "pkill -f 'companion-dev/.*electron' 2>/dev/null || true; sleep 1"

echo "[dev] installing deps + build (flat npm tree, omit dev)"
run_remote "cd '$MAC_DIR' \
  && (test -f node_modules/.installed || (npm install --no-audit --no-fund && touch node_modules/.installed)) \
  && npx --no -- tsc"

# Re-install if package.json changed since last touch.
run_remote "cd '$MAC_DIR' \
  && if [ package.json -nt node_modules/.installed ]; then \
       echo '[dev] package.json changed → reinstall'; \
       rm -rf node_modules; \
       npm install --no-audit --no-fund; \
       touch node_modules/.installed; \
     fi"

# Native modules (better-sqlite3, audify) are compiled against Node ABI by
# default; rebuild against Electron's V8 ABI so dlopen succeeds at runtime.
run_remote "cd '$MAC_DIR' \
  && if [ ! -f node_modules/.electron-rebuilt ] || [ package.json -nt node_modules/.electron-rebuilt ]; then \
       echo '[dev] electron-rebuild (better-sqlite3, audify)'; \
       npx --no -- electron-rebuild -f -w better-sqlite3 -w audify || exit 1; \
       touch node_modules/.electron-rebuilt; \
     fi"

echo "[dev] launching electron with --inspect=0.0.0.0:$INSPECT_PORT"
echo "[dev] DevTools (renderer): http://127.0.0.1:$DEVTOOLS_PORT"
echo "[dev] Inspector (main):    chrome://inspect → 127.0.0.1:$INSPECT_PORT"
echo "[dev] (forward both ports to the host with: ssh -L $INSPECT_PORT:127.0.0.1:$INSPECT_PORT -L $DEVTOOLS_PORT:127.0.0.1:$DEVTOOLS_PORT ...)"

# Kill the installed Companion to free port 17899 (dev binds the same port).
# We use SIGTERM so the app exits cleanly without rebooting the VM.
run_remote "pkill -TERM -f '/Applications/MMO Companion.app' 2>/dev/null || true; sleep 2"

# noglob disables zsh's expansion of '*' in --remote-allow-origins=*.
run_remote "cd '$MAC_DIR' \
  && rm -f /tmp/companion-dev.log \
  && setopt noglob 2>/dev/null; \
     nohup ./node_modules/.bin/electron \
       --inspect=0.0.0.0:$INSPECT_PORT \
       --remote-debugging-port=$DEVTOOLS_PORT \
       '--remote-allow-origins=*' \
       dist/main.js \
       >/tmp/companion-dev.log 2>&1 & \
     disown; \
     sleep 6; \
     echo '---LOG---'; \
     tail -50 /tmp/companion-dev.log; \
     echo '---PORTS---'; \
     lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '(17899|$INSPECT_PORT|$DEVTOOLS_PORT)' || echo '(no listeners yet)'"
