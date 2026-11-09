#!/usr/bin/env bash
# Build the MixAI Decks Rust core (apps/mixai/src-tauri/crates/decks-ffi, UniFFI 0.32) for Apple platforms and
# package it for the SwiftUI app (WP19-15, ADR-0014 D61):
#
#   apps/ios/DecksFFI/DecksFFI.xcframework             static libdecks_ffi.a per platform + C header + module map
#   apps/ios/DecksFFI/Sources/DecksFFI/DecksFFI.swift  generated Swift bindings (module DecksFFI)
#
# Both are gitignored; apps/ios/DecksFFI/Package.swift (committed) wraps them as the `DecksFFI` Swift package.
#
#   scripts/build-decks-xcframework.sh [all|ios|ios-device|ios-sim|macos]   (default all)
#
#   ios-device  aarch64-apple-ios
#   ios-sim     aarch64-apple-ios-sim + x86_64-apple-ios (lipo)
#   macos       aarch64-apple-darwin + x86_64-apple-darwin (lipo, universal)
#
# Env:
#   DECKS_RUST_ROOT   repo root that holds apps/mixai/src-tauri and crates/ (default: this repo)
#   CARGO_TARGET_DIR  default ~/.cache/mixai-decks-target (kept between builds: registry deps compile once)
#   DECKS_RELEASE=1   full release profile (fat LTO, 1 codegen unit); default = release without LTO (fast iteration)
set -euo pipefail

WHAT="${1:-all}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # apps/ios
ROOT="${DECKS_RUST_ROOT:-$(cd "$HERE/../.." && pwd)}"
WS="$ROOT/apps/mixai/src-tauri"
PKG="$HERE/DecksFFI"
OUT="$PKG/DecksFFI.xcframework"
SWIFT_OUT="$PKG/Sources/DecksFFI"
WORK="$HERE/build/decks-ffi"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/mixai-decks-target}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"

log() { printf '== %s\n' "$*"; }

if [ ! -f "$WS/crates/decks-ffi/Cargo.toml" ]; then
  echo "decks-ffi not found under $WS (set DECKS_RUST_ROOT)" >&2
  exit 2
fi

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$HOME/Applications/Xcode.app" ]; then
  export DEVELOPER_DIR="$HOME/Applications/Xcode.app/Contents/Developer"
fi

# --- Rust toolchain (idempotent) -------------------------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if ! command -v rustup >/dev/null 2>&1; then
  log "installing rustup (minimal profile)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
# decks-ffi needs Rust >= 1.90 (mixai-core); `stable` is updated only when older.
need_minor=90
have_minor="$(rustc --version 2>/dev/null | sed -E 's/^rustc 1\.([0-9]+).*/\1/' || echo 0)"
if [ "${have_minor:-0}" -lt "$need_minor" ]; then
  log "rustc 1.$have_minor < 1.$need_minor -> rustup update stable"
  rustup toolchain install stable --profile minimal
  rustup default stable
fi

TARGETS=()
case "$WHAT" in
  all) TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin x86_64-apple-darwin) ;;
  ios) TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios) ;;
  ios-device) TARGETS=(aarch64-apple-ios) ;;
  ios-sim) TARGETS=(aarch64-apple-ios-sim x86_64-apple-ios) ;;
  macos) TARGETS=(aarch64-apple-darwin x86_64-apple-darwin) ;;
  *) echo "usage: $0 all|ios|ios-device|ios-sim|macos" >&2; exit 2 ;;
esac
installed="$(rustup target list --installed)"
for t in "${TARGETS[@]}"; do
  if ! grep -qx "$t" <<<"$installed"; then
    log "rustup target add $t"
    rustup target add "$t"
  fi
done
log "$(rustc --version) on $(uname -m), targets: ${TARGETS[*]}"

# bindgen (signalsmith-stretch) needs libclang + the SDK sysroot of each Apple target.
TOOLCHAIN_LIB="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain/usr/lib"
if [ -z "${LIBCLANG_PATH:-}" ] && [ -f "$TOOLCHAIN_LIB/libclang.dylib" ]; then
  export LIBCLANG_PATH="$TOOLCHAIN_LIB"
