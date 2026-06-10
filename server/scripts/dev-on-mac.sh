#!/usr/bin/env bash
# dev-on-mac.sh — run the Companion in dev mode on the Mac VM with live source.
#
# Usage:
#   bash dev-on-mac.sh             # one-shot deploy + launch
#   bash dev-on-mac.sh --watch     # deploy, then watch local files and
#                                  # sync incrementally on every change
#                                  # (tsc --watch + electronmon on the VM)
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

WATCH_MODE=0
if [ "${1:-}" = "--watch" ]; then WATCH_MODE=1; fi

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
echo "[dev] watch:  $WATCH_MODE"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$MAC_PORT")

# Non-interactive ssh sessions don't source ~/.zshrc, so we prepend the
# tarball-installed node bin dir explicitly. install-node-mac-vm.sh symlinks
# node/npm/npx into ~/bin.
REMOTE_PATH='export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

run_remote() {
  sshpass -p "$MAC_PASS" ssh "${SSH_OPTS[@]}" "$MAC_USER@$MAC_HOST" "$REMOTE_PATH; $*"
}

# tar-sync the listed top-level paths from $SRC_ROOT into $MAC_DIR. Used
# both for the initial seed and for incremental pushes from the watcher.
sync_paths() {
  ( cd "$SRC_ROOT" && tar -czf - --exclude=node_modules --exclude=dist --exclude=release "$@" ) \
    | sshpass -p "$MAC_PASS" ssh "${SSH_OPTS[@]}" "$MAC_USER@$MAC_HOST" "cd '$MAC_DIR' && tar -xzf -"
}

echo "[dev] ensuring target dir exists"
run_remote "mkdir -p '$MAC_DIR'"

echo "[dev] initial sync (package.json, tsconfig, src, ui, assets, python, scripts)"
sync_paths package.json tsconfig.json src ui assets python scripts

echo "[dev] killing previous dev electron + tsc-watch + electronmon"
run_remote "pkill -f 'companion-dev/.*electron' 2>/dev/null || true; \
            pkill -f 'companion-dev/.*tsc' 2>/dev/null || true; \
            pkill -f 'companion-dev/.*electronmon' 2>/dev/null || true; \
            sleep 1"

echo "[dev] installing deps + initial build"
run_remote "cd '$MAC_DIR' \
  && (test -f node_modules/.installed || (npm install --no-audit --no-fund && touch node_modules/.installed)) \
  && ./node_modules/.bin/tsc"

# Re-install if package.json changed since last touch.
run_remote "cd '$MAC_DIR' \
  && if [ package.json -nt node_modules/.installed ]; then \
       echo '[dev] package.json changed → reinstall'; \
       rm -rf node_modules; \
       npm install --no-audit --no-fund; \
       touch node_modules/.installed; \
       rm -f node_modules/.electron-rebuilt; \
     fi"

# Native modules (better-sqlite3, audify) are compiled against Node ABI by
# default; rebuild against Electron's V8 ABI so dlopen succeeds at runtime.
run_remote "cd '$MAC_DIR' \
  && if [ ! -f node_modules/.electron-rebuilt ] || [ package.json -nt node_modules/.electron-rebuilt ]; then \
       echo '[dev] electron-rebuild (better-sqlite3, audify)'; \
       ./node_modules/.bin/electron-rebuild -f -w better-sqlite3 -w audify || exit 1; \
       touch node_modules/.electron-rebuilt; \
     fi"

# Free port 17899 — the installed Companion binds it on launch.
run_remote "pkill -TERM -f '/Applications/MMO Companion.app' 2>/dev/null || true; sleep 2"

if [ "$WATCH_MODE" = "1" ]; then
  echo "[dev] starting tsc --watch on the VM"
  run_remote "cd '$MAC_DIR' && nohup ./node_modules/.bin/tsc --watch --preserveWatchOutput \
                >/tmp/companion-tsc.log 2>&1 & disown; sleep 2; tail -5 /tmp/companion-tsc.log"

  echo "[dev] starting electronmon on the VM (auto-restart on dist/ + ui/ changes)"
  echo "[dev] (debug ports disabled in watch mode to avoid restart collisions;"
  echo "[dev]  open renderer DevTools with View menu / Cmd+Opt+I instead)"
  run_remote "cd '$MAC_DIR' \
    && rm -f /tmp/companion-dev.log \
    && nohup ./node_modules/.bin/electronmon . \
         >/tmp/companion-dev.log 2>&1 & \
       disown; \
       sleep 6; \
       echo '---LOG---'; tail -40 /tmp/companion-dev.log; \
       echo '---PORTS---'; lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '17899' || echo '(none yet)'"

  echo "[dev] starting host-side file watcher (chokidar) — Ctrl+C to stop"
  # Use the chokidar shipped with the host-side server install so we don't
  # depend on a global node_modules in WSL.
  cd "$SRC_ROOT"
  exec node "$SRC_ROOT/scripts/watch-mac-sync.mjs"
else
  echo "[dev] launching electron (one-shot)"
  echo "[dev] DevTools (renderer): http://127.0.0.1:$DEVTOOLS_PORT"
  echo "[dev] Inspector (main):    chrome://inspect → 127.0.0.1:$INSPECT_PORT"
  run_remote "cd '$MAC_DIR' \
    && rm -f /tmp/companion-dev.log \
    && setopt noglob 2>/dev/null; \
       nohup ./node_modules/.bin/electron \
         --inspect=0.0.0.0:$INSPECT_PORT \
         --remote-debugging-port=$DEVTOOLS_PORT \
         '--remote-allow-origins=*' \
         . \
         >/tmp/companion-dev.log 2>&1 & \
       disown; \
       sleep 6; \
       echo '---LOG---'; tail -50 /tmp/companion-dev.log; \
       echo '---PORTS---'; lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '(17899|$INSPECT_PORT|$DEVTOOLS_PORT)' || echo '(none yet)'"
fi
