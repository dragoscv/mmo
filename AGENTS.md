# MixAI monorepo — agent guide

Read this first. Per-area rules: `.github/instructions/*.instructions.md` (auto-applied by path).
Procedures: `.github/skills/*/SKILL.md`. Next.js-specific generated rules: `apps/web/AGENTS.md`.
Windows 11 + PowerShell; write `;` not `&&`, `$env:X=` not `export`, search with `rg`.

## What this repo is

MixAI (ex "MMO — Multi Media Organizer"): self-hosted **MMO Server** + apps for music/video.
Docs: `README.md`, `docs/design-system.md`, `docs/adr/`, `docs/mixai-design-tracker.md`.

| Surface | Path | Stack | Dev port / entry |
|---|---|---|---|
| Web (PWA) | `apps/web` | Next 16 Turbopack, React 19.3, Drizzle+Postgres, next-intl RO/EN | `pnpm dev` → 13789 |
| MMO Server / Companion | `server` | Express 5, better-sqlite3 13, Electron 44 shell + headless Node 22 | `:17899` (`node dist/headless.js`) |
| Companion renderer | `server/ui` | Vite 8 + React 19 on `@mmo/ui` | `pnpm ui:build` → `ui/dist` |
| MixAI DJ | `apps/mixai` | Tauri 2.11 + Vite 8 + Rust audio (cpal/symphonia) | vite 14420 |
| Native shell | `apps/native` | Tauri 2 + Capacitor 8 (Android) | `pnpm cap:sync` |
| TV Tizen | `apps/tv-tizen` | Vite 8 + plugin-legacy (SystemJS, file://) | vite 13791 |
| TV Android | `apps/tv-android` | Compose TV, Media3, AGP 9.4, compileSdk 37 | Gradle |
| Extension | `apps/extension` | vanilla MV3, `_locales/{en,ro}` | — |
| Gateway | `apps/gateway` | Hono 4, tsup → Cloud Run | `PORT` default 8080 |
| Packages | `packages/{design-tokens,ui,sdk,db,ai,ai-mcp,audio-gen}` | consumed via tsconfig `paths`, not `workspace:*` | — |

## Golden commands

Root: `pnpm tokens:build`, `pnpm typecheck|lint|test|build` (recursive, `--no-bail`), `pnpm test:ui`.
Builds go through the serialised wrapper (one build per repo; bare `pnpm build` is refused by a hook):

```powershell
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'pnpm --filter music-organizer build'
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Status
```
`run-build.ps1` always runs at repo root → use `--filter <pkg name>` or `pnpm -C <dir>`.

| Surface | typecheck | test | build |
|---|---|---|---|
| web | `pnpm -C apps/web typecheck` | `pnpm -C apps/web test` (`e2e` = Playwright) | `pnpm --filter music-organizer build` (Turbopack + `serwist build`; `build:webpack` fallback) — lint = `node scripts/lint-baseline.mjs check` (~3 min) |
| server | `pnpm -C server build:headless` (tsc) · `ui:typecheck` | `pnpm -C server test` | `pnpm -C server build`; `openapi:check|lint|gen` |
| mixai / tv-tizen | `pnpm -C apps/<x> typecheck` | — | `pnpm -C apps/<x> build`; tizen `pnpm package` |
| native | — | — | `pnpm -C apps/native build` then `cap:sync` / `tauri:build` |
| tv-android | Gradle | — | `.\gradlew.bat assembleDebug [-PmixaiOrigin=…]` (hidden process, see instructions) |
| packages/* | `pnpm -C packages/<x> typecheck` | `pnpm -C packages/<x> test` | design-tokens `build` |

Node 22 for server (native ABI). Long commands: never in the shared terminal — see etiquette.

## Dependencies — per-app lockfiles

`.npmrc` has `shared-workspace-lockfile=false`: every app/package keeps its own `pnpm-lock.yaml`.
Add deps **inside the app** with `pnpm add --ignore-workspace <pkg>` (root install is broken by the
extension store entry). CI installs with `--frozen-lockfile --ignore-workspace`. Always latest stable;
known blocks: web on TS 5.9 + ESLint 9 (typescript-eslint/eslint-plugin-react peers), tauri stays 2.x.

## Hard invariants

- **Tokens single source**: `packages/design-tokens/src/tokens.ts`. Hand-typed hex / `Color(0xFF…)` in app
  code is a bug. `pnpm tokens:build` regenerates `dist/*` **and** the mirrors listed in `src/build.ts`
  (tv-android `Tokens.kt`, tizen/extension/native `tokens.css`, web + tizen `prehydrate.js`). Commit them;
  `web-ci` diff-checks. Tizen also needs the `@supports not (color: oklch(0 0 0))` sRGB block re-copied.
- **Base UI, not Radix** (`@base-ui/react`, ADR-0008): `render={…}` not `asChild`, `data-open`/`data-checked`
  not `data-state`, `onOpenChange(open, details)`.
- **Theme prefs**: one blob `localStorage["mixai:prefs:v1"]` → `data-mode/accent/surface/density/radius/motion`
  + `lang` on `<html>`; `prehydrate.js` in `<head>` on every web surface; `<ThemeProvider>` from `@mmo/ui`.
- **API contract chain**: `server/openapi.yaml` ↔ Express routes (`server/scripts/openapi-check.mjs`, MOUNTS
  table per router file) ↔ `apps/tv-android/.../data/generated/Models.kt` ↔ `packages/sdk/src/generated`.
  New route → spec → `pnpm -C server openapi:check` → `openapi:gen`.
- **Migrations**: schema change in `apps/web/src/db/` needs a new `apps/web/drizzle/NNNN_*.sql` **and** a
  `drizzle/meta/_journal.json` entry (husky `check-migrations.mjs`). The runner reads the dir, not the journal.
- **`apps/web/.env.local` `DATABASE_URL` is PRODUCTION** (GCP Cloud SQL). `pnpm db:migrate` is a prod
  migration. Use `db:status` first; never run migrate "to see".
- **Never build on the Raspberry Pi.** Build arm64 locally (buildx+QEMU), ship the tar (`scripts/deploy-mmo-server-pi.ps1`).
- Version bumps: `apps/web/package.json` and `apps/extension/{package,manifest}.json` must bump when files
  under them are staged (husky). Tag prefixes: `companion-v*`, `server-v*`, `extension-v*`, `native-v*`, `tv-v*`.

## Gates (what runs where)

| Gate | Local (husky pre-commit) | CI today | Planned (WP13-04/05) |
|---|---|---|---|
| web version bump | `apps/web/scripts/check-version.mjs --staged` | — | lint-staged |
| extension version bump | `apps/extension/scripts/check-version.mjs --staged` | `extension-ci` (+manifest MV3, vendor polyfill drift) | commitlint |
| migrations `.sql`+journal | `apps/web/scripts/check-migrations.mjs --staged` | — | — |
| web lint/typecheck/test/build | manual | `web-ci` (`lint:check`, `typecheck`, `test`, `build`) | + bundle budget, LHCI, axe, knip |
| tokens committed | manual `pnpm tokens:build` | `web-ci` packages job (`git diff --exit-code -- dist ../../apps`) | lint-staged |
| OpenAPI drift | manual `pnpm -C server openapi:check` | — | `server-ci.yml`, lint-staged |
| i18n parity, hex gate, tracker csv | — | — | `apps/web/scripts/i18n-parity.mjs`, `scripts/hex-gate.mjs` (WP13-03) |
| server build/test | manual | only `mmo-server-docker` on tag | `server-ci.yml` |

## Shared-clone etiquette

Several agents work in this clone at once. The default pwsh terminal is shared: commands get
interleaved, killed by foreign Ctrl+C, or silently dropped.
- Verification pattern: write `.copilot-tmp/<name>.ps1`, run
  `Start-Process pwsh -ArgumentList '-NoProfile','-File','<x>.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput <log>`,
  then read the log. Gradle: `java -cp gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain`.
- `git --no-pager diff` / `--stat` (a pager hangs the terminal). Stage explicit paths only — never
  `git add -A`/`.`/`commit -a`. Never `stash`, `checkout --`, `restore`, `reset --hard`, `clean`.
- Prove "pre-existing": `git worktree add .copilot-tmp/wt-head HEAD`, junction `node_modules`, run the
  same test there, `git worktree remove` — see skill `pre-existing-proof`.
- Scratch goes in `.copilot-tmp/` (gitignored). Never commit it.

## Docs map

`docs/design-system.md` (spec) · `docs/adr/` (0002 headless, 0004 API, 0005 Subsonic, 0006 codai, 0008 design
system) · `docs/mixai-design-tracker.md` = canonical tracker; regenerate the CSV with
`node scripts/tracker-regen-csv.mjs` in the same commit · `docs/arhitectura/build-performance.md` (measured
build times) · `server/README.md` (Docker/Pi) · `apps/tv-android/README.md`, `apps/tv-tizen/README.md`.
