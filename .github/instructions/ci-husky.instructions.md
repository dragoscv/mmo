---
applyTo: ".github/workflows/**, .husky/**, scripts/**, apps/*/scripts/**"
description: "Gates: husky pre-commit checks, GitHub Actions workflows, repo scripts — what exists, what is planned (WP13), how to mutation-test a gate"
---

# CI, husky and scripts

## What runs today
**Husky `.husky/pre-commit`** (root `pnpm dev:setup` installs it via `scripts/prepare-husky.cjs`):
1. `node apps/extension/scripts/check-version.mjs --staged` — staged `apps/extension/**` ⇒ bump BOTH
   `manifest.json` + `package.json`.
2. `node apps/web/scripts/check-version.mjs --staged` — staged `apps/web/**` ⇒ bump `apps/web/package.json`.
3. `node apps/web/scripts/check-migrations.mjs --staged` — staged `apps/web/src/db/**` ⇒ new `drizzle/NNNN_*.sql`
   + `drizzle/meta/_journal.json` change.
All three accept `--base=<ref>` for CI mode (diff vs `origin/main`).

**Workflows** (`.github/workflows/`):
| File | Trigger | Does |
|---|---|---|
| `web-ci.yml` | push/PR on `apps/web/**`, `packages/**` | packages matrix (design-tokens, ui): install `--frozen-lockfile --ignore-workspace`, typecheck, test, tokens `pnpm build` + `git diff --exit-code -- dist ../../apps`; web: `lint:check`, `typecheck`, `test`, `build` (Node 22, `SKIP_ENV_VALIDATION=1`) |
| `extension-ci.yml` | `apps/extension/**` | version-bump guard vs base, manifest MV3 check, `vendor:polyfill` drift |
| `companion-release.yml` | tag `companion-v*`, dispatch | electron-builder installers |
| `mmo-server-docker.yml` | tag `server-v*`, dispatch | buildx image, context `server/` |
| `extension-release.yml` | tag `extension-v*` | zip + release |
| `native-release.yml` | tag `native-v*` | `pnpm tauri:build --target <rust_target>` matrix |
| `tv-android-release.yml` | tag `tv-v*` | Gradle release APK |
| `release.yml` | dispatch | Changesets version/publish |
| `yjs-relay-deploy.yml` | `infra/yjs-relay/**` | relay deploy |
Not covered today: server build/test, OpenAPI drift, i18n parity, hex gate, tracker CSV, docs links.

## Planned (tracker §11 WP13 — reference the paths, mark "added in WP13-0x")
- WP13-03 scripts: `apps/web/scripts/i18n-parity.mjs`, `apps/web/scripts/bundle-budget.mjs`, `scripts/hex-gate.mjs`;
  tokens mirror list += mixai/server `prehydrate.js`.
- WP13-04 husky `prepare` + lint-staged path-scoped gates (i18n, tokens, OpenAPI, hex/`Color(0x`, tracker csv,
  version bumps for server/packages) + commitlint (Conventional Commits).
- WP13-05 CI: `server-ci.yml` (build:headless, test, openapi:check), web-ci += bundle budget / LHCI (`pnpm lhci`,
  `lighthouserc.cjs` exists) / axe (`e2e/a11y.spec.ts`) / knip, `docs-ci.yml` (lychee), actionlint, `deps-weekly.yml`.
- WP13-06 mutation-test every gate → `docs/arhitectura/gates.md`.

## Rules for touching gates
- A gate is "done" only after a mutation test: break the invariant → gate goes RED → restore → GREEN. Paste both
  outputs. "Configured" ≠ "fires" ≠ "has an effect".
- Husky steps must be path-scoped (they run on every commit in a shared clone) and finish in seconds; anything
  slower belongs in CI. Use `git diff --cached --name-only`, never `git status` of the whole tree.
- CI installs per app: `pnpm install --frozen-lockfile --ignore-workspace` with `cache-dependency-path` on
  that app's `pnpm-lock.yaml` (root install is broken). Node 22 for server/web jobs.
- Never auto-update lockfiles in CI; never `pnpm install` at repo root.
- Workflow files run on Linux: LF, no BOM (`bad interpreter: /bin/bash^M` otherwise). Validate with actionlint
  (WP13-05) before pushing.
- PowerShell scripts in `scripts/`: `param()` first, `$ErrorActionPreference='Stop'`, no nested same-type quotes,
  validate with `[System.Management.Automation.Language.Parser]::ParseFile`. Scriptblocks built in a loop need
  `.GetNewClosure()`; don't name a parameter `$args`.
- Root `pnpm build` is refused by a user hook — always the serialised wrapper `run-build.ps1` (it runs at repo
  root; pass `pnpm --filter music-organizer build` or `pnpm -C <dir> …`).
- Scripts that mutate prod (`apply-sql-migrations.mjs --prod`, `deploy-mmo-server-pi.ps1`) need explicit user
  approval; never wire them into a hook.

## Gotchas
- `Get-ChildItem -Recurse -Include x -Exclude y`: `-Exclude` is IGNORED; use `rg --files`.
- `Start-Process pnpm … -RedirectStandardOutput` can produce zero output (electron-builder) → run the JS CLI via
  hidden `cmd.exe /c "… > log 2>&1"`.
- extension-ci uses Node 24 and `--no-frozen-lockfile` on purpose (that app only).
- `web-ci` tokens check compares `dist` AND `../../apps` mirrors — forgetting to commit `Tokens.kt` fails CI.

## Verify
- Hook: `git add -- <path>; node apps/web/scripts/check-version.mjs --staged` → prints the verdict; then unstage
  ONLY your path if it was a test (`git restore --staged -- <path>` is index-only and safe).
- Workflow: `gh workflow view <name>`; after push `gh run watch` and quote the conclusion — never "should pass".
- Script syntax: `node --check scripts/x.mjs`; `pwsh -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('scripts/x.ps1',[ref]$null,[ref]$e); $e.Count"` → 0.
