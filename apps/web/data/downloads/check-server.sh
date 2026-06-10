#!/bin/bash
echo "PROCS:"
pgrep -fl "MMO Companion" | head -10
echo ""
echo "ALL LISTENING PORTS:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -20
echo ""
echo "CURL HEALTH:"
curl -sS --max-time 5 http://127.0.0.1:17899/health
echo ""
echo "CURL ROOT:"
curl -sSI --max-time 5 http://127.0.0.1:17899/ | head -5
echo ""
echo "STDERR LOG:"
tail -40 /tmp/mmo-stderr.log 2>/dev/null
echo ""
echo "STDOUT LOG:"
tail -40 /tmp/mmo-stdout.log 2>/dev/null
echo ""
echo "USER LOG:"
LOGDIR="$HOME/Library/Logs/mmo-companion"
[ -d "$LOGDIR" ] && ls -la "$LOGDIR" && tail -40 "$LOGDIR"/*.log 2>/dev/null
LOGDIR2="$HOME/Library/Logs/MMO Companion"
[ -d "$LOGDIR2" ] && ls -la "$LOGDIR2" && tail -40 "$LOGDIR2"/*.log 2>/dev/null
