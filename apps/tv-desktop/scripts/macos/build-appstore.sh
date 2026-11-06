#!/usr/bin/env bash
# MixAI TV — Mac App Store build (WP17-26; port of vitals scripts/macos/build-appstore.sh): universal .app, sandboxed,
# signed with Apple Distribution, packaged as a signed .pkg, validated and (with `upload`) sent to App Store Connect.
# Also `dmg`: an unsigned-for-store, Developer ID signed .dmg when DEVID_P12 is given (direct download).
# Runs on a Mac (vmui-mac) via apps/tv-desktop/scripts/macos-appstore.ps1, which supplies the env from Secret Manager.
#
#   apps/tv-desktop/scripts/macos/build-appstore.sh build|upload
#
# Env: TEAM_ID, BUILD_NUMBER, DIST_P12, INSTALLER_P12, P12_PASSWORD, APPLE_ID (App Store app id, for upload),
#      ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH. The profile must be at src-tauri/macos/embedded.provisionprofile.
set -euo pipefail

MODE="${1:-build}"
: "${TEAM_ID:?}" "${BUILD_NUMBER:?}" "${DIST_P12:?}" "${INSTALLER_P12:?}" "${P12_PASSWORD:?}"
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAURI="$APPDIR/src-tauri"
OUT="$APPDIR/target-mac/appstore"
BUNDLE_ID=ro.mixai.tv.desktop
log() { printf '== %s\n' "$*"; }
mkdir -p "$OUT"

PROFILE="$TAURI/macos/embedded.provisionprofile"
[ -s "$PROFILE" ] || { echo "missing $PROFILE (scripts/macos/appstore-profile.mjs)" >&2; exit 1; }
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$TAURI/tauri.conf.json" | head -1)"
log "MixAI TV $VERSION ($BUILD_NUMBER) for the Mac App Store"

sed "s/TEAM_ID/$TEAM_ID/g" "$TAURI/macos/Entitlements.appstore.plist" > "$TAURI/macos/Entitlements.appstore.resolved.plist"
plutil -lint "$TAURI/macos/Entitlements.appstore.resolved.plist" >/dev/null

# Throwaway keychain with both identities (an SSH session cannot unlock the login keychain).
KC="$(mktemp -d)/mas.keychain-db"
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
for p12 in "$DIST_P12" "$INSTALLER_P12"; do
  security import "$p12" -k "$KC" -f pkcs12 -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/productbuild >/dev/null
done
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
# shellcheck disable=SC2086
security list-keychains -d user -s "$KC" $OLD_KCS
APP_ID="$(security find-identity -v -p codesigning "$KC" | sed -n 's/.*"\(Apple Distribution:[^"]*\)".*/\1/p' | head -1)"
PKG_ID="$(security find-identity "$KC" | grep -oE '(3rd Party Mac Developer Installer|Mac Installer Distribution): [^"]+' | head -1 || true)"
[ -n "$APP_ID" ] || { echo "no Apple Distribution identity in DIST_P12" >&2; exit 1; }
[ -n "$PKG_ID" ] || { echo "no Mac Installer Distribution identity in INSTALLER_P12" >&2; exit 1; }
log "app identity: $APP_ID"
log "pkg identity: $PKG_ID"

# Build (Tauri does not sign: no APPLE_SIGNING_IDENTITY). The UI reuses apps/tv-tizen/src, so its deps are needed too.
VERCONF="$OUT/version.conf.json"
printf '{"bundle":{"macOS":{"bundleVersion":"%s"}}}\n' "$BUILD_NUMBER" > "$VERCONF"
(cd "$APPDIR/../tv-tizen" && pnpm install --frozen-lockfile --ignore-workspace >/dev/null)
cd "$APPDIR"
pnpm install --frozen-lockfile --ignore-workspace >/dev/null
[ -d src-tauri/icons ] || pnpm tauri icon ../web/public/icon-512.png >/dev/null
(
  unset APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE
  pnpm tauri build --target universal-apple-darwin --bundles app --config src-tauri/tauri.appstore.conf.json --config "$VERCONF"
)
APP="$(find "$TAURI/target/universal-apple-darwin/release/bundle/macos" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$APP" ] || { echo "no .app produced" >&2; exit 1; }
log "built: $APP"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")" = "$BUILD_NUMBER" ] || { echo "CFBundleVersion is not $BUILD_NUMBER" >&2; exit 1; }
[ -f "$APP/Contents/embedded.provisionprofile" ] || { echo "profile not embedded" >&2; exit 1; }

MAIN="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
find "$APP/Contents" -type f \( -perm -u+x -o -name '*.dylib' \) ! -path '*/_CodeSignature/*' ! -path "$MAIN" -print0 |
  while IFS= read -r -d '' f; do
    if file "$f" | grep -q 'Mach-O'; then
      codesign --force --options runtime --keychain "$KC" --sign "$APP_ID" --entitlements "$TAURI/macos/Entitlements.appstore.resolved.plist" "$f"
    fi
  done
codesign --force --options runtime --keychain "$KC" --sign "$APP_ID" --entitlements "$TAURI/macos/Entitlements.appstore.resolved.plist" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q 'com.apple.security.app-sandbox' || { echo "signed app is not sandboxed" >&2; exit 1; }

PKG="$OUT/MixAITV_${VERSION}_${BUILD_NUMBER}.pkg"
rm -f "$PKG"
productbuild --component "$APP" /Applications --keychain "$KC" --sign "$PKG_ID" "$PKG"
pkgutil --check-signature "$PKG" | head -3
log "OK: $PKG"

[ "$MODE" = "upload" ] || exit 0

: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}" "${APPLE_ID:?}"
KEYDIR="$(mktemp -d)"
cp "$ASC_KEY_PATH" "$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"
chmod 600 "$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"
export API_PRIVATE_KEYS_DIR="$KEYDIR"
trap 'rm -rf "$KEYDIR"; cleanup' EXIT
log "validate"
xcrun altool --validate-app -f "$PKG" -t macos --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
log "upload"
xcrun altool --upload-package "$PKG" -t macos --apple-id "$APPLE_ID" --bundle-id "$BUNDLE_ID" \
  --bundle-version "$BUILD_NUMBER" --bundle-short-version-string "$VERSION" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
log "uploaded $VERSION ($BUILD_NUMBER)"
