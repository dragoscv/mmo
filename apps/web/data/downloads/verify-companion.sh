#!/bin/bash
sleep 5
echo "---PROCS---"
pgrep -fl "MMO Companion" | head -10
echo "---PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'mmo|electron|Companion' | head -20
echo "---ALL LISTEN ABOVE 1024---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==1 || $9 ~ /:[0-9]{4,5}$/' | head -30
echo "---LOG DIRS---"
ls -la "$HOME/Library/Logs/" 2>/dev/null | grep -iE 'mmo|companion'
echo "---APP SUPPORT---"
ls -la "$HOME/Library/Application Support/" 2>/dev/null | grep -iE 'mmo|companion'
echo "---LATEST LOG---"
LOGFILE=$(ls -t "$HOME/Library/Logs/mmo-companion/"*.log "$HOME/Library/Logs/MMO Companion/"*.log 2>/dev/null | head -1)
echo "LOG=$LOGFILE"
[ -n "$LOGFILE" ] && tail -60 "$LOGFILE"
