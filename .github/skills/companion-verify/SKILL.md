---
name: companion-verify
description: Verify the MMO Server / Companion (server/) end to end — headless tsc build, renderer typecheck + Vite build, vitest on Node 22, OpenAPI drift check, optional electron-builder --dir and a live headless smoke on :17899. Use before committing under server/, after dependency upgrades (Electron, better-sqlite3, Express), or when a pairing/TV client reports 401/404. Trigger words: companion verify, server build, build:headless, ui:build, openapi:check, headless smoke, 17899.
---

# Verify server/ (MMO Server + Companion)

Node 22 is mandatory (native ABI). Everything runs from a hidden process — vitest/tsc in the shared terminal
get killed or print only `RUN`.

## Procedure
1. Free the native module if a local companion is running (else `pnpm install` → `EPERM … better_sqlite3.node`):
   ```powershell
   pwsh -NoProfile -File E:\gh\mmo\scripts\run-companion-local.ps1 -Stop
   ```
2. Write `.copilot-tmp/companion-verify.ps1`:
   ```powershell
   $ErrorActionPreference = 'Continue'
   Set-Location E:\gh\mmo\server
   "== node"; node -v
   "== tsc";       pnpm build:headless;  "TSC_EXIT=$LASTEXITCODE"
   "== ui tsc";    pnpm ui:typecheck;    "UITSC_EXIT=$LASTEXITCODE"
   "== ui build";  pnpm ui:build;        "UIBUILD_EXIT=$LASTEXITCODE"
   "== vitest";    node node_modules/vitest/vitest.mjs run; "VITEST_EXIT=$LASTEXITCODE"
   "== openapi";   pnpm openapi:check;   "OPENAPI_EXIT=$LASTEXITCODE"
   "DONE"
   ```
   Run: `Start-Process pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','E:\gh\mmo\.copilot-tmp\companion-verify.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput E:\gh\mmo\.copilot-tmp\companion-verify.log`,
   then `Select-String -Path .copilot-tmp/companion-verify.log -Pattern '_EXIT=|error TS|Test Files|Tests |drift|missing'`.
   `node -v` must print `v22.x`; if not, put the Node 22 dir on PATH inside the script (`fnm exec --using=22 pnpm`
   fails with "pnpm not found").
3. Live headless smoke:
   ```powershell
   pwsh -NoProfile -File E:\gh\mmo\scripts\run-companion-local.ps1 -Media 'D:\Movies,D:\TV Shows'
   curl.exe -s http://127.0.0.1:17899/pair/info
   ```
   Expect 200 JSON. Authenticated routes need `x-device-token` from `<data>/config.json` (`deviceToken`); the pid
   and logs are in `.copilot-tmp/companion-local.*`. `MMO_MEDIA` applies only on first boot of an empty data dir.
4. Packaging check when Electron/electron-builder/native deps changed (≈ 2.5 min, hidden `cmd.exe`):
   ```powershell
   cmd.exe /c "node node_modules\electron-builder\out\cli\cli.js --dir --win --x64 > ..\.copilot-tmp\eb.log 2>&1"
   node node_modules/@electron/asar/bin/asar.js list dist\win-unpacked\resources\app.asar | Select-String 'ui/dist' | Select-Object -First 3
   ```
   (`Start-Process pnpm dist:win -RedirectStandardOutput` produced zero output on this machine.)
5. If `openapi:check` reports drift → skill `openapi-change`. If a route was added, `pnpm openapi:gen` and stage
   `openapi.yaml`, `apps/tv-android/.../data/generated/Models.kt`, `packages/sdk/src/generated/mmo-server.d.ts`.
6. Bump `server/package.json` + `server/CHANGELOG.md` for user-visible changes (skill `release-bump`).

## Verify (report)
- All `*_EXIT=0` quoted from the log; vitest summary line; `pair/info` body.
- `git --no-pager status --short server packages/sdk apps/tv-android` shows only intended files.

## Common failures
- `Could not detect abi for version 44.4.2` → `pnpm.overrides.node-abi ^4.35` missing.
- `Cannot find package 'peek-readable'` → stale nested `file-type/node_modules/strtok3`; remove `node_modules`,
  `pnpm install --frozen-lockfile --ignore-workspace`.
- `no such column` in Subsonic tests → seed AFTER the server bootstrap creates the schema;
  `__setSubsonicDbForTests(sqlite)` + `vi.mock("../store")`.
- `… registers GET /x but has no mount prefix in openapi-check.mjs MOUNTS` → add the new router file to `MOUNTS`.
- TS7016 across `packages/ui` from `ui:typecheck` → `server/ui/tsconfig.json` must map `react` to
  `../node_modules/@types/react`.
- Port 17899 already bound → an older headless instance; `run-companion-local.ps1 -Stop` or
  `Get-NetTCPConnection -LocalPort 17899`.
