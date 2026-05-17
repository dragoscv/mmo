# Changelog — MMO Companion

All notable changes to the companion (Electron desktop app + local Express server) are recorded here. The web app (`/app`), the browser extension (`/apps/extension`) and the native shells (`/apps/native`) each have their own changelogs / release notes.

## 1.0.3 — CORS allowlist always merges defaults

- **Fix**: `audioOriginAllowlist` now always merges in the built-in defaults (`https://muzicai.ro`, `https://*.muzicai.ro`, `http://localhost:3000`, `http://127.0.0.1:3000`) on top of whatever the user has stored. Previous behaviour was "replace with stored value", which meant any installation that had been pointed at a different webAppUrl in the past (e.g. local dev or a sibling brand) would CORS-block the production muzicai.ro origin until the user manually fixed it in settings.

## 1.0.2 — tray-only startup fix

- **Critical**: the local HTTP server (`127.0.0.1:17899`) now starts even when `startMinimized` is enabled. Previously the post-paint task queue — which boots the Express server, audio inventory, virtual-audio reconcile and cloud-sync loop — only drained when the window was actually shown. Users running in tray-only mode never had a reachable companion, so the web app couldn't auto-detect it and pairing never completed. The queue now drains immediately on `ready-to-show` regardless of window visibility.

## 1.0.1 — auto-update polish

- **One-click install**: added an "Install update & restart" button that appears on the auth screen as soon as a new version has finished downloading. Clicking it bypasses the OS update dialog and immediately runs the installer + relaunches the freshly-installed binary.
- **Force-show after update**: the first launch after an update now always shows the main window, even when the user has `startMinimized` enabled. The flag is cleared after one launch so subsequent normal starts honour the preference again. Users explicitly asked for the update — they expect to see the new version come up.
- **New IPC**: `updater:install` (manual install trigger) and reuses the existing `updater:status` / `updater:check`. Exposed on `window.mmo.installUpdateNow()` via the preload bridge.

CI / build fixes that unblock the release pipeline:

- **Root `prepare` script** rewritten to a cross-platform Node one-liner. The previous `husky || true` broke Windows installs (`'true' is not recognized…`) which is why the 1.0.0 Windows `.exe` was never uploaded to the GitHub Release.
- **Companion CI**: explicit `pnpm rebuild better-sqlite3 audify` step so the native bindings exist when the test suite touches the SQLite-backed library catalog. Previously `pnpm approve-builds || true` left the bindings uncompiled and `vitest` crashed on `Could not locate the bindings file`.

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
