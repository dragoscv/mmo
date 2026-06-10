#!/usr/bin/env bash
set -e
export DISPLAY=:0
# Kill any prior instance, run the installed binary in background,
# capture log, give it ~10s, then probe.
pkill -f mmo-companion 2>/dev/null || true
sleep 1
rm -f /tmp/mmo-companion.log
nohup '/opt/MMO Companion/mmo-companion' --no-sandbox >/tmp/mmo-companion.log 2>&1 </dev/null &
disown
sleep 12
echo "==LOG=="
tail -80 /tmp/mmo-companion.log
echo "==PROC=="
ps -axo pid,command | grep -i mmo-companion | grep -v grep | head
echo "==PORT 17899=="
ss -tnlp 2>/dev/null | grep 17899 | head
echo "==HTTP PROBE=="
curl -sf -m 5 http://127.0.0.1:17899/health 2>&1 | head -5 || curl -sf -m 5 http://127.0.0.1:17899/ 2>&1 | head -5
