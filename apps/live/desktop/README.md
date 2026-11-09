# MixAI Live — desktop

Tauri 2 + React 19 + Vite 8 + TypeScript 7 + Tailwind 4 + `@mmo/ui` (Base UI) + Motion 13, RO/EN with
i18next. Decision record: [ADR-0015](../../../docs/adr/0015-mixai-live-performance.md); tracker WP21-07.

## Architecture

```text
┌──────────── MixAI Live (Tauri) ────────────┐        ┌──── mixai-live-engine (sidecar) ────┐
│ React UI ── protocol v1 over WebSocket ────┼──────► │ serve: cpal audio + live-remote     │
│   (tauri-plugin-websocket, Rust client)    │  127.0.0.1:17920 /ws?t=<controller>      │
│ Rust: list_devices · start/stop_engine ────┼─spawn─►│ devices / latency (one-shot runs)   │
│       measure_latency · fx_catalogue       │        │ /api/fx (effect catalogue)          │
│       pairing_qr · load/save_settings      │        │ phones/watches on the LAN (--lan)   │
└────────────────────────────────────────────┘        └─────────────────────────────────────┘
```

- The audio engine is a **separate process** (`apps/live/engine`, crate `live-cli`) bundled with
  `bundle.externalBin`. The shell spawns `serve`, parses its single `{"event":"ready",…}` stdout line
  (port, tokens, pairing URLs, device info) and kills it on restart and on app exit. A crash emits
  `engine://exit` to the UI.
- The UI uses **only protocol v1** ([docs/live/remote-protocol.md](../../../docs/live/remote-protocol.md)),
  exactly like the phone apps. The WebSocket is opened from Rust (`tauri-plugin-websocket`) because the
  engine refuses browser upgrades whose `Origin` differs from its host. `/api/fx` is fetched by a Rust
  command for the same reason (no CORS on the engine).
- Meters (30 Hz) bypass React: `lib/meter-bus.ts` keeps the latest frame and one shared
  `requestAnimationFrame` loop draws the canvas meters, gain-reduction bars and the tuner needle
  (~10 fps when reduced motion is on).
- Settings (`<app config dir>/settings.json`): device config, last preset, LAN toggle. Theme and language
  live in the shared prefs blob `localStorage["mixai:prefs:v1"]` via `@mmo/ui` `ThemeProvider`.

## Security

- Capabilities: `core:default`, `core:event:default`, `websocket:allow-connect`, `websocket:allow-send`.
  No shell/fs/http permission in the webview; the sidecar is spawned from Rust only.
- CSP: `default-src 'self'`, `connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:* http://127.0.0.1:*`.
- Device names, host and preset become CLI arguments: `EngineConfig::validate` refuses values starting with
  `-`, control characters and out-of-range numbers. `pairing_qr` only encodes `http://` / `mixai-live://` URLs.

## Develop

```powershell
# 1. Engine (repo root, through the shared build lock)
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Wait -Command 'cargo build --release -p live-cli --manifest-path apps/live/engine/Cargo.toml'
# 2. Copy it as a sidecar: src-tauri/binaries/mixai-live-engine-<target-triple>.exe
node apps/live/desktop/scripts/copy-engine.mjs
# 3. Install + run (own pnpm-workspace.yaml and lockfile)
cd apps/live/desktop; pnpm install; pnpm tauri:dev
```

Dev server port: **14430**. Engine control port: **17920** (OSC 17921).

## Verify

| Check | Command (in `apps/live/desktop`) |
|---|---|
| Types | `pnpm typecheck` (tsc 7) |
| Unit tests | `pnpm test` (vitest: protocol reducer, param normalisation, routing, shortcuts, i18n parity) |
| i18n parity | `pnpm i18n:check` |
| Hex gate | `node scripts/hex-gate.mjs apps/live/desktop/src` (repo root) |
| Bundle | `pnpm build` |
| Rust | `cargo check` / `cargo test --manifest-path apps/live/desktop/src-tauri/Cargo.toml` (via `run-build.ps1`) |

## Keyboard

Space = bypass · M = mute · ←/→ = previous/next song part · T = tap tempo · Esc = close panels.
Every drag interaction (reordering inserts) also has buttons.
