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
4. `pnpm exec lint-staged --no-stash` — path-scoped gates from root `package.json` `lint-staged` (added WP13-04):
   web/extension i18n parity, `scripts/tokens-drift.mjs`, `server/scripts/openapi-check.mjs`, `scripts/hex-gate.mjs
   --staged`, `scripts/tracker-drift.mjs`, `scripts/check-version-generic.mjs --staged` (server + packages/{ui,
   design-tokens,sdk,ai}). Drift gates FAIL and print the `git add` to run; they never stage anything.

**Husky `.husky/commit-msg`** (WP13-04): `pnpm exec commitlint --edit "$1"` → `commitlint.config.mjs` (conventional,
header ≤ 120, scope-enum is a warning). Root `prepare` runs `scripts/prepare-husky.cjs` (no-op when `CI`/`HUSKY=0`).
Root deps install with `pnpm install --ignore-workspace` at the repo root. Full inventory: `docs/arhitectura/gates.md`.

**Workflows** (`.github/workflows/`):
| File | Trigger | Does |
|---|---|---|
| `web-ci.yml` | push/PR on `apps/web/**`, `packages/**`, `scripts/**` | fast-gates (i18n parity, hex gate, PR version/migration guards); packages matrix (design-tokens, ui): typecheck, test, tokens `pnpm build` + `git diff --exit-code -- dist ../../apps ../../server/ui/public`; web: `lint:check`, `typecheck`, `test`, `build`, `bundle-budget.mjs --check .next`; runtime: LHCI + axe (`e2e/a11y.spec.ts` w390/w1440); knip (report only) — added WP13-05 |
| `server-ci.yml` | `server/**`, `packages/sdk/**` | tsc, `ui:typecheck`, vitest, `openapi:check`, `openapi:lint`, regenerate Models.kt + SDK types and `git diff --exit-code`, PR version guard; sdk typecheck/test; docker amd64 smoke `/health` on main — added WP13-05 |
| `docs-ci.yml` | `**/*.md`, `docs/**` | lychee `--offline` (`lychee.toml`), tracker csv regen + diff — added WP13-05 |
| `deps-weekly.yml` | cron Mon 06:00 UTC, dispatch | `pnpm outdated` per lockfile → rolling issue "Weekly dependency report" — added WP13-05 |
| `ci-lint.yml` | `.github/workflows/**` | `raven-actions/actionlint@v2` (`.github/actionlint.yaml` declares `ubuntu-24.04-arm`) — added WP13-05 |
| `extension-ci.yml` | `apps/extension/**` | version-bump guard vs base, manifest MV3 check, `vendor:polyfill` drift |
| `companion-release.yml` | tag `companion-v*`, dispatch | electron-builder installers |
| `mmo-server-docker.yml` | tag `server-v*`, dispatch | buildx image, context `server/` |
| `extension-release.yml` | tag `extension-v*` | zip + release |
| `native-release.yml` | tag `native-v*` | `pnpm tauri:build --target <rust_target>` matrix |
| `tv-android-release.yml` | tag `tv-v*` | Gradle release APK |
| `release.yml` | dispatch | Changesets version/publish |
| `yjs-relay-deploy.yml` | `infra/yjs-relay/**` | relay deploy |
Not covered anywhere yet: tv-android/tv-tizen/mixai/native builds on PR (release tags only).

## Planned (tracker §11 WP13)
- WP13-06 mutation-test every gate → fill the "Mutation test" column in `docs/arhitectura/gates.md`
  (done so far: commitlint, hex `--staged`, check-version-generic). Then drop `--no-exit-code` from knip.

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
