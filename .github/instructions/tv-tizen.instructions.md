---
applyTo: "apps/tv-tizen/**"
description: "MixAI TV for Samsung Tizen (Vite 8 + plugin-legacy, React 19, file:// widget): build, sRGB fallback, packaging/signing, sdb install"
---

# apps/tv-tizen — Tizen web widget (`mXa1TvApp0.MixAI`)

## Rules
- Standalone Vite 8 + React 19 app, NO imports from `apps/web`. Consumes `@mmo/ui`/tokens via tsconfig paths.
- Runs from `file://` in Tizen Chromium, which refuses `<script type="module">` → `@vitejs/plugin-legacy`
  with `renderModernChunks:false, polyfills:false, targets:["chrome >= 76"]` (classic SystemJS scripts; don't
  set `build.target`, the plugin owns it). CSS is inlined into `index-legacy.js`.
- Tizen Chromium predates `oklch()` → `src/styles.css` ends with an `@supports not (color: oklch(0 0 0))` sRGB
  block. It is hand-mirrored from `Tokens.kt` values — re-copy after every token change (not generated).
- `src/tokens.css` and `public/prehydrate.js` are GENERATED mirrors (`pnpm tokens:build`); never edit.
- Prefs: locale lives in the shared `mixai:prefs:v1` blob (`.locale`); `src/i18n/messages.ts` `t()`/`setLocale`,
  App re-keys on the `mixai:locale` CustomEvent. Resume progress key `mixai-tv:progress` (server-synced in WP12-02).
- Quick Connect: no mDNS on Tizen web → `lib/discovery.ts` sweeps the /24 on `17899` (`/pair/info`, 400 ms × 32);
  dev override `?scanHosts=` / `localStorage["mixai.scanHosts"]`. Sign-in origin `localStorage["mixai.origin"]`.
- `config.xml` facts that make install work on Tizen 9 (Odyssey G8): `required_version="2.3"`, package id
  10-char alnum `mXa1TvApp0`, `viewmodes="fullscreen"`, `<feature name="http://tizen.org/feature/screen.size.all"/>`.
  Media Home deep links (WP12-02) additionally need the `application.launch` privilege.
- Vite 8 (rolldown): `manualChunks` OBJECT form is rejected (TS2769) → function form or
  `build.rolldownOptions.output.codeSplitting.groups`.
- Release tag `tv-v*` (shared with Android). Version in `package.json` + `config.xml`.

## Commands (from `apps/tv-tizen`)
- `pnpm dev` (13791) · `pnpm typecheck` · `pnpm build` (tsc + vite → `dist/`) ·
  `pnpm package` (`scripts/package-wgt.ps1 [-Profile mixai] [-TvIp 192.168.100.135] [-Install]`) ·
  `pnpm setup:cert` (`scripts/setup-tizen-cert.ps1`, idempotent, password stored ONLY in
  `%USERPROFILE%\tizen-studio-data\mixai-cert.env`).
- Tizen Studio 6.1 CLI at `%USERPROFILE%\tizen-studio\tools` (`tizen`, `sdb`). Skill `tv-tizen-package-install`.

## Install on the Odyssey G8 (192.168.100.135)
1. TV Developer Mode on; port 26101 opens only after a FULL power-off/on. `http://<ip>:8001/api/v2/` shows
   developerMode + IP.
2. `sdb connect 192.168.100.135; sdb devices` → serial.
3. `tizen install -s <serial> -n MixAITV.wgt -- <abs path to dist>` (`-s` not `-t`; `-n` file name + `--` directory, else `Option "-n (--name)" is required`).
4. Launch `sdb shell 0 was_execute <appid>`; real install error text via
   `sdb push <wgt> /tmp/ && sdb shell 0 vd_appinstall <appid> /tmp/<wgt>`.

## Gotchas (exact strings)
- `install failed[118,-4] Load archive info fail` → MANIFEST, not cert: wrong `required_version` or package id.
- `error: failed to connect to remote target` → Developer Mode off or TV not fully power-cycled.
- Samsung distributor cert with the TV's DUID is REQUIRED (profile `mixai-samsung`); the default Tizen
  distributor cert only sideloads on emulators. `tizen cli-config profiles.path=…profiles.xml` else `-s mixai` not found.
- Tizen Studio installer: pass ONE dir to `--accept-license` and run `< nul` (it ends with "Press enter to exit").
- E2E static server: root path must be a BACKSLASH Windows path or every file 404s (`startsWith(root)` check).
- The integrated browser tool resolves `localhost` on the CLIENT machine → use host-side node + Playwright.

## Verify
- `pnpm typecheck; pnpm build` → `dist/index.html` + `index-legacy.js`, no `.css` asset expected.
- `pnpm package` prints the signed `.wgt` path; `sdb shell 0 was_execute mXa1TvApp0.MixAI` shows the app on screen.
- Smoke: `.copilot-tmp/tizen-smoke.mjs` pattern (static server + Playwright with `executablePath`).
