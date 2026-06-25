# Changelog — MMO Companion

All notable changes to the companion (Electron desktop app + local Express server) are recorded here. The web app (`/app`), the browser extension (`/apps/extension`) and the native shells (`/apps/native`) each have their own changelogs / release notes.

## 1.0.41 — resync analyzed tracks endpoint

- **New `POST /analyze/resync`** — re-enqueues a cloud sync upsert for every
	track that already has analysis results (any of `analyzed_at`/`dsp_analyzed_at`
	/`stems_analyzed_at`/`bpm`/`acoustid_fingerprint`/`genre`/`artwork_url` set),
	WITHOUT recomputing. Scoped to the calling user. Lets the web app push
	previously analyzed results (that predate the 1.0.40 sync fix) up to the
	cloud library. Returns `{ queued, total }`.

## 1.0.40 — fix: analysis results never synced to cloud library

- **Analysis results (DSP/Stems/Fingerprint/Metadata) now round-trip to the
	cloud library.** `persistResult()` wrote the new fields into the companion's
	local SQLite `tracks` table but never enqueued a cloud sync change, so the web
	library (which reads from cloud Postgres) never showed updated songs —
	metadata, BPM, key, artwork, lyrics, etc. all stayed invisible online. It now
	enqueues a `tracks` upsert (LWW, keyed by sha256) after every successful
	persist, mirroring `routes.ts` `pushTrackChange`. Best-effort: a sync failure
	never breaks the analyzer.

## 1.0.39 — fix: "no such column: batch_id" on upgrade

- **Fixed a startup crash ("audio engine unavailable" / `no such column:
	batch_id`) when upgrading an existing library DB to 1.0.38.** The bootstrap
	`CREATE INDEX idx_analyzer_batch ON analyzer_jobs(batch_id)` ran before the
	`ALTER TABLE … ADD COLUMN batch_id` migration; on an existing DB the
	`CREATE TABLE IF NOT EXISTS` is a no-op, so the index hit a missing column.
	The batch index is now created by `migrate()` after the column is added.

## 1.0.38 — analysis runs grouped into one job (batches)

- **A "Start analysis" run is now one logical job containing many item
	sub-jobs.** `analyzer_jobs` rows carry `batch_id`/`batch_label`, `enqueue()`
	accepts a `batch`, and the new `GET /analyze/batches` endpoint returns one
	`BatchSummary` per run with live aggregate counts (queued/running/done/
	errored/progress/state). Surfaced via `Analyzer.batches()`.

## 1.0.37 — metadata analysis lane

- **Metadata/Artwork/Lyrics/BPM-from-web fetching is now a 4th in-process
	analyzer lane ("metadata")** instead of a client-side modal loop, so a run
	persists across page refreshes and survives serverless restarts.

## 1.0.36 — cloud sync moves to the gateway (api.muzicai.ro)

- **Cloud library sync now runs against the gateway** (`api.muzicai.ro`) instead
	of the Vercel web app, alongside the heartbeat. Same last-write-wins
	behaviour, identical conflict resolution (shared code), just served by the
	dedicated long-lived service. The control plane default is now the stable
	`api.muzicai.ro` custom domain. Existing pairings switch automatically.

## 1.0.35 — persistent WebSocket heartbeat to the gateway

- **The companion now keeps a persistent WebSocket open to the gateway** for
	its heartbeat + command channel instead of polling every few seconds.
	Benefits: the web app flips your device online/offline instantly (no more
	waiting for a stale "last seen" to expire), lower latency for folder
	pickers / audio enumeration, and far less chatter. If the socket can't be
	established it automatically falls back to the previous HTTP heartbeat, so
	connectivity is never worse than before. Reconnects with backoff across
	sleep / Wi-Fi roams.

## 1.0.34 — heartbeat moves to the new API gateway (off Vercel)

- **The device heartbeat / command channel now targets the dedicated MuzicAI
	gateway (Hono on Cloud Run) instead of posting directly to the Vercel web
	app.** The chatty ~10s announce loop was hitting serverless cold starts,
	causing `AbortError` timeouts and a stale "last seen" that made the web
	app show "Reconnecting to companion…" even while the companion was up. A
	new `gatewayUrl` setting (default the Cloud Run service URL; override via
	`MMO_GATEWAY_URL`) points the control plane at the long-lived gateway.
	Audio, sync and OAuth still use the web app — only the heartbeat moved.
	Existing pairings pick up the new default automatically; no re-pair needed.

## 1.0.33 — restore settings lost in the rebrand (fixes 403 / "can't reach companion")

- **Recovers your scan folders, pairing and tunnel settings after the rebrand.**
	Renaming the app (mmo-companion → muzicai-companion) moved Electron's data
	directory, orphaning the old `config.json`. Affected installs started with
	**empty scan folders**, so the companion rejected every audio request with
	`403 "Path not in allowed folders"` — the web app showed "can't reach the
	companion" / no playback even though metadata was present. On startup the
	companion now does a one-time, field-level restore from the legacy config:
	any setting missing in the new config (scan folders, device token, tunnel
	hostname, authorized audio devices, …) is copied over from the old one.
	Existing non-empty values are never overwritten.

