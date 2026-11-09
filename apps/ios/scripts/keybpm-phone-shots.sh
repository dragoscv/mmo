#!/usr/bin/env bash
# App Store iPhone screenshots of MixAI Key & BPM from the iOS Simulator (WP18-09): builds the MixAIKeyBpm scheme for
# the simulator, boots the largest iPhone (6.9" = 1320x2868), installs, seeds a reading through the app's `-KBShot`
# hook (no microphone) and captures PNGs into build/phone-shots/. Called by scripts/build.sh keybpmphonesim.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
OUT="$HERE/build"
SHOTS="$OUT/phone-shots"
SPM_CACHE="${MIXAI_SPM_CACHE:-$HOME/.cache/mixai-ios-spm}"
mkdir -p "$SHOTS"
log() { printf '== %s\n' "$*"; }

RUNTIME="$(xcrun simctl list runtimes -j | /usr/bin/python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin)["runtimes"] if x["platform"]=="iOS" and x["isAvailable"]]; print(r[-1]["identifier"])')"
DEVTYPE="$(xcrun simctl list devicetypes -j | /usr/bin/python3 -c '
import json,re,sys
t=[d for d in json.load(sys.stdin)["devicetypes"] if d["name"].startswith("iPhone")]
def gen(d):
  m=re.search(r"iPhone (\d+)", d["name"]); return int(m.group(1)) if m else 0
pref=[d for d in t if "Pro Max" in d["name"]] or t
print(max(pref, key=gen)["identifier"])')"
log "runtime $RUNTIME, device $DEVTYPE"
UDID="$(xcrun simctl list devices -j | /usr/bin/python3 -c "
import json,sys
for rt,ds in json.load(sys.stdin)['devices'].items():
  for d in ds:
    if d['name']=='KeyBpmPhoneShots' and d['isAvailable'] and d.get('deviceTypeIdentifier')=='$DEVTYPE': print(d['udid']); sys.exit()
")"
# A KeyBpmPhoneShots device of an older model is deleted so the shots are always 6.9" (1320x2868).
xcrun simctl list devices -j | /usr/bin/python3 -c "
import json,sys
for rt,ds in json.load(sys.stdin)['devices'].items():
  for d in ds:
    if d['name']=='KeyBpmPhoneShots' and d.get('deviceTypeIdentifier')!='$DEVTYPE': print(d['udid'])
" | while read -r old; do xcrun simctl delete "$old"; done
[ -n "$UDID" ] || UDID="$(xcrun simctl create KeyBpmPhoneShots "$DEVTYPE" "$RUNTIME")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl ui "$UDID" appearance dark 2>/dev/null || true

log "build MixAIKeyBpm for the iOS Simulator"
xcodebuild -project MixAI.xcodeproj -scheme MixAIKeyBpm -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$OUT/dd-phonesim" -clonedSourcePackagesDirPath "$SPM_CACHE" \
  -skipPackagePluginValidation -skipMacroValidation CODE_SIGNING_ALLOWED=NO build -quiet
APP="$(find "$OUT/dd-phonesim/Build/Products/Debug-iphonesimulator" -maxdepth 1 -name 'MixAIKeyBpm.app' | head -1)"
[ -n "$APP" ] || { echo "app not built" >&2; exit 1; }
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant microphone ro.mixai.keybpm 2>/dev/null || true
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 2>/dev/null || true
# First launch after install compiles shaders / loads fonts: warm up once so the shots are not black.
xcrun simctl launch "$UDID" ro.mixai.keybpm -KBShot live >/dev/null; sleep 15

shot() { # name launch-args...
  local name="$1"; shift
  xcrun simctl terminate "$UDID" ro.mixai.keybpm 2>/dev/null || true
  xcrun simctl launch "$UDID" ro.mixai.keybpm "$@" >/dev/null
  sleep 8
  xcrun simctl io "$UDID" screenshot "$SHOTS/$name.png" >/dev/null
  log "shot $name $(sips -g pixelWidth -g pixelHeight "$SHOTS/$name.png" | awk '/pixel/{printf "%s ", $2}')"
}
shot 01-live -KBShot live -KBShotKey 21 -KBShotBpm 124.0 -KBShotTab 0
shot 02-tuner -KBShot live -KBShotKey 21 -KBShotBpm 124.0 -KBShotTab 1
shot 03-tempo -KBShot live -KBShotKey 21 -KBShotBpm 124.0 -KBShotTab 2
shot 04-setlog -KBShot live -KBShotKey 21 -KBShotBpm 124.0 -KBShotTab 3
shot 05-practice -KBShot live -KBShotKey 21 -KBShotBpm 124.0 -KBShotTab 4
shot 06-stage -KBShot stage -KBShotKey 21 -KBShotBpm 124.0
log "OK: $SHOTS"
