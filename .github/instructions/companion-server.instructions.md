---
applyTo: "server/**"
description: "MMO Server / Companion (Express 5, Electron 44 shell, headless Node 22, better-sqlite3 13, Vite renderer, OpenAPI contract)"
---

# server — MMO Server / Companion

## Architecture
- One core, two entries: Electron shell (`electron .`, `src/main.ts`) and **headless** `node dist/headless.js`
  (ADR-0002). `src/platform/` is the ONLY Electron touchpoint; `SettingsStore` writes `<userData>/config.json`.
  Env for headless: `MMO_PORT` (17899), `MMO_DATA`, `MMO_MEDIA` (first boot only), `MMO_DEVICE_TOKEN`, `MMO_HEADLESS=1`.
- Express 5 on `:17899`. Auth = `x-device-token` (`authMiddleware`); `/rest` (Subsonic, ADR-0005) and
  `/pair/{request,poll,info}` are public. Routers mount under prefixes listed in
  `scripts/openapi-check.mjs` `MOUNTS` — a new router file MUST be added there or the check throws
  `… registers GET /x but has no mount prefix in openapi-check.mjs MOUNTS`.
- Renderer: `server/ui/` (Vite 8 + React 19 on `@mmo/ui`; no own package.json — deps are server devDeps,
  add with `pnpm add -D --ignore-workspace`). `pnpm ui:build` → `ui/dist` (gitignored), loaded by main.ts.
- Media brain (tracker §10, WP10): `server/src/media/` owns TMDB/MOTN clients, SQLite cache, recs, progress.
  See `media-home.instructions.md`.
- Casting: `server/src/cast/` (DLNA SSDP/SOAP dependency-free + Home Assistant bridge) under `/cast/*`.

## Rules
- **Contract chain**: route change → `server/openapi.yaml` → `pnpm openapi:check` → `pnpm openapi:gen`
  (Kotlin `Models.kt` + `packages/sdk/src/generated/mmo-server.d.ts`). Commit spec + generated files together.
  Skill `openapi-change`.
- Node 22 for everything in `server/` (native ABI: better-sqlite3 13 N-API prebuilds serve Electron 44 + Node 22).
- Express 5 idioms: no `:id(\\d+)` regex → `router.param` guard; `/x/*` → `/x/*name` and the param is an
  ARRAY (`splatParam()` joins it); `req.body` is `undefined` without a parsed body (middleware restores `{}`).
  Type guards as `RequestHandler<Record<string,string>>` or `req.params.x` widens to `string | string[]`.
- ESM-only deps (`music-metadata` 11, `chokidar` 5) in this CJS tsc build go through `src/lib/esm-import.ts`.
- **ffmpeg/ffprobe only inside explicit jobs** (3.2.0). Nothing at boot and no read endpoint may spawn them:
  `POST /video/scan` answers from `library/video-registry.ts` and enqueues a `ScanJob` for cold roots;
  `runVideoScanJob` is the only bulk prober and the only place that may `enqueuePreRemux`
  (`preRemuxAutoOnScan` default OFF). Transcode = HLS session on demand, pre-remux = single-flight queue.
  Verify: `Get-CimInstance Win32_Process | ? Name -match '^ff(mpeg|probe)'` must be empty after boot + `/video/scan`.
- Versioning: bump `server/package.json` + `server/CHANGELOG.md` on user-visible change; release tags
  `companion-v*` (Electron installers) and `server-v*` (Docker image, `mmo-server-docker.yml`, context `server/`).
- Docker: Dockerfile pins pnpm 10.0.0 via corepack; copy `.npmrc`; never set `npm_config_build_from_source`
  (arm64 prebuilds exist; compiling under QEMU costs 15 min). **Never build on the Raspberry Pi** — skill `pi-deploy`.

## Commands (from `server/`)
- `pnpm build:headless` (tsc only, fast) · `pnpm build` (`ui:build` + tsc) · `pnpm ui:typecheck` ·
  `pnpm test` (vitest) · `pnpm start:headless` · `pnpm openapi:check|lint|gen|preview` ·
  `pnpm dist:win` (electron-builder). Local headless runner: `scripts/run-companion-local.ps1 [-Stop]` at repo root.

## Gotchas (exact strings)
- `pnpm install` → `EPERM … better_sqlite3.node` = the headless companion holds the file → `run-companion-local.ps1 -Stop` first.
- `Could not detect abi for version 44.4.2` → keep `pnpm.overrides.node-abi ^4.35`.
- `Cannot find package 'peek-readable'` at runtime → stale nested `file-type/node_modules/strtok3` after an
  aborted install; `rm node_modules` + frozen reinstall.
- `ERR_PNPM_IGNORED_BUILDS` fatal in Docker → pnpm newer than 10.0.0; keep the corepack pin.
- Tests: `vi.mock("../store")` (store touches userData at import); Subsonic tests need
  `__setSubsonicDbForTests(sqlite)`. `fnm exec --using=22 pnpm` fails ("pnpm not found") → put Node 22 on PATH,
  run `node node_modules/vitest/vitest.mjs run <dir>`.
- mDNS on Windows announced the WSL bridge IP → `new Bonjour({interface: pickLanAddress()})` + LAN A-record
  filter in `lan-announce.ts`. Don't revert.
- electron-builder via `Start-Process pnpm` produced zero output → run
  `node node_modules/electron-builder/out/cli/cli.js --dir --win --x64` through hidden `cmd.exe /c "… > log 2>&1"`.

## Verify
- Hidden process (`.copilot-tmp/companion-verify.ps1`): `pnpm build:headless`, `pnpm ui:typecheck`, `pnpm ui:build`,
  `pnpm test`, `pnpm openapi:check`; read the log, quote exit codes. Skill `companion-verify`.
- Runtime: start headless, `curl.exe http://127.0.0.1:17899/pair/info` → 200 JSON.