## 1.0.32 — setup window stays open until you close it

- **The analyzer setup window no longer auto-closes.** When provisioning
	finishes it shows a green "All done" state with a **Close** button and waits
	for you — it won't vanish on its own. On error it stays open too, with a
	short explanation, so nothing disappears silently.
- Note: if the analyzer still shows "offline" in the web app, the **companion
	app simply isn't running** — launch it and the managed Python 3.12 env
	(already provisioned with stems + GPU) is used automatically.

## 1.0.31 — fully automatic analyzer setup (managed Python + stems + GPU)

- **Stems now work completely, automatically.** The companion provisions an
	isolated, managed **CPython 3.12** environment via `uv` (a dedicated venv
	under the app data dir — never touches system Python) so the heavy stem
	stack (`audio-separator`, `torch`, `onnxruntime`) installs from prebuilt
	wheels. This fixes the case where a too-new system Python (e.g. 3.14) made
	audio-separator's native deps fail to build.
- **A friendly setup window — you do nothing.** A small always-on-top progress
	window shows the one-time install (Python env → audio analysis → stems →
	GPU) with a live checklist. The main app keeps loading behind it; the window
	closes itself when done.
- **Non-blocking startup.** Provisioning runs after first paint, so the app
	opens immediately even on a brand-new machine (fixes the "app won't start
	after update" feeling).
- **Only installs what's missing.** A fully-provisioned machine shows no
	window at all; otherwise only the missing pieces are fetched. Idempotent and
	retried next launch on failure.
- **Automatic GPU acceleration.** When an NVIDIA GPU + CUDA runtime is present,
	`onnxruntime-gpu` is installed for faster stem separation (best-effort; CPU
	stems still work if it fails). Opt out of all of this with
	`MMO_ANALYZER_AUTOINSTALL=0`.

## 1.0.30 — silent analyzer dependency auto-install

- **Analyzer Python deps now install themselves, silently.** On startup the
	companion checks the analyzer health and, if the core packages are missing,
	pip-installs them in the background — no terminal, no button, no prompt. DSP
	(BPM/key/beats), loudness (LUFS) and AcoustID fingerprinting work out of the
	box on a fresh machine. Implemented as a new `deps_install` sidecar command
	+ `analyzer.ensureDepsInstalled()` invoked after first paint.
- **Two-tier, fault-isolated install.** The reliable pure-wheel core
	(`numpy`, `soundfile`, `librosa`, `pyloudnorm`, `pyacoustid`) installs as one
	group; the heavier stems engine (`audio-separator[cpu]`) installs separately
	and best-effort, so a stems build failure (e.g. on a bleeding-edge Python)
	never blocks DSP/loudness/fingerprint. Retries each launch; opt out with
	`MMO_ANALYZER_AUTOINSTALL=0`.

## 1.0.29 — stable tunnel transport

- **Cloudflare tunnel forced to HTTP/2 (TCP) instead of QUIC (UDP).** The
	default QUIC transport degraded mid-session on UDP-throttling networks
	(residential ISPs, VPNs, Wi-Fi) — `failed to run the datagram handler` /
	`control stream encountered a failure` — leaving the tunnel origin
	unreachable for up to ~1 minute and surfacing to the web app as HTTP 530
	(e.g. "Companion analyzer offline", audio stream drops). The companion now
	spawns cloudflared with `--protocol http2 --edge-ip-version 4`, which is far
	steadier. Overridable via `MMO_TUNNEL_PROTOCOL` / `MMO_TUNNEL_EDGE_IP`.

## 1.0.28 — rekordbox USB export + drive library management

- **Rekordbox plug-and-play USB export.** New native `rbexport` sidecar
	(bundled under `resources/bin`) writes a true CDJ/XDJ USB: `Contents/`
	audio + `export.pdb` + `exportExt.pdb` (Device Library Plus) + `USBANLZ`
	analysis (beatgrid, cues, full-res + color waveforms). Driven by
	`POST /library/rekordbox/export` (SSE progress), with track resolution,
	transcode policy and auto-crates. Fixed the DeviceSQL page-header
	row-count bitfield so rekordbox no longer reports a corrupted library.
- **Drive library management.** `GET /library/drives` now annotates each
	drive with its rekordbox status; added `POST /library/drives/rekordbox/clean`
	(remove DB/analysis, opt-in OneLibrary/Contents) and a
	`GET /library/drives/watch` SSE stream for live plug/unplug detection.

## 1.0.18 — instant picker open

- **Drive probe timeout 500 ms → 250 ms**: healthy local drives respond in <10 ms, so the previous 500 ms cap was over-conservative. With this change `/fs/drives` returns in <300 ms even if every drive letter is a stalled mount.
- Pairs with the web app's eager prefetch (web 0.3.5): the modal now paints from cache the instant it opens and a background refresh kicks in.

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
