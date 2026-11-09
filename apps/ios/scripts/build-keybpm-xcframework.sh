#!/usr/bin/env bash
# Build the MixAI Key & BPM Rust engine (crates/mixai-listen-ffi, UniFFI 0.32) for Apple platforms (WP18-05, D69):
#
#   apps/ios/KeyBpmFFI/KeyBpmFFI.xcframework                 static libmixai_listen_ffi.a per platform + header + module map
#   apps/ios/KeyBpmFFI/Sources/KeyBpmFFI/mixai_listen_ffi.swift  generated Swift bindings
#
# Both are gitignored; apps/ios/KeyBpmFFI/Package.swift (committed) wraps them as the `KeyBpmFFI` Swift package.
#
#   scripts/build-keybpm-xcframework.sh [all|ios|ios-device|watch|sim]   (default all)
#
#   ios-device   aarch64-apple-ios                       (key CNN on)
#   ios-sim      aarch64-apple-ios-sim + x86_64-apple-ios (CNN on)
#   watch        aarch64-apple-watchos                   (Series 9+ / Ultra 2+, D69; classic key path, no CNN)
#   watch-sim    aarch64-apple-watchos-sim + x86_64-apple-watchos-sim (store screenshots from the Simulator)
#
# Env:
#   KEYBPM_RUST_ROOT  repo root holding crates/ (default: this repo)
#   CARGO_TARGET_DIR  default ~/.cache/mixai-keybpm-target
#   KEYBPM_RELEASE=1  full release profile (fat LTO); default = release without LTO (fast iteration)
set -euo pipefail

WHAT="${1:-all}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # apps/ios
ROOT="${KEYBPM_RUST_ROOT:-$(cd "$HERE/../.." && pwd)}"
WS="$ROOT/crates"
PKG="$HERE/KeyBpmFFI"
OUT="$PKG/KeyBpmFFI.xcframework"
SWIFT_OUT="$PKG/Sources/KeyBpmFFI"
WORK="$HERE/build/keybpm-ffi"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/mixai-keybpm-target}"
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
export WATCHOS_DEPLOYMENT_TARGET="${WATCHOS_DEPLOYMENT_TARGET:-11.0}"

log() { printf '== %s\n' "$*"; }

[ -f "$WS/mixai-listen-ffi/Cargo.toml" ] || { echo "mixai-listen-ffi not found under $WS (set KEYBPM_RUST_ROOT)" >&2; exit 2; }
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d "$HOME/Applications/Xcode.app" ]; then
  export DEVELOPER_DIR="$HOME/Applications/Xcode.app/Contents/Developer"
fi
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
command -v rustup >/dev/null 2>&1 || { echo "rustup missing (build-decks-xcframework.sh installs it)" >&2; exit 2; }

case "$WHAT" in
  all) TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-watchos aarch64-apple-watchos-sim x86_64-apple-watchos-sim) ;;
  ios) TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios) ;;
  ios-device) TARGETS=(aarch64-apple-ios) ;;
  watch) TARGETS=(aarch64-apple-watchos) ;;
  sim) TARGETS=(aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-watchos-sim x86_64-apple-watchos-sim) ;;
  device) TARGETS=(aarch64-apple-ios aarch64-apple-watchos) ;;
  *) echo "usage: $0 all|ios|ios-device|watch|sim|device" >&2; exit 2 ;;
esac
installed="$(rustup target list --installed)"
for t in "${TARGETS[@]}"; do
  case "$t" in *watchos*) continue ;; esac   # tier 3: built from source with nightly -Zbuild-std below
  grep -qx "$t" <<<"$installed" || { log "rustup target add $t"; rustup target add "$t"; }
done
# watchOS targets are Rust tier 3 (no prebuilt std): nightly + rust-src, std built per target.
if printf '%s\n' "${TARGETS[@]}" | grep -q watchos; then
  rustup toolchain list | grep -q '^nightly' || { log "rustup toolchain install nightly"; rustup toolchain install nightly --profile minimal; }
  rustup component list --toolchain nightly --installed | grep -q '^rust-src' || rustup component add rust-src --toolchain nightly
fi
log "$(rustc --version) on $(uname -m), targets: ${TARGETS[*]}"

PROFILE_ENV=()
[ "${KEYBPM_RELEASE:-0}" = "1" ] || PROFILE_ENV=(CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16)

build_target() { # target
  local t="$1" feats=() tc=() zb=()
  case "$t" in
    # watch: classic key path (no tract), smaller + faster; std built from source (tier 3).
    *watchos*) feats=(--no-default-features); tc=(+nightly); zb=(-Zbuild-std=std,panic_abort) ;;
  esac
  log "cargo rustc mixai-listen-ffi --target $t ${feats[*]:-}"
  # ${a[@]+"${a[@]}"}: macOS bash 3.2 treats an empty array as unbound under set -u.
  (cd "$WS" && env ${PROFILE_ENV[@]+"${PROFILE_ENV[@]}"} cargo ${tc[@]+"${tc[@]}"} rustc ${zb[@]+"${zb[@]}"} \
    -p mixai-listen-ffi --lib --release --target "$t" ${feats[@]+"${feats[@]}"} --crate-type staticlib)
}
for t in "${TARGETS[@]}"; do build_target "$t"; done

lib() { echo "$CARGO_TARGET_DIR/$1/release/libmixai_listen_ffi.a"; }

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/headers" "$SWIFT_OUT"
log "uniffi-bindgen generate (swift)"
(cd "$WS" && cargo run -q -p mixai-listen-ffi --features cli --bin uniffi-bindgen -- \
  generate --library "$(lib "${TARGETS[0]}")" --language swift --out-dir "$WORK/swift")
cp "$WORK/swift/mixai_listen_ffi.swift" "$SWIFT_OUT/mixai_listen_ffi.swift"
cp "$WORK/swift/mixai_listen_ffiFFI.h" "$WORK/headers/mixai_listen_ffiFFI.h"
cp "$WORK/swift/mixai_listen_ffiFFI.modulemap" "$WORK/headers/module.modulemap"

ARGS=()
has() { local x; for x in "${TARGETS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }
slice() { # name targets...
  local name="$1"; shift
  mkdir -p "$WORK/$name"
  if [ $# -eq 1 ]; then cp "$(lib "$1")" "$WORK/$name/libmixai_listen_ffi.a"
  else local libs=(); for t in "$@"; do libs+=("$(lib "$t")"); done; lipo -create "${libs[@]}" -output "$WORK/$name/libmixai_listen_ffi.a"; fi
  ARGS+=(-library "$WORK/$name/libmixai_listen_ffi.a" -headers "$WORK/headers")
}
has aarch64-apple-ios && slice ios aarch64-apple-ios
has aarch64-apple-ios-sim && slice ios-sim aarch64-apple-ios-sim x86_64-apple-ios
has aarch64-apple-watchos && slice watch aarch64-apple-watchos
has aarch64-apple-watchos-sim && slice watch-sim aarch64-apple-watchos-sim x86_64-apple-watchos-sim
log "xcodebuild -create-xcframework"
xcodebuild -create-xcframework "${ARGS[@]}" -output "$OUT"
log "OK: $OUT ($(du -sh "$OUT" | cut -f1)), bindings $(wc -l < "$SWIFT_OUT/mixai_listen_ffi.swift") lines"
