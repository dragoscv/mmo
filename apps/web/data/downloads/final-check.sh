#!/bin/bash
sleep 15
echo "HELPERS:"
pgrep -fl "MMO Companion Helper" | wc -l
echo "PORTS:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null
echo ""
echo "HEALTH:"
curl -sS --max-time 5 http://127.0.0.1:17899/health
echo ""
echo "LOG:"
tail -80 "/Users/dragos/Library/Logs/MMO Companion/main.log" 2>/dev/null
echo ""
echo "STDERR:"
tail -40 /tmp/mmo-stderr.log 2>/dev/null
