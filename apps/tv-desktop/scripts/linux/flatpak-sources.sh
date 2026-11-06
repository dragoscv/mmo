#!/usr/bin/env bash
# Generate the offline source lists for the Flathub manifest (WP17-27) next to flatpak/ro.mixai.tv.desktop.yml:
#   cargo-sources.json (Cargo.lock) and node-sources-{tizen,desktop}.json (pnpm-lock.yaml, pnpm store v10).
# Needs python3 + pipx (or pip --user). Run from anywhere on Linux:  apps/tv-desktop/scripts/linux/flatpak-sources.sh
set -euo pipefail
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$APPDIR/flatpak"
TOOLS="${TOOLS:-$HOME/.cache/flatpak-builder-tools}"
[ -d "$TOOLS/.git" ] || git clone --depth 1 https://github.com/flatpak/flatpak-builder-tools.git "$TOOLS"
python3 -m venv "$TOOLS/.venv" 2>/dev/null || true
"$TOOLS/.venv/bin/pip" install -q aiohttp toml tomlkit 2>/dev/null || true
"$TOOLS/.venv/bin/pip" install -q "$TOOLS/node" 2>/dev/null || true
"$TOOLS/.venv/bin/python" "$TOOLS/cargo/flatpak-cargo-generator.py" "$APPDIR/src-tauri/Cargo.lock" -o "$OUT/cargo-sources.json"
"$TOOLS/.venv/bin/flatpak-node-generator" pnpm "$APPDIR/../tv-tizen/pnpm-lock.yaml" -o "$OUT/node-sources-tizen.json"
"$TOOLS/.venv/bin/flatpak-node-generator" pnpm "$APPDIR/pnpm-lock.yaml" -o "$OUT/node-sources-desktop.json"
ls -la "$OUT"/*.json