fi

PROFILE_ENV=()
if [ "${DECKS_RELEASE:-0}" != "1" ]; then
  PROFILE_ENV=(CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16)
fi

build_target() { # target
  local t="$1" sdk clang_target
  case "$t" in
    aarch64-apple-ios) sdk=iphoneos; clang_target="arm64-apple-ios$IPHONEOS_DEPLOYMENT_TARGET" ;;
    aarch64-apple-ios-sim) sdk=iphonesimulator; clang_target="arm64-apple-ios$IPHONEOS_DEPLOYMENT_TARGET-simulator" ;;
    x86_64-apple-ios) sdk=iphonesimulator; clang_target="x86_64-apple-ios$IPHONEOS_DEPLOYMENT_TARGET-simulator" ;;
    aarch64-apple-darwin) sdk=macosx; clang_target="arm64-apple-macosx$MACOSX_DEPLOYMENT_TARGET" ;;
    x86_64-apple-darwin) sdk=macosx; clang_target="x86_64-apple-macosx$MACOSX_DEPLOYMENT_TARGET" ;;
  esac
  local sysroot
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  local var="BINDGEN_EXTRA_CLANG_ARGS_${t//-/_}"
  log "cargo rustc decks-ffi --target $t (staticlib)"
  (cd "$WS" && env "${PROFILE_ENV[@]}" "$var=--target=$clang_target -isysroot $sysroot" SDKROOT="$sysroot" \
    cargo rustc -p decks-ffi --lib --release --target "$t" --crate-type staticlib -- --print native-static-libs)
}

for t in "${TARGETS[@]}"; do build_target "$t"; done

lib() { echo "$CARGO_TARGET_DIR/$1/release/libdecks_ffi.a"; }

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/headers" "$SWIFT_OUT"

# --- Swift bindings (library mode reads the UniFFI metadata from the built archive) ---------------------------
log "uniffi-bindgen generate (swift)"
(cd "$WS" && cargo run -q -p decks-ffi --features cli --bin uniffi-bindgen -- \
  generate --library "$(lib "${TARGETS[0]}")" --language swift --out-dir "$WORK/swift")
cp "$WORK/swift/DecksFFI.swift" "$SWIFT_OUT/DecksFFI.swift"
cp "$WORK/swift/decks_ffiFFI.h" "$WORK/headers/decks_ffiFFI.h"
# SwiftPM / Xcode find a static XCFramework's module through Headers/module.modulemap.
cp "$WORK/swift/decks_ffiFFI.modulemap" "$WORK/headers/module.modulemap"

# --- One archive per platform (lipo the multi-arch ones) ------------------------------------------------------
ARGS=()
has() { local x; for x in "${TARGETS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
if has aarch64-apple-ios; then
  mkdir -p "$WORK/ios"; cp "$(lib aarch64-apple-ios)" "$WORK/ios/libdecks_ffi.a"
  ARGS+=(-library "$WORK/ios/libdecks_ffi.a" -headers "$WORK/headers")
fi
if has aarch64-apple-ios-sim; then
  mkdir -p "$WORK/ios-sim"
  lipo -create "$(lib aarch64-apple-ios-sim)" "$(lib x86_64-apple-ios)" -output "$WORK/ios-sim/libdecks_ffi.a"
  ARGS+=(-library "$WORK/ios-sim/libdecks_ffi.a" -headers "$WORK/headers")
fi
if has aarch64-apple-darwin; then
  mkdir -p "$WORK/macos"
  lipo -create "$(lib aarch64-apple-darwin)" "$(lib x86_64-apple-darwin)" -output "$WORK/macos/libdecks_ffi.a"
  ARGS+=(-library "$WORK/macos/libdecks_ffi.a" -headers "$WORK/headers")
fi
log "xcodebuild -create-xcframework"
xcodebuild -create-xcframework "${ARGS[@]}" -output "$OUT"
log "OK: $OUT ($(du -sh "$OUT" | cut -f1)), bindings $(wc -l < "$SWIFT_OUT/DecksFFI.swift") lines"
