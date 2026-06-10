#!/bin/bash
set -e
APP="/Applications/MMO Companion.app"
echo "-- removing existing app --"
rm -rf "$APP"

echo "-- mounting fresh dmg --"
hdiutil detach "/Volumes/MMO Companion 0.9.5" -force 2>/dev/null || true
MOUNTOUT=$(hdiutil attach /Users/dragos/companion.dmg -nobrowse -noverify -noautoopen)
MOUNT=$(echo "$MOUNTOUT" | grep -E "/Volumes/" | awk -F"\t" '{print $NF}' | tail -1)
echo "MOUNT=$MOUNT"

echo "-- copy to staging (NOT /Applications yet) --"
STAGING="/tmp/MMO-staging"
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$MOUNT/MMO Companion.app" "$STAGING/"
hdiutil detach "$MOUNT" -quiet || true

STAGED="$STAGING/MMO Companion.app"
echo "-- clear all xattrs --"
xattr -cr "$STAGED"

echo "-- sign frameworks (deepest first) --"
# Strip any existing signatures from the inner Mach-O binaries first
for fw in "$STAGED/Contents/Frameworks/"*.framework; do
    BIN="$fw/Versions/A/$(basename "$fw" .framework)"
    if [ -f "$BIN" ]; then
        codesign --remove-signature "$BIN" 2>/dev/null || true
    fi
done

# Sign every framework
for fw in "$STAGED/Contents/Frameworks/"*.framework; do
    echo "  FW: $fw"
    codesign --force --sign - --timestamp=none --deep "$fw" 2>&1 | tail -2
done

# Sign helper apps
for helper in "$STAGED/Contents/Frameworks/"*.app; do
    echo "  HELPER: $helper"
    codesign --force --sign - --timestamp=none --deep "$helper" 2>&1 | tail -2
done

# Sign the main app
echo "-- sign main app --"
codesign --force --sign - --timestamp=none --deep "$STAGED" 2>&1 | tail -2

echo "-- verify --"
codesign --verify --deep --strict --verbose=2 "$STAGED" 2>&1 | tail -10
spctl -a -vvv -t exec "$STAGED" 2>&1 | tail -3 || true

echo "-- move to /Applications --"
mv "$STAGED" "$APP"

echo "-- launch directly --"
"$APP/Contents/MacOS/MMO Companion" >/tmp/mmo-stdout.log 2>/tmp/mmo-stderr.log &
APPPID=$!
echo "PID=$APPPID"
sleep 10
echo "---PROC---"
ps -p $APPPID -o pid,stat,command 2>/dev/null || echo "Process exited!"
pgrep -fl "MMO Companion" | head -10
echo "---STDERR (first 30 lines)---"
head -30 /tmp/mmo-stderr.log
echo "---STDOUT (first 30 lines)---"
head -30 /tmp/mmo-stdout.log
echo "---PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'mmo|companion' | head -10
