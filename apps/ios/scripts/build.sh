#!/usr/bin/env bash
# Reproducible build of the MixAI iPhone app on a macOS host (vmui-mac, Xcode 26.x). Port of codai apps/ios/scripts/build.sh.
#
#   scripts/build.sh test      swift test MixaiCore (no Simulator needed)
#   scripts/build.sh build     generate project + compile for iphoneos, unsigned
#   scripts/build.sh tvbuild   generate project + compile MixAI TV for appletvos, unsigned (WP17-24)
#   scripts/build.sh tvupload  archive MixAI TV (tvOS, same bundle id ro.mixai.app), sign and upload to TestFlight
#   scripts/build.sh devipa    archive + development-signed ro.mixai.app .ipa (registered devices) for a direct install
#   scripts/build.sh upload    archive, sign (automatic, via App Store Connect API key) and upload to TestFlight
#   scripts/build.sh musicbuild   generate project + compile MixAI Music for iphoneos, unsigned (WP17-42)
#   scripts/build.sh musicdevipa  development-signed ro.mixai.music .ipa for registered devices
#   scripts/build.sh musicupload  archive MixAI Music (ro.mixai.music), sign and upload to TestFlight
#   scripts/build.sh decksbuild     Rust decks-ffi (iOS device slice) + compile MixAI Decks for iphoneos, unsigned (WP19-15)
#   scripts/build.sh decksmacbuild  Rust decks-ffi (universal macOS) + compile MixAI Decks for macOS, unsigned (WP19-15)
#     (both need the Rust sources: DECKS_RUST_ROOT = a tree holding apps/mixai/src-tauri + crates/; ios-build.ps1 ships it)
#   scripts/build.sh keybpmbuild     Rust mixai-listen-ffi (iOS + watchOS device) + compile MixAI Key & BPM, unsigned (WP18-05)
#   scripts/build.sh keybpmwatchsim  Rust Simulator slices + Key & BPM watch app in the watchOS Simulator + screenshots
#   scripts/build.sh keybpmdevipa    development-signed ro.mixai.keybpm .ipa (with the watch app) for registered devices
#   scripts/build.sh keybpmupload    archive MixAI Key & BPM (iOS + embedded watchOS), sign and upload to TestFlight
#     (all need crates/: KEYBPM_RUST_ROOT = a tree holding crates/mixai-listen*; ios-build.ps1 ships it)
#
# Env for devipa/upload (the Windows driver scripts/ios-build.ps1 sets these from Secret Manager and deletes the key
# file afterwards; nothing is stored in the repo):
#   DEVELOPMENT_TEAM, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (0600 .p8), BUILD_NUMBER (git commit count)
set -euo pipefail

MODE="${1:-build}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

XCODEGEN_VERSION="2.46.0"
XCODEGEN_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
# Shared with codai on vmui-mac (same pinned XcodeGen).
TOOLS="$HOME/.local/codai-ios-tools"
XCODEGEN="$TOOLS/xcodegen-$XCODEGEN_VERSION/bin/xcodegen"
OUT="$HERE/build"
SPM_CACHE="${MIXAI_SPM_CACHE:-$HOME/.cache/mixai-ios-spm}"
SPM_FLAGS=(-clonedSourcePackagesDirPath "$SPM_CACHE" -skipPackagePluginValidation -skipMacroValidation)
KEYCHAIN="$HOME/Library/Keychains/codai-build.keychain-db"

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$HOME/Applications/Xcode.app" ]; then
  export DEVELOPER_DIR="$HOME/Applications/Xcode.app/Contents/Developer"
fi

log() { printf '== %s\n' "$*"; }

ensure_xcodegen() {
  if [ -x "$XCODEGEN" ]; then return; fi
  log "installing XcodeGen $XCODEGEN_VERSION"
  mkdir -p "$TOOLS"
  local zip="$TOOLS/xcodegen-$XCODEGEN_VERSION.zip"
  curl -fsSL -o "$zip" "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
  echo "$XCODEGEN_SHA256  $zip" | shasum -a 256 -c -
  rm -rf "$TOOLS/xcodegen-$XCODEGEN_VERSION"
  unzip -q "$zip" -d "$TOOLS/tmp-$XCODEGEN_VERSION"
  mv "$TOOLS/tmp-$XCODEGEN_VERSION/xcodegen" "$TOOLS/xcodegen-$XCODEGEN_VERSION"
  rm -rf "$TOOLS/tmp-$XCODEGEN_VERSION" "$zip"
}

