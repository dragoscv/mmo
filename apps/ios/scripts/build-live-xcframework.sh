#!/usr/bin/env bash
# Build the MixAI Live engine (apps/live/engine/crates/live-ffi, UniFFI 0.32) for Apple platforms and package it
# for LiveApp's "Local engine" mode (WP21-06, ADR-0015):
#
#   apps/ios/LiveFFI/LiveFFI.xcframework           static liblive_ffi.a per platform + C header + module map
#   apps/ios/LiveFFI/Sources/LiveFFI/LiveFFI.swift generated Swift bindings (module LiveFFI)
#
# Both are gitignored; apps/ios/LiveFFI/Package.swift (committed) wraps them as the `LiveFFI` Swift package.
#
#   scripts/build-live-xcframework.sh [all|ios|ios-device|ios-sim|macos]   (default ios)
#
# Env:
#   LIVE_RUST_ROOT    repo root that holds apps/live/engine (default: this repo)
#   CARGO_TARGET_DIR  default ~/.cache/mixai-live-target
#   LIVE_RELEASE=1    full release profile; default = release with thin LTO off (fast iteration)
set -euo pipefail

WHAT="${1:-ios}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # apps/ios
ROOT="${LIVE_RUST_ROOT:-$(cd "$HERE/../.." && pwd)}"
WS="$ROOT/apps/live/engine"
PKG="$HERE/LiveFFI"
OUT="$PKG/LiveFFI.xcframework"
SWIFT_OUT="$PKG/Sources/LiveFFI"
WORK="$HERE/build/live-ffi"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/mixai-live-target}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"

log() { printf '== %s\n' "$*"; }

if [ ! -f "$WS/crates/live-ffi/Cargo.toml" ]; then
  echo "live-ffi not found under $WS (set LIVE_RUST_ROOT)" >&2
  exit 2
fi
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$HOME/Applications/Xcode.app" ]; then
  export DEVELOPER_DIR="$HOME/Applications/Xcode.app/Contents/Developer"
fi
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
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
  grep -qx "$t" <<<"$installed" || { log "rustup target add $t"; rustup target add "$t"; }
done
log "$(rustc --version) on $(uname -m), targets: ${TARGETS[*]}"

PROFILE_ENV=()
if [ "${LIVE_RELEASE:-0}" != "1" ]; then
  PROFILE_ENV=(CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16)
fi
for t in "${TARGETS[@]}"; do
  log "cargo rustc live-ffi --target $t (staticlib)"
  (cd "$WS" && env "${PROFILE_ENV[@]}" cargo rustc -p live-ffi --lib --release --target "$t" --crate-type staticlib)
done

lib() { echo "$CARGO_TARGET_DIR/$1/release/liblive_ffi.a"; }
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/headers" "$SWIFT_OUT"

log "uniffi-bindgen generate (swift)"
(cd "$WS" && cargo run -q -p live-ffi --features cli --bin uniffi-bindgen -- \
  generate --library "$(lib "${TARGETS[0]}")" --language swift --out-dir "$WORK/swift")
cp "$WORK/swift/LiveFFI.swift" "$SWIFT_OUT/LiveFFI.swift"
cp "$WORK/swift/live_ffiFFI.h" "$WORK/headers/live_ffiFFI.h"
cp "$WORK/swift/live_ffiFFI.modulemap" "$WORK/headers/module.modulemap"

ARGS=()
has() { local x; for x in "${TARGETS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
if has aarch64-apple-ios; then
  mkdir -p "$WORK/ios"; cp "$(lib aarch64-apple-ios)" "$WORK/ios/liblive_ffi.a"
  ARGS+=(-library "$WORK/ios/liblive_ffi.a" -headers "$WORK/headers")
fi
if has aarch64-apple-ios-sim; then
  mkdir -p "$WORK/ios-sim"
  lipo -create "$(lib aarch64-apple-ios-sim)" "$(lib x86_64-apple-ios)" -output "$WORK/ios-sim/liblive_ffi.a"
  ARGS+=(-library "$WORK/ios-sim/liblive_ffi.a" -headers "$WORK/headers")
fi
if has aarch64-apple-darwin; then
  mkdir -p "$WORK/macos"
  lipo -create "$(lib aarch64-apple-darwin)" "$(lib x86_64-apple-darwin)" -output "$WORK/macos/liblive_ffi.a"
  ARGS+=(-library "$WORK/macos/liblive_ffi.a" -headers "$WORK/headers")
fi
log "xcodebuild -create-xcframework"
xcodebuild -create-xcframework "${ARGS[@]}" -output "$OUT"
log "OK: $OUT ($(du -sh "$OUT" | cut -f1)), bindings $(wc -l < "$SWIFT_OUT/LiveFFI.swift") lines"
