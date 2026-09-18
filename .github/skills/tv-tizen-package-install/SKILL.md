---
name: tv-tizen-package-install
description: Build apps/tv-tizen, package a signed .wgt with Tizen Studio CLI and install/launch it on the Samsung Odyssey G8 (Tizen 9) over sdb, including certificate profile setup and the exact error strings for manifest vs certificate failures. Use for any tv-tizen change that must be seen on the TV, when "install failed[118,-4]" or "failed to connect to remote target" appears, or when setting up a new PC. Trigger words: tizen, wgt, sdb, Odyssey, package-wgt, setup:cert, Developer Mode, 26101.
---

# Package + install the Tizen TV app

App id `mXa1TvApp0.MixAI` (package `mXa1TvApp0`, `required_version="2.3"`, `viewmodes="fullscreen"`).
TV: Odyssey G8 `192.168.100.135`. Tizen Studio 6.1 CLI: `%USERPROFILE%\tizen-studio\tools\ide\bin\tizen.bat`,
`%USERPROFILE%\tizen-studio\tools\sdb.exe`. Long steps go through hidden `.copilot-tmp\*.cmd`/`.ps1` — the
shared terminal silently drops them.

## One-time setup (new PC)
1. Install CLI: `web-cli_Tizen_Studio_6.1_windows-64.exe --accept-license "<dir>"` — ONE positional path only
   (two paths installs into `tizen-studio-data`), run from a hidden cmd with `< nul` (ends with "Press enter to exit").
2. `package-manager-cli.exe install --accept-license TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools cert-add-on Certificate-Manager` (slow).
3. `pnpm -C apps/tv-tizen setup:cert` → author cert `tizen-studio-data\keystore\author\mixai_author.p12`, profile
   `mixai`; password ONLY in `%USERPROFILE%\tizen-studio-data\mixai-cert.env` (never print it).
   Then `tizen cli-config profiles.path=%USERPROFILE%\tizen-studio-data\profile\profiles.xml` (else `-s mixai` not found).
4. Real TVs need a **Samsung distributor certificate with the TV's DUID** (Certificate Manager → Samsung → TV;
   profile `mixai-samsung`). The default Tizen distributor cert only works on emulators.

## Build + package
5. From `apps/tv-tizen`: `pnpm typecheck; pnpm build` → `dist/` (`index.html` + `index-legacy.js`, CSS inlined,
   SystemJS classic scripts for `file://`).
6. `pnpm package` (= `scripts/package-wgt.ps1 -Profile mixai[-samsung] -TvIp 192.168.100.135 [-Install]`):
   copies `config.xml` + icon into `dist/`, runs `tizen package -t wgt -s <profile> -- dist` → `dist/MixAITV.wgt`
   (signed: `author-signature.xml` + `signature1.xml`). Without Tizen Studio it emits an UNSIGNED zip.

## Install + launch
7. TV: Apps → `12345` on the remote → Developer Mode ON, Host PC IP = this PC → **full power-off/on** (port 26101
   opens only after that). Check `http://192.168.100.135:8001/api/v2/` (developerMode, IP).
8. ```powershell
   $t = "$env:USERPROFILE\tizen-studio\tools"
   & "$t\sdb.exe" connect 192.168.100.135; & "$t\sdb.exe" devices          # note the serial
   & "$t\ide\bin\tizen.bat" install -s <serial> -- E:\gh\mmo\apps\tv-tizen\dist\MixAITV.wgt   # -s, not -t
   & "$t\sdb.exe" shell 0 was_execute mXa1TvApp0.MixAI
   ```
   Real error text when `tizen install` is vague: `sdb push dist\MixAITV.wgt /tmp/` then
   `sdb shell 0 vd_appinstall mXa1TvApp0.MixAI /tmp/MixAITV.wgt`.
9. Quick Connect on the TV sweeps the /24 on 17899 — the local companion must be running with the firewall rules
   `mixai-companion-17899`/`-mdns` (`scripts/firewall-companion.cmd` re-adds them).

## Verify
- `pnpm build` log: tsc clean, vite emits `index-legacy.js` + `polyfills-legacy`; `dist/MixAITV.wgt` exists and
  contains `signature1.xml` (`Expand-Archive` to a temp dir and list).
- `sdb shell 0 app_launcher -l | Select-String mXa1TvApp0` lists the app; `was_execute` brings it on screen.
- Headless smoke without a TV: `.copilot-tmp/tizen-smoke.mjs` pattern (static server with a BACKSLASH root
  path + Playwright `executablePath` to `ms-playwright/chromium-*`).

## Common failures (exact strings)
- `install failed[118,-4] Load archive info fail` → MANIFEST problem (`required_version` too new, package id not
  10-char alnum), NOT the certificate.
- `error: failed to connect to remote target` → Developer Mode off / not power-cycled / wrong Host PC IP.
- Signature errors on a real TV → distributor cert lacks the TV DUID; use the `mixai-samsung` profile.
- `-s mixai` "profile not found" → `tizen cli-config profiles.path=` not set.
- Every file 404 in the e2e static server → root passed with forward slashes; use a backslash path.
- Colours grey/wrong on the TV → Tizen Chromium has no `oklch()`; the `@supports not (color: oklch(0 0 0))`
  sRGB block in `src/styles.css` is stale (skill `tokens-regen` step 3).
