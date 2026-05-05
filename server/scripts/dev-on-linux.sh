#!/usr/bin/env bash
# dev-on-linux.sh — run the Companion in dev mode on the Ubuntu VM with live source.
#
# Usage:
#   bash dev-on-linux.sh             # one-shot deploy + launch
#   bash dev-on-linux.sh --watch     # deploy, then watch local files and
#                                    # sync incrementally on every change
#                                    # (tsc --watch + electronmon on the VM)
#
# Env vars (override defaults):
#   LINUX_HOST      127.0.0.1
#   LINUX_PORT      10024
#   LINUX_USER      dragos
#   LINUX_PASS      papuci123
#   LINUX_DIR       /home/dragos/companion-dev
#   INSPECT_PORT    9229
#   DEVTOOLS_PORT   9222
#   DISPLAY_REMOTE  :0          # X11 display for the desktop session

set -euo pipefail

WATCH_MODE=0
if [ "${1:-}" = "--watch" ]; then WATCH_MODE=1; fi

LINUX_HOST=${LINUX_HOST:-127.0.0.1}
LINUX_PORT=${LINUX_PORT:-10024}
LINUX_USER=${LINUX_USER:-dragos}
LINUX_PASS=${LINUX_PASS:-papuci123}
LINUX_DIR=${LINUX_DIR:-/home/dragos/companion-dev}
INSPECT_PORT=${INSPECT_PORT:-9229}
DEVTOOLS_PORT=${DEVTOOLS_PORT:-9222}
DISPLAY_REMOTE=${DISPLAY_REMOTE:-:0}

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "[dev] source: $SRC_ROOT"
echo "[dev] target: $LINUX_USER@$LINUX_HOST:$LINUX_PORT:$LINUX_DIR"
echo "[dev] watch:  $WATCH_MODE"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p "$LINUX_PORT")

# Preload DISPLAY/XDG_RUNTIME_DIR so Electron finds the user's desktop
# session and pactl can talk to the user's pipewire-pulse.
REMOTE_ENV='export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; \
            export DISPLAY='"$DISPLAY_REMOTE"'; \
            export XDG_RUNTIME_DIR=/run/user/$(id -u); \
            export PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native'

run_remote() {
  sshpass -p "$LINUX_PASS" ssh "${SSH_OPTS[@]}" "$LINUX_USER@$LINUX_HOST" "$REMOTE_ENV; $*"
}

sync_paths() {
  ( cd "$SRC_ROOT" && tar -czf - --exclude=node_modules --exclude=dist --exclude=release "$@" ) \
    | sshpass -p "$LINUX_PASS" ssh "${SSH_OPTS[@]}" "$LINUX_USER@$LINUX_HOST" "cd '$LINUX_DIR' && tar -xzf -"
}

echo "[dev] ensuring target dir exists"
run_remote "mkdir -p '$LINUX_DIR'"

echo "[dev] initial sync (package.json, tsconfig, src, ui, assets, python, scripts)"
sync_paths package.json tsconfig.json src ui assets python scripts

echo "[dev] killing previous dev electron + tsc-watch + electronmon"
run_remote "pkill -f 'companion-dev/.*electron' 2>/dev/null || true; \
            pkill -f 'companion-dev/.*tsc' 2>/dev/null || true; \
            pkill -f 'companion-dev/.*electronmon' 2>/dev/null || true; \
            sleep 1"

echo "[dev] installing deps + initial build"
run_remote "cd '$LINUX_DIR' \
  && (test -f node_modules/.installed || (npm install --no-audit --no-fund && touch node_modules/.installed)) \
  && ./node_modules/.bin/tsc"

# Re-install if package.json changed since last touch.
run_remote "cd '$LINUX_DIR' \
  && if [ package.json -nt node_modules/.installed ]; then \
       echo '[dev] package.json changed → reinstall'; \
       rm -rf node_modules; \
       npm install --no-audit --no-fund; \
       touch node_modules/.installed; \
       rm -f node_modules/.electron-rebuilt; \
     fi"

# Native modules (better-sqlite3, audify) must be rebuilt against Electron's
# V8 ABI, not the system Node ABI.
run_remote "cd '$LINUX_DIR' \
  && if [ ! -f node_modules/.electron-rebuilt ] || [ package.json -nt node_modules/.electron-rebuilt ]; then \
       echo '[dev] electron-rebuild (better-sqlite3, audify)'; \
       ./node_modules/.bin/electron-rebuild -f -w better-sqlite3 -w audify || exit 1; \
       touch node_modules/.electron-rebuilt; \
     fi"

# Free port 17899 — kill any installed Companion that may be holding it.
run_remote "pkill -TERM -f '/opt/MMO Companion/' 2>/dev/null || true; \
            pkill -TERM -f mmo-companion 2>/dev/null || true; \
            sleep 1"

if [ "$WATCH_MODE" = "1" ]; then
  echo "[dev] starting tsc --watch on the VM"
  run_remote "cd '$LINUX_DIR' && nohup ./node_modules/.bin/tsc --watch --preserveWatchOutput \
                >/tmp/companion-tsc.log 2>&1 & disown; sleep 2; tail -5 /tmp/companion-tsc.log"

  echo "[dev] starting electronmon on the VM (auto-restart on dist/ + ui/ changes)"
  run_remote "cd '$LINUX_DIR' \
    && rm -f /tmp/companion-dev.log \
    && nohup ./node_modules/.bin/electronmon . \
         >/tmp/companion-dev.log 2>&1 & \
       disown; \
       sleep 6; \
       echo '---LOG---'; tail -40 /tmp/companion-dev.log; \
       echo '---PORTS---'; ss -tlnp 2>/dev/null | grep -E '17899' || echo '(none yet)'"

  echo "[dev] starting host-side file watcher (chokidar) — Ctrl+C to stop"
  cd "$SRC_ROOT"
  exec node "$SRC_ROOT/scripts/watch-mac-sync.mjs" \
    --target "$LINUX_USER@$LINUX_HOST:$LINUX_PORT:$LINUX_DIR" \
    --pass "$LINUX_PASS"
else
  echo "[dev] launching electron (one-shot)"
  echo "[dev] DevTools (renderer): http://127.0.0.1:$DEVTOOLS_PORT"
  echo "[dev] Inspector (main):    chrome://inspect → 127.0.0.1:$INSPECT_PORT"
  run_remote "cd '$LINUX_DIR' \
    && rm -f /tmp/companion-dev.log \
    && nohup ./node_modules/.bin/electron \
         --inspect=0.0.0.0:$INSPECT_PORT \
         --remote-debugging-port=$DEVTOOLS_PORT \
         '--remote-allow-origins=*' \
         --no-sandbox \
         dist/main.js \
         >/tmp/companion-dev.log 2>&1 </dev/null & \
       disown; \
       sleep 6; \
       echo '---LOG---'; tail -60 /tmp/companion-dev.log; \
       echo '---PORTS---'; ss -tlnp 2>/dev/null | grep -E '(17899|$INSPECT_PORT|$DEVTOOLS_PORT)' || echo '(none yet)'"
fi