generate() {
  ensure_xcodegen
  log "xcodebuild $(xcodebuild -version | tr '\n' ' ')"
  DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:-}" "$XCODEGEN" generate --spec project.yml --quiet
  mkdir -p "$SPM_CACHE"
}

# Headless signing: the login keychain is locked over SSH. Shared dedicated keychain of vmui-mac (codai runbook
# docs/runbooks/apple-publishing.md): random password in a 0600 file on the Mac, unlocked for the build.
build_keychain() {
  local pwf="$HOME/.config/codai/build-keychain.pw"
  mkdir -p "$(dirname "$pwf")"
  if [ ! -s "$pwf" ]; then (umask 077; openssl rand -hex 24 > "$pwf"); fi
  if [ ! -f "$KEYCHAIN" ]; then security create-keychain -p "$(cat "$pwf")" "$KEYCHAIN"; fi
  security unlock-keychain -p "$(cat "$pwf")" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$(cat "$pwf")" "$KEYCHAIN" >/dev/null 2>&1 || true
  security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
  security default-keychain -d user -s "$KEYCHAIN"
  trap restore_keychains EXIT
  # Other repos' build.sh reset the search list at their exit; keep ours in it while signing.
  ( while kill -0 $$ 2>/dev/null; do
      security list-keychains -d user | grep -q codai-build \
        || security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
      sleep 2
    done ) &
  KEYCHAIN_GUARD=$!
  log "build keychain unlocked ($(basename "$KEYCHAIN"))"
}

restore_keychains() {
  local rc=$? login="$HOME/Library/Keychains/login.keychain-db"
  [ -n "${KEYCHAIN_GUARD:-}" ] && { kill "$KEYCHAIN_GUARD" 2>/dev/null; wait "$KEYCHAIN_GUARD" 2>/dev/null || true; }
  security list-keychains -d user -s "$login" || true
  security default-keychain -d user -s "$login" || true
  return "$rc"
}

archive() {
  : "${DEVELOPMENT_TEAM:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}" "${BUILD_NUMBER:?}"
  local scheme="${1:-MixAI}" dest="${2:-generic/platform=iOS}"
  generate
  build_keychain
  AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
  rm -rf "$OUT/MixAI.xcarchive" "$OUT/export"
  log "archive $scheme (build $BUILD_NUMBER)"
  xcodebuild -project MixAI.xcodeproj -scheme "$scheme" -configuration Release \
    -destination "$dest" -derivedDataPath "$OUT/dd" \
    -archivePath "$OUT/MixAI.xcarchive" "${AUTH[@]}" "${SPM_FLAGS[@]}" \
    DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    OTHER_CODE_SIGN_FLAGS="--keychain $KEYCHAIN" archive -quiet
}

export_plist() { # method destination
  cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>$1</string>
  <key>destination</key><string>$2</string>
  <key>teamID</key><string>$DEVELOPMENT_TEAM</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
}

