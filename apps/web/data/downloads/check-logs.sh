#!/bin/bash
echo "-- log dir contents --"
ls -laR "$HOME/Library/Logs/MMO Companion/" 2>/dev/null
echo ""
echo "-- main.log --"
tail -100 "$HOME/Library/Logs/MMO Companion/main.log" 2>/dev/null
echo ""
echo "-- app store dir --"
ls -laR "$HOME/Library/Application Support/MMO Companion/" 2>/dev/null | head -40
echo ""
echo "-- crash report latest --"
LATEST=$(ls -t "$HOME/Library/Logs/DiagnosticReports/"*MMO* 2>/dev/null | head -1)
[ -n "$LATEST" ] && head -50 "$LATEST"
echo ""
echo "-- procs and ports --"
pgrep -fl "MMO Companion" | head
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -20
