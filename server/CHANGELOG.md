# Changelog — MMO Companion

All notable changes to the companion (Electron desktop app + local Express server) are recorded here. The web app (`/app`), the browser extension (`/apps/extension`) and the native shells (`/apps/native`) each have their own changelogs / release notes.

## 1.0.17 — unfreeze the folder picker

- **Critical perf fix**: a disconnected USB / empty optical drive / sleeping network share would make the picker take *minutes* to list drives or open a folder. Root cause: every existence / access check on the companion side (`fs.existsSync` in `listFolders()`, `fsp.access` in `listDrivesWin`, `fsp.stat` on symlinks in `listDirectory`) had no timeout, and Windows can sit on a request to a not-ready drive for tens of seconds while blocking the *entire* Node event loop — the same loop that serves `/fs/drives` and `/fs/list` over the tunnel. Symptom in the debug log: `[freeze] event-loop blocked for ~Xms` warnings stacking up while the picker spun.
- **What changed**: added `probeAccess` / `statBounded` wrappers that race the FS call against a short timeout (500 ms for drive probes, 500 ms for symlink stat, 300 ms for scan-folder existence). Added a 10 s `existsBounded` cache so the every-30-s `getCompanionFolders` poll doesn't re-probe the same dead drive every tick. Made `listFolders()` async and updated all callers (command worker + `/folders` + `/fs/add`) so a bad path on one scan folder no longer freezes the whole companion.
- **Web picker debug strip**: the "Add a library folder" modal now shows the transport (tunnel / queue), latency in ms, and entry count for the last request — makes it obvious at a glance whether the tunnel fast path is actually being used.

## 1.0.10 — push-based liveness + device name sync

- **Web /devices online status fix**: Vercel can't reach the user's LAN, so the old server-side `fetch(apiUrl + "/health")` probe always failed and every device rendered "Offline". Replaced with a push-based heartbeat: the companion now POSTs `/api/devices/announce` every 30 s (was 5 min) carrying `{ hostname, os, version }`; the cloud sets `status: "online"` + `lastSeenAt: now()`; `pingDevice` returns online when `lastSeenAt < 90 s`.
- **Device name sync**: the announce response now returns the user-chosen `name` from the cloud. The companion stores it and displays it as a new "Device name" stat in the UI (above Port). Rename on /devices → the companion picks it up on the next 30 s tick.
- The `deviceName` value is cleared alongside the other auth keys on logout and on the 1.0.9 auto-invalidate path.

## 1.0.9 — self-heal orphaned pairings + live status refresh

- **Critical fix**: when the cloud no longer recognises the device token (HTTP 401 from `/api/devices/announce` or `/api/sync` — typical cause: device row deleted server-side or pairing half-failed), the companion now wipes the local pairing, stops cloud-sync + LAN-announce, and pushes the renderer back to the auth view via a new `auth-invalidated` IPC event. Previously a stale token produced a silent perpetual 401 loop with no user-facing signal.
- **UI**: the renderer now subscribes to a new `status-changed` IPC push (fired after the HTTP server actually binds) and additionally polls `getStatus()` every 3 s as a safety net. Fixes the long-standing "Port: 0" stat that never updated to the real port (server boots asynchronously, status was only fetched at window-init time).
- **Web /devices**: auto-refresh dropped from 30 s → 5 s so a fresh pairing opened in a separate browser tab shows up on the existing /devices tab without manual reload.

## 1.0.8 — heal invalid serverPort, log actual bound port

- **Critical fix**: a `serverPort` of `0` persisted in some users' stores caused the HTTP server to silently bind to a random OS-chosen port. The companion logged "server started" but the web app's loopback discovery (which expects `17899`) found nothing, the LAN beacon URL pointed at port 0, and mDNS advertised garbage. `getSettings()` now validates the stored port (must be an integer in 1–65535) and resets to `17899` otherwise.
- **Recovery**: after `httpServer.listen()` the actual bound port is read back via `address()` so even if a request for port 0 slipped through, downstream consumers see the real number.
- **Log line**: `server started` now includes the bound port (e.g. `server started on port 17899`) so bug reports surface the issue at a glance.

## 1.0.7 — drop localhost:3000 default, heal stale pairings

- **Fix**: cloud-sync was silently failing for users whose `webAppUrl` had been pinned to `http://localhost:3000` by an early dev pairing — the web app moved to port `13789` ages ago and port 3000 is the Node ecosystem default (high collision risk with other services). The companion now detects the known-bad legacy values (`http://localhost:3000`, `http://127.0.0.1:3000`) on startup and rewrites them to the production default `https://muzicai.ro`, so cloud-sync starts working again without the user having to repair from settings.
- **Defaults**: built-in `audioOriginAllowlist` now uses `http://localhost:13789` / `http://127.0.0.1:13789` instead of the legacy port 3000 entries.
- **Tray menu**: "Open MMO in Browser" falls back to `https://muzicai.ro` instead of `http://localhost:3000` when no `webAppUrl` is set (should never happen, but defends against corrupted store).

## 1.0.6 — LAN beacon + mDNS broadcast

- **Cross-device discovery (LAN beacon)**: at startup and every 5 minutes the companion now posts its LAN URL (e.g. `http://192.168.1.42:17899`) to the paired account via `POST /api/devices/announce`. The web app then exposes a per-user `/api/devices/peers` endpoint that the browser uses as a discovery fallback when loopback probing fails — so a tablet on the couch finds the desktop companion without manual config.
- **mDNS / Bonjour broadcast**: companion publishes `_mmo-companion._tcp` on the local network with a TXT record (`product`, `version`, `api`). Native MMO shells (TV, mobile) can now discover the companion without going through the cloud.
- **Network interface picking**: prefers the user's real Wi-Fi / Ethernet IP and skips virtual adapters (`vEthernet`, `vmnet`, `vbox`, `docker`, `WSL`, `Tailscale`, `utun`, `tap`) to avoid announcing useless container bridges.
- **Pairing**: the LAN URL is announced immediately after the user completes web-app pairing, not just on the periodic tick.

## 1.0.5 — manual update check button

- **UI**: added a small refresh button (↻) next to the version footer that triggers an on-demand update check. Surfaces "Checking… / Up to date / Downloading… / Update ready" inline so the user can pull a release immediately instead of waiting for the 4-hour background recheck.

## 1.0.4 — simplified main view + audio setup consolidation

- **UI**: removed the "Music Folders" section and the "Folders" stat from the main view. Library folders are managed end-to-end from the web app at https://muzicai.ro/devices (pick, scan, remove, watch toggle, per-folder progress), so the companion no longer duplicates that UI.
- **UI**: moved the "Physical Audio Devices" section and the live engine metrics widget into the Audio Setup view next to the Virtual Devices list. Audio inventory is now lazy-loaded the first time the user opens that view, so the main view paints faster on cold start.

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