case "$MODE" in
  test)
    log "swift test MixaiCore"
    (cd MixaiCore && swift test)
    ;;
  musicbuild)
    generate
    log "compile MixAI Music (iphoneos, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAIMusic -configuration Release \
      -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release-iphoneos/MixAIMusic.app"
    ;;
  decksbuild)
    ./scripts/build-decks-xcframework.sh ios-device
    generate
    log "compile MixAI Decks (iphoneos, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAIDecks -configuration Release \
      -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release-iphoneos/MixAIDecks.app"
    ;;
  decksmacbuild)
    ./scripts/build-decks-xcframework.sh macos
    generate
    log "compile MixAI Decks (macOS, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAIDecksMac -configuration Release \
      -destination 'generic/platform=macOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release/MixAIDecks.app"
    ;;
  keybpmbuild)
    [ -d KeyBpmFFI/KeyBpmFFI.xcframework ] || ./scripts/build-keybpm-xcframework.sh device
    generate
    log "compile MixAI Key & BPM (iphoneos + embedded watchOS app, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAIKeyBpm -configuration Release \
      -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release-iphoneos/MixAIKeyBpm.app"
    ;;
  keybpmwatchsim)
    [ -d KeyBpmFFI/KeyBpmFFI.xcframework/watchos-arm64_x86_64-simulator ] || ./scripts/build-keybpm-xcframework.sh sim
    generate
    ./scripts/keybpm-watch-shots.sh
    ;;
  keybpmdevipa)
    [ -d KeyBpmFFI/KeyBpmFFI.xcframework ] || ./scripts/build-keybpm-xcframework.sh device
    archive MixAIKeyBpm
    export_plist "${EXPORT_METHOD:-debugging}" export
    log "export MixAI Key & BPM (${EXPORT_METHOD:-debugging})"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    cp "$OUT/export/"*.ipa "$OUT/mixai-dev.ipa"
    log "OK: $OUT/mixai-dev.ipa ($(du -h "$OUT/mixai-dev.ipa" | cut -f1))"
    ;;
  keybpmupload)
    # Store builds use the full release profile (fat LTO) for the Rust engine.
    KEYBPM_RELEASE=1 ./scripts/build-keybpm-xcframework.sh device
    archive MixAIKeyBpm
    export_plist app-store-connect upload
    log "export + upload MixAI Key & BPM to App Store Connect"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    log "UPLOADED MixAI Key & BPM build $BUILD_NUMBER (TestFlight processing takes ~5-15 min)"
    ;;
  musicdevipa)
    archive MixAIMusic
    export_plist "${EXPORT_METHOD:-debugging}" export
    log "export MixAI Music (${EXPORT_METHOD:-debugging})"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    cp "$OUT/export/"*.ipa "$OUT/mixai-dev.ipa"
    log "OK: $OUT/mixai-dev.ipa ($(du -h "$OUT/mixai-dev.ipa" | cut -f1))"
    ;;
  musicupload)
    archive MixAIMusic
    export_plist app-store-connect upload
    log "export + upload MixAI Music to App Store Connect"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    log "UPLOADED MixAI Music build $BUILD_NUMBER (TestFlight processing takes ~5-15 min)"
    ;;
  build)
    generate
    log "compile (iphoneos, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAI -configuration Release \
      -destination 'generic/platform=iOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release-iphoneos/MixAI.app"
    ;;
  tvbuild)
    generate
    log "compile MixAI TV (appletvos, unsigned)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAITV -configuration Release \
      -destination 'generic/platform=tvOS' -derivedDataPath "$OUT/dd" "${SPM_FLAGS[@]}" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build -quiet
    log "OK: $OUT/dd/Build/Products/Release-appletvos/MixAITV.app"
    ;;
  devipa)
    archive
    export_plist "${EXPORT_METHOD:-debugging}" export
    log "export (${EXPORT_METHOD:-debugging})"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    cp "$OUT/export/"*.ipa "$OUT/mixai-dev.ipa"
    log "OK: $OUT/mixai-dev.ipa ($(du -h "$OUT/mixai-dev.ipa" | cut -f1))"
    ;;
  upload)
    archive
    export_plist app-store-connect upload
    log "export + upload to App Store Connect"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    log "UPLOADED build $BUILD_NUMBER (TestFlight processing takes ~5-15 min)"
    ;;
  tvupload)
    # No Apple TV is registered on the team, so automatic signing cannot create the tvOS DEVELOPMENT profile it
    # wants while archiving ("Your team has no devices from which to generate a provisioning profile"). Archive
    # unsigned and let the App Store Connect export apply cloud-managed distribution signing (no device needed).
    : "${DEVELOPMENT_TEAM:?}" "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}" "${BUILD_NUMBER:?}"
    generate
    build_keychain
    AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
    rm -rf "$OUT/MixAI.xcarchive" "$OUT/export"
    log "archive MixAITV unsigned (build $BUILD_NUMBER)"
    xcodebuild -project MixAI.xcodeproj -scheme MixAITV -configuration Release \
      -destination 'generic/platform=tvOS' -derivedDataPath "$OUT/dd" \
      -archivePath "$OUT/MixAI.xcarchive" "${SPM_FLAGS[@]}" \
      DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO archive -quiet
    export_plist app-store-connect upload
    log "export + upload MixAI TV (tvOS) to App Store Connect"
    xcodebuild -exportArchive -archivePath "$OUT/MixAI.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${AUTH[@]}"
    log "UPLOADED tvOS build $BUILD_NUMBER (TestFlight processing takes ~5-15 min)"
    ;;
  *)
    echo "usage: $0 test|build|tvbuild|devipa|upload|tvupload|musicbuild|musicdevipa|musicupload|decksbuild|decksmacbuild|keybpmbuild|keybpmwatchsim|keybpmdevipa|keybpmupload" >&2
    exit 2
    ;;
esac
