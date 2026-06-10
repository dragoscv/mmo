#!/bin/bash
echo "-- Recent crashes --"
ls -lat ~/Library/Logs/DiagnosticReports/ | head -10
echo ""
LATEST=$(ls -t ~/Library/Logs/DiagnosticReports/*MMO* 2>/dev/null | head -1)
echo "LATEST=$LATEST"
[ -n "$LATEST" ] && head -8 "$LATEST"
echo ""
echo "-- main.log --"
LOGFILE="$HOME/Library/Logs/MMO Companion/main.log"
[ -f "$LOGFILE" ] && tail -50 "$LOGFILE" || echo "(no main.log)"
echo ""
echo "-- log show --"
log show --predicate 'process CONTAINS "MMO"' --last 2m --style compact 2>&1 | tail -40

echo ""
echo "-- store dir --"
ls -laR "$HOME/Library/Application Support/MMO Companion/" 2>/dev/null | head -30
