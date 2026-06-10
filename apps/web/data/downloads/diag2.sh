#!/bin/bash
echo "-- recent crashes --"
ls -lat "$HOME/Library/Logs/DiagnosticReports/" | head -10

echo ""
echo "-- system log (mmo) --"
log show --predicate 'process CONTAINS "MMO Companion" OR process CONTAINS "MMO Compan"' --last 2m --style compact 2>&1 | tail -30

echo ""
echo "-- sign check on framework --"
codesign -dv --verbose=4 "/Applications/MMO Companion.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" 2>&1 | head -15

echo ""
echo "-- sign check on helpers --"
for h in "/Applications/MMO Companion.app/Contents/Frameworks/"*Helper*.app; do
    echo "==== $h ===="
    codesign -dv "$h/Contents/MacOS/$(basename "$h" .app)" 2>&1 | head -8
done

echo ""
echo "-- try spawn helper directly --"
HELPER="/Applications/MMO Companion.app/Contents/Frameworks/MMO Companion Helper.app/Contents/MacOS/MMO Companion Helper"
"$HELPER" --type=zygote 2>&1 | head -20 &
sleep 2
kill %1 2>/dev/null

echo ""
echo "-- kill main and try fresh launch with output --"
kill 720 2>/dev/null
sleep 2
"/Applications/MMO Companion.app/Contents/MacOS/MMO Companion" 2>&1 &
NEW=$!
sleep 6
echo "NEW PID=$NEW"
ps -p $NEW -o pid,stat 2>/dev/null
echo "Children:"
pgrep -lP $NEW 2>/dev/null
echo "All MMO procs:"
pgrep -fl "MMO Companion" 2>/dev/null
echo ""
echo "PORTS:"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ":17[0-9]{3}|:8[0-9]{3}|:300[0-9]" | head
