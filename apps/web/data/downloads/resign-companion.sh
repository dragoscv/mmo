#!/bin/bash
set -e
APP="/Applications/MMO Companion.app"
echo "-- removing existing signatures from inner binaries --"
# Find and re-sign all dylibs/frameworks/helpers from deepest to shallowest
find "$APP" -type f \( -name "*.dylib" -o -name "*.framework" \) -print0 2>/dev/null | xargs -0 -I {} codesign --force --sign - --timestamp=none "{}" 2>/dev/null || true

echo "-- signing frameworks --"
find "$APP/Contents/Frameworks" -type d -name "*.framework" -prune | while read fw; do
    echo "  $fw"
    codesign --force --deep --sign - --timestamp=none --options=runtime "$fw" 2>&1 | tail -3
done

echo "-- signing helper apps --"
find "$APP/Contents/Frameworks" -type d -name "*.app" -prune | while read helper; do
    echo "  $helper"
    codesign --force --deep --sign - --timestamp=none --options=runtime "$helper" 2>&1 | tail -3
done

echo "-- signing main bundle --"
codesign --force --deep --sign - --timestamp=none --options=runtime "$APP"

echo "-- verify --"
codesign --verify --verbose=2 "$APP" 2>&1 | head -10
codesign -dv "$APP" 2>&1 | head -10
codesign -dv "$APP/Contents/Frameworks/Electron Framework.framework" 2>&1 | head -10

echo "-- launch --"
"$APP/Contents/MacOS/MMO Companion" >/tmp/mmo-stdout.log 2>/tmp/mmo-stderr.log &
APPPID=$!
echo "PID=$APPPID"
sleep 8
echo "---PROC---"
ps -p $APPPID -o pid,stat,command 2>/dev/null || echo "Process exited!"
pgrep -fl "MMO Companion" | head -10
echo "---STDERR---"
cat /tmp/mmo-stderr.log
echo "---STDOUT---"
tail -40 /tmp/mmo-stdout.log
echo "---PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'mmo|companion|node' | head -10
