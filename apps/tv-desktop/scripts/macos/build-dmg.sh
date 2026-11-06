#!/usr/bin/env bash
# MixAI TV — Developer ID direct-download build (WP17-26; port of vitals scripts/macos/sign-notarise.sh): universal .app,
# hardened runtime, signed with Developer ID Application, notarised + stapled, wrapped in a signed/notarised/stapled DMG.
# Runs on vmui-mac via apps/tv-desktop/scripts/macos-appstore.ps1 -Mode dmg (env from Secret Manager).
#
# Env: TEAM_ID, BUILD_NUMBER, DEVID_P12, P12_PASSWORD, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH.
set -euo pipefail
: "${TEAM_ID:?}" "${BUILD_NUMBER:?}" "${DEVID_P12:?}" "${P12_PASSWORD:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}"
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$APPDIR/src-tauri"
OUT="$APPDIR/target-mac/dmg"
ENT="$TAURI/macos/Entitlements.direct.plist"
log() { printf '== %s\n' "$*"; }
mkdir -p "$OUT"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$TAURI/tauri.conf.json" | head -1)"
log "MixAI TV $VERSION ($BUILD_NUMBER) Developer ID"

KC="$(mktemp -d)/devid.keychain-db"
KCPW="$(openssl rand -hex 16)"
OLD_KCS="$(security list-keychains -d user | tr -d '"' | xargs)"
cleanup() {
  # shellcheck disable=SC2086
  security list-keychains -d user -s $OLD_KCS 2>/dev/null || true
  security delete-keychain "$KC" 2>/dev/null || true
}
trap cleanup EXIT
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings -lut 7200 "$KC"
security unlock-keychain -p "$KCPW" "$KC"
security import "$DEVID_P12" -k "$KC" -f pkcs12 -P "$P12_PASSWORD" -T /usr/bin/codesign >/dev/null
# Developer ID G2 leaf certs chain to this intermediate; without it find-identity -v reports 0 valid identities.
CA="$(mktemp -d)/DeveloperIDG2CA.cer"
curl -fsSL -o "$CA" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
security import "$CA" -k "$KC" >/dev/null 2>&1 || true
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
# shellcheck disable=SC2086
security list-keychains -d user -s "$KC" $OLD_KCS
IDENTITY="$(security find-identity -v -p codesigning "$KC" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
[ -n "$IDENTITY" ] || { echo "no Developer ID Application identity in DEVID_P12" >&2; exit 1; }
log "signing as: $IDENTITY"

notarise() {
  xcrun notarytool submit "$1" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
    --wait --timeout 90m --output-format json > "$OUT/notary.json"
  local status; status="$(sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' "$OUT/notary.json" | head -1)"
  log "notarisation of $(basename "$1"): $status"
  if [ "$status" != "Accepted" ]; then
    local id; id="$(sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' "$OUT/notary.json" | head -1)"
    xcrun notarytool log "$id" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" || true
    exit 1
  fi
}

VERCONF="$OUT/version.conf.json"
printf '{"bundle":{"macOS":{"bundleVersion":"%s"}}}\n' "$BUILD_NUMBER" > "$VERCONF"
PNPM_PIN="$HOME/.pnpm-pin-10"
[ -x "$PNPM_PIN/bin/pnpm" ] || npm i -g --prefix "$PNPM_PIN" pnpm@10.0.0 >/dev/null
export PATH="$PNPM_PIN/bin:$PATH" npm_config_manage_package_manager_versions=false
(cd "$APPDIR/../tv-tizen" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null)
cd "$APPDIR"
pnpm install --frozen-lockfile --ignore-workspace >/dev/null
[ -d src-tauri/icons ] || pnpm tauri icon ../web/public/icon-512.png >/dev/null
(
  unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE
  pnpm tauri build --target universal-apple-darwin --bundles app --config "$VERCONF"
)
APP="$(find "$TAURI/target/universal-apple-darwin/release/bundle/macos" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$APP" ] || { echo "no .app produced" >&2; exit 1; }
rm -f "$APP/Contents/embedded.provisionprofile"

MAIN="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
find "$APP/Contents" -type f \( -perm -u+x -o -name '*.dylib' \) ! -path '*/_CodeSignature/*' ! -path "$MAIN" -print0 |
  while IFS= read -r -d '' f; do
    if file "$f" | grep -q 'Mach-O'; then codesign --force --timestamp --options runtime --keychain "$KC" --sign "$IDENTITY" "$f"; fi
  done
codesign --force --timestamp --options runtime --entitlements "$ENT" --keychain "$KC" --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"

ZIP="$(mktemp -d)/MixAITV.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
notarise "$ZIP"
xcrun stapler staple "$APP"

STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/MixAI TV.app"
ln -s /Applications "$STAGE/Applications"
DMG="$OUT/MixAI-TV_${VERSION}_universal.dmg"
rm -f "$DMG"
hdiutil create -volname "MixAI TV" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign --force --timestamp --keychain "$KC" --sign "$IDENTITY" "$DMG"
notarise "$DMG"
xcrun stapler staple "$DMG"
spctl --assess --type execute --verbose=2 "$APP"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
shasum -a 256 "$DMG"
log "OK: $DMG"
