#!/usr/bin/env bash
# MixAI Music — Linux bundles (WP17-43): AppImage + .deb via `tauri build`, on Ubuntu 24.04 (WSL here, CI runner later).
#   apps/music-desktop/scripts/linux/build.sh            -> src-tauri/target/release/bundle/{appimage,deb}
# Needs: rustup stable, node 22+, and the WebKitGTK 4.1 dev packages (installed below when missing, needs sudo).
set -euo pipefail
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log() { printf '== %s\n' "$*"; }

need=(libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libssl-dev build-essential file)
missing=()
for p in "${need[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  log "apt install ${missing[*]}"
  sudo -n apt-get update -qq && sudo -n apt-get install -y -qq "${missing[@]}"
fi

# Lockfiles come from pnpm 10.0 (repo pin); newer global pnpm refuses ignored build scripts.
PNPM_PIN="$HOME/.pnpm-pin-10"
[ -x "$PNPM_PIN/bin/pnpm" ] || npm i -g --prefix "$PNPM_PIN" pnpm@10.0.0 >/dev/null
export PATH="$PNPM_PIN/bin:$HOME/.cargo/bin:$PATH" npm_config_manage_package_manager_versions=false
log "pnpm $(pnpm --version), $(rustc --version)"

cd "$APPDIR"
pnpm install --frozen-lockfile >/dev/null
[ -d src-tauri/icons ] || pnpm tauri:icon >/dev/null
# Keep cargo output on the Linux filesystem (building on /mnt/e is ~5x slower and breaks file locks).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/mixai-music-target}"
pnpm tauri build --bundles appimage,deb
OUT="$CARGO_TARGET_DIR/release/bundle"
ls -la "$OUT/appimage" "$OUT/deb"
log "OK: $(ls "$OUT"/appimage/*.AppImage) $(ls "$OUT"/deb/*.deb)"
