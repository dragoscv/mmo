# MixAI TV — desktop (Windows, macOS, Linux)

Tauri 2 shell (`ro.mixai.tv.desktop`) around the shared TV web UI in [`apps/tv-tizen/src`](../tv-tizen/src) — one
codebase for Samsung Tizen, LG webOS and desktop (ADR-0013 D46). Tracker: `docs/mixai-design-tracker.md` WP17-25..27.

## How it works

- `src/main.ts` routes every cross-origin `fetch` through `@tauri-apps/plugin-http` (Rust client), then imports the
  shared UI. LAN MixAI Servers on plain `http://192.168.x.x:17899` work from the secure app origin without CORS.
- `apps/tv-tizen/src/platform` reports `desktop`: device label from the OS + host name, LAN IPv4 for the /24 server
  sweep (Rust `platform_info`), window close for Exit, pointer support (hover focuses, wheel moves focus).
- HLS uses hls.js `FetchLoader` on desktop, so playlists and segments use the same native transport.

## Commands

| Command | What |
|---|---|
| `pnpm install --ignore-workspace` | own lockfile (repo convention) |
| `pnpm typecheck` | TS for the entry + the shared UI graph |
| `pnpm tauri icon ../web/public/icon-512.png` | generate `src-tauri/icons` (gitignored) |
| `pnpm tauri dev` | dev window on Vite :13795 |
| `pnpm tauri build --no-bundle` | release exe `src-tauri/target/release/mixai-tv.exe` |
| `pnpm msix` (`scripts/package-msix.ps1 [-TestSign]`) | Microsoft Store MSIX in `msix-out/` |

Builds go through `run-build.ps1` (heavy lane) on this machine.

## Microsoft Store

Reserved product **MixAI TV** `9P3WGV62ZRN5`; identity `DragosCatalin.MixAITV`, publisher
`CN=FE8B5839-E0F9-495F-854C-53165710EB07` (defaults of `package-msix.ps1`). Upload the unsigned MSIX (the Store
signs it); `-TestSign` only for local sideload tests. Capabilities: `internetClient`, `privateNetworkClientServer`,
`runFullTrust`.

Keep `@tauri-apps/api` / `@tauri-apps/plugin-http` on the same minor as the `tauri` / `tauri-plugin-http` crates
(`tauri build` refuses mismatches).
