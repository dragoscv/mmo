# Changelog — MMO Companion

All notable changes to the companion (Electron desktop app + local Express server) are recorded here. The web app (`/app`), the browser extension (`/apps/extension`) and the native shells (`/apps/native`) each have their own changelogs / release notes.

## 1.0.0 — first stable release

First version published under the `muzicai.ro` domain. From this release the companion is considered API-stable: the device-pairing handshake, the device-token format and the audio-engine HTTP surface (`/api/devices/probe`, `/api/audio/local`, `/api/audio/device/:id`, `/api/library/*`, `/api/sse`) will only change in backwards-compatible ways within the 1.x line.

Highlights of the 0.x → 1.0 journey:

- **CORS**: production allowlist now covers `https://muzicai.ro` and `https://*.muzicai.ro`; localhost / 127.0.0.1 still allowed for development.
- **Device pairing**: tokens are hashed (HMAC-SHA256 with `MMO_SECRET_KEY`) before being persisted; the encrypted plaintext is kept only for re-display in the device-management UI.
- **Settings**: `getSettings()` now honors the stored `webAppUrl` instead of hardcoding the brand; the in-tray "Open web app" button respects per-user overrides.
- **Auto-updater**: electron-updater wired to the GitHub release pipeline (`companion-release.yml`) for Windows (NSIS), macOS (dmg + zip auto-update channel), Linux (AppImage + deb + rpm).
- **Bundled assets**: the in-process Python analysis worker, ffmpeg + ffprobe binaries, and the rekordbox-pdb parser are shipped inside the app bundle so the user doesn't need a separate install.
- **Logging**: ring-buffer log accessible from the system tray via "Open log folder"; sensitive fields (tokens, full filepaths under `$HOME`) are redacted on export.

Tagging this version (`v1.0.0`) triggers `companion-release.yml`, which runs electron-builder for win / mac / linux and uploads the artifacts to the GitHub Release page.

## 0.9.x — see git history

Prior 0.9.x development is tracked in the root [`CHANGELOG.md`](../CHANGELOG.md) under the "Companion" sections of each session entry.
