---
applyTo: "apps/native/**, apps/mixai/src-tauri/**, **/*.rs, **/Cargo.toml"
description: "Tauri 2 (mixai DJ + native shell), Capacitor 8 Android, Rust audio crates: pinned versions, verify via hidden cargo/tauri"
---

# Native surfaces — Tauri 2 / Capacitor 8 / Rust

## Scope
- `apps/mixai` — MixAI DJ desktop: Tauri 2.11 + Vite 8 (port 14420, HMR 14421) + Rust crate `src-tauri/crates/mixai-core`
  (cpal, symphonia, rusqlite; `companion.rs` uses reqwest `.query()`).
- `apps/native` — thin shell: Tauri 2 (`src-tauri/`) + Capacitor 8 Android (`android/`, appId `ro.mixai.app`,
  `webDir: dist`). `web/` is vanilla HTML using `tokens.css` (generated mirror).
- `server/native/rbexport` — Rust CLI (`pnpm -C server build:rbexport`).

## Rules
- **Tauri stays on the 2.x line** (tauri 3 is alpha only). `@tauri-apps/cli` 2.11+.
- Pinned Rust deps with a reason — do not "upgrade to latest" blindly: `cpal` 0.15.3 (0.16 changes
  `SampleRate` to u32, 0.18 takes `StreamConfig` by value), `symphonia` 0.5.5 (0.6 reworks `AudioBufferRef`).
  `reqwest` 0.13: feature `rustls` (was `rustls-tls`), `query`/`form` are opt-in features. `rusqlite` 0.40 OK.
- Capacitor 8: min/compile/target SDK 24/36/36, AGP 8.13, Gradle 8.14.3, `density` in `configChanges`.
  `pnpm exec cap sync android` works WITHOUT an Android SDK (copy + config only). `android/` scaffold IS tracked;
  only build output and files `cap sync` regenerates are ignored — keep `AndroidManifest.xml` edits in git.
- Frontend rules from `design-system` / `base-ui` apply to `apps/mixai/src` and `apps/native/web`: tokens,
  `@mmo/ui`, `prehydrate.js` in `<head>`, `<ThemeProvider>` (`mixai:prefs:v1`); mixai's zustand `ui-store`
  keeps only `deckCount`; legacy `theme` skin → `surface`.
- Vite config for a Tauri frontend: `base: "./"` (file:// / tauri:// safe), `resolve.dedupe` for react,
  react-dom, motion, @base-ui/react, lucide-react; alias `@mmo/ui/styles.css` BEFORE `@mmo/ui`.
  Code-splitting in Vite 8: `build.rolldownOptions.output.codeSplitting.groups` (manualChunks deprecated).
- TS 7 in mixai: `baseUrl` was REMOVED (TS5102) → paths relative to tsconfig; delete `baseUrl`.
- Labels default to RO (`Setări`, `Luminos`, `Plat`) — tests/regexes must match RO.
- Release tags: `native-v*` (`native-release.yml`, matrix `pnpm tauri:build --target <rust_target>`).
  Version in `package.json` + `src-tauri/tauri.conf.json` + `Cargo.toml`.

## Commands
- mixai: `pnpm -C apps/mixai typecheck`, `build` (tsc + vite), `tauri:dev`, `tauri:build`, `tauri:icon`.
- native: `pnpm -C apps/native build` (= `scripts/build-web.mjs`), `cap:sync`, `cap:open:android`,
  `android:build:debug`, `tauri:build`.
- Rust: `cargo check --manifest-path apps/mixai/src-tauri/Cargo.toml` (and `apps/native/src-tauri`,
  `server/native/rbexport`) — hidden `Start-Process`, cargo output is long.

## Gotchas
- `Cannot read properties of null (reading 'useState')` → missing dedupe/alias (see base-ui rule).
- Smoke via Playwright needs the newest `ms-playwright/chromium-*/chrome-win64/chrome.exe` (NOT `chrome-win`).
- Read computed styles only after `--dur-base` (220 ms) elapses, or you read pre-transition values.
- Files consumed by Linux build hosts (shell scripts, CI YAML) must be LF, no BOM: `bad interpreter: /bin/bash^M`.
- Cargo builds in the shared terminal get killed → log to `.copilot-tmp/*.log` from a hidden process.

## Verify
- `pnpm -C apps/mixai typecheck` + `build`; `cargo check` exit 0 in the log; for a release-shaped check
  `pnpm -C apps/mixai tauri:build` (slow — state expected duration).
- native: `pnpm -C apps/native build; pnpm -C apps/native exec cap sync android` exit 0;
  `git --no-pager status --short apps/native/android` shows only intended manifest/gradle edits.
