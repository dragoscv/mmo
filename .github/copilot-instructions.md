# MixAI — Copilot instructions

Full guide: [`AGENTS.md`](../AGENTS.md). Path-scoped rules live in `.github/instructions/`, procedures in
`.github/skills/`. Next.js generated rules: `apps/web/AGENTS.md`.

## Repo shape
- `apps/web` Next 16 (Turbopack, dev 13789) · `server` MMO Server/Companion (Express 5, Node 22, :17899,
  Electron shell + `dist/headless.js`) · `server/ui` Vite renderer · `apps/mixai` Tauri DJ · `apps/native`
  Tauri+Capacitor · `apps/tv-tizen`, `apps/tv-android` · `apps/extension` MV3 · `apps/gateway` Hono ·
  `packages/{design-tokens,ui,sdk,db,ai,…}` via tsconfig `paths`.
- Per-app lockfiles (`shared-workspace-lockfile=false`): `pnpm add --ignore-workspace` **inside** the app.

## Commands
- Typecheck/test: `pnpm -C <dir> typecheck` / `test`. Tokens: `pnpm tokens:build` (root).
- Builds only via `pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'pnpm --filter music-organizer build'`.
- Web lint: `node scripts/lint-baseline.mjs check` in `apps/web`. Server API: `pnpm -C server openapi:check`.
- Long commands: hidden `Start-Process pwsh -File .copilot-tmp/x.ps1 -RedirectStandardOutput log -Wait`, then read the log.
  The shared terminal drops/kills commands. `git --no-pager`.

## Invariants
- Colours/radii/motion only from `packages/design-tokens`; regenerate mirrors with `pnpm tokens:build` and commit.
- `@mmo/ui` is **Base UI** (`render` prop, `data-open`), never Radix. Dedupe `react`/`react-dom`/`motion`/
  `@base-ui/react` per app or hooks die with `Cannot read properties of null (reading 'useState')`.
- Theme prefs blob `mixai:prefs:v1`; `prehydrate.js` in `<head>`; `data-*` attributes on `<html>`.
- `server/openapi.yaml` ↔ routes ↔ `Models.kt` ↔ `packages/sdk` — regenerate with `openapi:gen`.
- DB schema change ⇒ `apps/web/drizzle/NNNN_*.sql` + `_journal.json`. `apps/web/.env.local` is **PRODUCTION**;
  `pnpm db:migrate` migrates prod — check `db:status` and ask first.
- Bump `apps/web/package.json` / extension `package.json`+`manifest.json` when touching those apps (husky).
- Never build on the Raspberry Pi; ship arm64 images from here (`scripts/deploy-mmo-server-pi.ps1`).
- Tracker `docs/mixai-design-tracker.md` is canonical; run `node scripts/tracker-regen-csv.mjs` in the same commit.

## Shared clone
Stage explicit paths only; no `git add -A`, `stash`, `checkout --`, `reset --hard`. Scratch in `.copilot-tmp/`.
Prove pre-existing failures with a HEAD worktree (skill `pre-existing-proof`).

## Style
Terse, imperative, EN docs (RO business terms fine). LF endings. No secrets in output or commits.
