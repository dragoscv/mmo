# MixAI Music — desktop (Windows, macOS, Linux)

Tauri 2 shell (`ro.mixai.music.desktop`) around the MixAI Music web UI on **music.mixai.ro** — a desktop app with native
media controls, not a copy of the web code. Tracker: `docs/mixai-design-tracker.md` WP17-43 (decisions D55, D56).

## How it works

- `web/index.html` + `web/launcher.mjs` (local launcher): checks that music.mixai.ro is reachable (offline screen with
  back-off retry otherwise), then either continues to the web UI or signs in. Sign-in runs in the **system browser**
  (Google blocks OAuth in embedded webviews): `desktop_auth` opens `/api/companion-auth`, a loopback-only listener gets
  the device token, the launcher exchanges it at `/api/auth/desktop-bootstrap` for a web session cookie. Same flow as
  MixAI Studio (`apps/native`). The web login page shows "Sign in with your browser" inside the shell
  (`desktop_open_signin`, capability `login-web`).
- The web player (`apps/web/src/lib/mmo/desktop-bridge.ts`) pushes its state through `desktop_media_update`
  (capability `music-web`, music.mixai.ro only). Rust (`src/media.rs`) mirrors it to the OS media controls via
  [souvlaki](https://crates.io/crates/souvlaki): Windows SMTC, macOS Now Playing, Linux MPRIS. Media keys, the OS
  overlay, the tray menu, the mini player and global shortcuts call back into the page
  (`window.__mixaiDesktop.command`, fixed command set, numbers only).
- Tray / menu-bar icon: open, play/pause, next, previous, mini player, quit. Closing the window while music plays
  keeps playing in the tray.
- Mini player (`web/mini.html`): 360×112 always-on-top window with cover, title, progress and transport.
- Global shortcuts: **Ctrl+Alt+Space** play/pause, **Ctrl+Alt+→ / ←** next / previous, **Ctrl+Alt+M** mini player
  (a combination another app owns is skipped).
- `mixai-music://` links (canonical set shared with Android and iOS, `src/links.rs`) open the matching page, also
  while the app runs (single instance): `album/<id>`, `artist/<id>`, `now-playing` / `nowplaying`, `search?q=`,
  `downloads`, `mix`, `play?ids=a,b&index=n`, `play?q=`.
- Window size and position are remembered (window-state plugin).

## Commands

| Command | What |
|---|---|
| `pnpm install` | own lockfile + `pnpm-workspace.yaml` (repo convention) |
| `pnpm tauri:icon` | `src-tauri/icons` from the MixAI Music app icon (gitignored) |
| `pnpm test:launcher` | launcher unit tests (node --test) |
| `cargo test` / `cargo clippy -- -D warnings` in `src-tauri` | Rust unit tests (links, commands, i18n, auth) |
| `pnpm tauri dev` | dev window against `http://localhost:13789` (or `MMO_WEB_APP_URL`) |
| `pnpm tauri build --no-bundle` | release exe `src-tauri/target/release/mixai-music.exe` |
| `pnpm msix` (`scripts/package-msix.ps1 [-TestSign]`) | Microsoft Store MSIX in `msix-out/` (declares the `mixai-music` protocol) |
| `scripts/macos-appstore.ps1 -Mode build\|upload\|dmg` | Mac App Store `.pkg` / Developer ID DMG on vmui-mac |
| `scripts/linux/build.sh`, `scripts/linux/flatpak-sources.sh` | AppImage + .deb; Flathub `cargo-sources.json` |

Builds go through `run-build.ps1` on this machine.

## Stores

- **Microsoft Store** `9PC31TGKW4FP`, identity `DragosCatalin.MixAIMusic`, publisher
  `CN=FE8B5839-E0F9-495F-854C-53165710EB07`, PFN `DragosCatalin.MixAIMusic_2n7wyqrzmk6fw`. Upload the unsigned MSIX.
- **Mac App Store**: bundle id `ro.mixai.music.desktop` (separate record from the iPhone app), sandbox +
  `network.client` only.
- **Flathub**: `flatpak/ro.mixai.music.desktop.yml` (offline cargo build from tag `music-desktop-v<version>`; the UI
  is remote, so no node sources), MPRIS name `org.mpris.MediaPlayer2.ro.mixai.music.desktop`.

Keep `@tauri-apps/cli` on the same minor as the `tauri` crate.
