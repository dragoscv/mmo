#!/bin/bash
echo "---CRASH REPORTS---"
ls -lat "$HOME/Library/Logs/DiagnosticReports/" 2>/dev/null | grep -iE 'mmo|companion' | head -5
LATEST=$(ls -t "$HOME/Library/Logs/DiagnosticReports/"*MMO* 2>/dev/null | head -1)
echo "LATEST=$LATEST"
[ -n "$LATEST" ] && head -80 "$LATEST"

echo ""
echo "---MANUAL LAUNCH (5s)---"
"/Applications/MMO Companion.app/Contents/MacOS/MMO Companion" >/tmp/mmo-stdout.log 2>/tmp/mmo-stderr.log &
APPPID=$!
echo "Launched PID=$APPPID"
sleep 8
echo "---PROC---"
ps -p $APPPID -o pid,stat,command 2>/dev/null || echo "Process exited"
pgrep -fl "MMO Companion" | head -10
echo "---STDOUT---"
cat /tmp/mmo-stdout.log
echo "---STDERR---"
cat /tmp/mmo-stderr.log
echo "---PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'mmo|companion|electron' | head -10
