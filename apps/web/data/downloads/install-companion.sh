#!/bin/bash
set -e
echo "-- mount --"
MOUNTOUT=$(hdiutil attach /tmp/companion.dmg -nobrowse -noverify -noautoopen)
echo "$MOUNTOUT"
MOUNT=$(echo "$MOUNTOUT" | grep -E "/Volumes/" | awk -F"\t" '{print $NF}' | tail -1)
echo "MOUNT=$MOUNT"
ls "$MOUNT"
echo "-- copy --"
sudo -n rm -rf "/Applications/MMO Companion.app" 2>/dev/null || rm -rf "/Applications/MMO Companion.app" 2>/dev/null || true
cp -R "$MOUNT/MMO Companion.app" /Applications/
echo "-- detach --"
hdiutil detach "$MOUNT" -quiet || true
echo "-- quarantine --"
xattr -dr com.apple.quarantine "/Applications/MMO Companion.app" 2>/dev/null || true
echo "-- verify --"
ls -lh "/Applications/MMO Companion.app/Contents/MacOS/"
defaults read "/Applications/MMO Companion.app/Contents/Info.plist" CFBundleShortVersionString
echo "-- launch --"
open -a "/Applications/MMO Companion.app"
sleep 5
pgrep -fl "MMO Companion" || true
echo "DONE"
