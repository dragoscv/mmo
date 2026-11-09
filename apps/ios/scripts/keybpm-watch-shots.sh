#!/usr/bin/env bash
# App Store screenshots of the MixAI Key & BPM watch app from the watchOS Simulator (WP18-05 / WP18-09): builds the
# MixAIKeyBpmWatch scheme for the simulator, boots an Apple Watch (largest available = Ultra), installs, seeds a
# reading through the app's screenshot hook and captures PNGs into build/watch-shots/ (422x514 on Ultra 3).
# Called by scripts/build.sh keybpmwatchsim after `generate`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
OUT="$HERE/build"
SHOTS="$OUT/watch-shots"
SPM_CACHE="${MIXAI_SPM_CACHE:-$HOME/.cache/mixai-ios-spm}"
mkdir -p "$SHOTS"
log() { printf '== %s\n' "$*"; }

RUNTIME="$(xcrun simctl list runtimes -j | /usr/bin/python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["platform"]=="watchOS" and x["isAvailable"]]; print(r[-1]["identifier"])')"
DEVTYPE="$(xcrun simctl list devicetypes -j | /usr/bin/python3 -c '
import json,sys
t=[d for d in json.load(sys.stdin)["devicetypes"] if "Watch" in d["name"]]
pref=[d for d in t if "Ultra 3" in d["name"]] or [d for d in t if "Ultra" in d["name"]] or t
print(pref[-1]["identifier"])')"
log "runtime $RUNTIME, device $DEVTYPE"
UDID="$(xcrun simctl list devices -j | /usr/bin/python3 -c "
import json,sys
for rt,ds in json.load(sys.stdin)['devices'].items():
  for d in ds:
    if d['name']=='KeyBpmShots' and d['isAvailable']: print(d['udid']); sys.exit()
")"
[ -n "$UDID" ] || UDID="$(xcrun simctl create KeyBpmShots "$DEVTYPE" "$RUNTIME")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null

log "build MixAIKeyBpmWatch for the watchOS Simulator"
xcodebuild -project MixAI.xcodeproj -scheme MixAIKeyBpmWatch -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$OUT/dd-sim" -clonedSourcePackagesDirPath "$SPM_CACHE" \
  -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build -quiet
APP="$(find "$OUT/dd-sim/Build/Products/Debug-watchsimulator" -maxdepth 1 -name 'MixAIKeyBpmWatch.app' | head -1)"
[ -n "$APP" ] || { echo "watch app not built" >&2; exit 1; }
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant microphone ro.mixai.keybpm.watchkitapp 2>/dev/null || true
xcrun simctl status_bar "$UDID" override --time "2026-11-09T09:41:00Z" 2>/dev/null || xcrun simctl status_bar "$UDID" override --time 9:41 2>/dev/null || true

shot() { # name launch-args...
  local name="$1"; shift
  xcrun simctl terminate "$UDID" ro.mixai.keybpm.watchkitapp 2>/dev/null || true
  xcrun simctl launch "$UDID" ro.mixai.keybpm.watchkitapp "$@" >/dev/null
  sleep 4
  xcrun simctl io "$UDID" screenshot "$SHOTS/$name.png" >/dev/null
  log "shot $name $(sips -g pixelWidth -g pixelHeight "$SHOTS/$name.png" | awk '/pixel/{printf "%s ", $2}')"
}
shot 01-live -KBShot live -KBShotKey 21 -KBShotBpm 124.0
shot 02-phone -KBShot phone -KBShotKey 8 -KBShotBpm 126.1
shot 03-controls -KBShot controls
shot 04-tap -KBShot tap -KBShotKey 16 -KBShotBpm 128.0
log "OK: $SHOTS"
