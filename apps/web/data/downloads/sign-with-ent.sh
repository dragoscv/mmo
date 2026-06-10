#!/bin/bash
set -e
APP="/Applications/MMO Companion.app"
ENT="/Users/dragos/entitlements.plist"

echo "-- removing existing app --"
rm -rf "$APP"

echo "-- mounting fresh dmg --"
hdiutil detach "/Volumes/MMO Companion 0.9.5" -force 2>/dev/null || true
MOUNTOUT=$(hdiutil attach /Users/dragos/companion.dmg -nobrowse -noverify -noautoopen)
MOUNT=$(echo "$MOUNTOUT" | grep -E "/Volumes/" | awk -F"\t" '{print $NF}' | tail -1)

STAGING="/tmp/MMO-stage2"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$MOUNT/MMO Companion.app" "$STAGING/"
hdiutil detach "$MOUNT" -quiet || true

STAGED="$STAGING/MMO Companion.app"

echo "-- clear xattrs --"
xattr -cr "$STAGED"

echo "-- sign frameworks (no entitlements) --"
for fw in "$STAGED/Contents/Frameworks/"*.framework; do
    echo "  FW: $(basename "$fw")"
    codesign --force --sign - --timestamp=none --options=runtime "$fw" 2>&1 | tail -2
done

echo "-- sign helpers WITH JIT entitlements --"
for helper in "$STAGED/Contents/Frameworks/"*.app; do
    echo "  HELPER: $(basename "$helper")"
    codesign --force --sign - --timestamp=none --options=runtime --entitlements "$ENT" "$helper" 2>&1 | tail -2
done

echo "-- sign main app WITH entitlements --"
codesign --force --sign - --timestamp=none --options=runtime --entitlements "$ENT" "$STAGED" 2>&1 | tail -2

echo "-- verify entitlements on helper --"
codesign -d --entitlements - "$STAGED/Contents/Frameworks/MMO Companion Helper.app" 2>&1 | tail -20

echo "-- verify --"
codesign --verify --verbose=2 "$STAGED" 2>&1 | tail -5

echo "-- move to /Applications --"
mv "$STAGED" "$APP"

echo "-- launch --"
"$APP/Contents/MacOS/MMO Companion" >/tmp/mmo-stdout.log 2>/tmp/mmo-stderr.log &
APPPID=$!
echo "PID=$APPPID"
sleep 12
echo "---PROCS---"
pgrep -fl "MMO Companion" | head -10
echo ""
echo "---PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ":17[0-9]{3}" | head
echo ""
echo "---HEALTH---"
curl -sS --max-time 5 http://127.0.0.1:17899/health 2>&1
echo ""
echo "---STDERR---"
tail -30 /tmp/mmo-stderr.log
echo ""
echo "---LOG---"
tail -30 "$HOME/Library/Logs/MMO Companion/main.log" 2>/dev/null
