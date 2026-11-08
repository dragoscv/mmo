#!/usr/bin/env bash
# Generate the offline source lists for the Flathub manifest (WP17-43) next to flatpak/ro.mixai.music.desktop.yml:
#   cargo-sources.json (Cargo.lock); the UI is remote, so no node sources.
# Needs python3 + pipx (or pip --user). Run from anywhere on Linux:  apps/music-desktop/scripts/linux/flatpak-sources.sh
set -euo pipefail
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$APPDIR/flatpak"
TOOLS="${TOOLS:-$HOME/.cache/flatpak-builder-tools}"
[ -d "$TOOLS/.git" ] || git clone --depth 1 https://github.com/flatpak/flatpak-builder-tools.git "$TOOLS"
python3 -m venv "$TOOLS/.venv" 2>/dev/null || true
"$TOOLS/.venv/bin/pip" install -q aiohttp toml tomlkit 2>/dev/null || true
"$TOOLS/.venv/bin/python" "$TOOLS/cargo/flatpak-cargo-generator.py" "$APPDIR/src-tauri/Cargo.lock" -o "$OUT/cargo-sources.json"
ls -la "$OUT"/*.json
