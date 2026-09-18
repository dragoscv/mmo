# Gates — every automated check, where it runs, how to run it locally

Canonical inventory for tracker §11 WP13 (04 hooks, 05 CI, 06 mutation tests). Keep this table in
sync with `.husky/*`, root `package.json` `lint-staged`, and `.github/workflows/*.yml`.
Rule of thumb: **hook = path-scoped and seconds; CI = everything slower.** Hooks only READ the git
index and never stage or rewrite files (shared clone).

## Local hooks (husky 9, installed by root `pnpm install` → `prepare` → `scripts/prepare-husky.cjs`; skipped when `CI` or `HUSKY=0`)

| Gate | Trigger (staged path) | Command | What it proves | Mutation test (WP13-06) |
|---|---|---|---|---|
| web version bump | `apps/web/**` (significant) | `node apps/web/scripts/check-version.mjs --staged` | `apps/web/package.json` version > base | pending |
| extension version bump | `apps/extension/**` | `node apps/extension/scripts/check-version.mjs --staged` | `manifest.json` + `package.json` both bumped | pending |
| migrations | `apps/web/src/db/**` | `node apps/web/scripts/check-migrations.mjs --staged` | new `drizzle/NNNN_*.sql` + `_journal.json` entry | pending |
| i18n parity (web) | `apps/web/messages/*.json` | lint-staged → `node apps/web/scripts/i18n-parity.mjs` | every leaf key exists in en **and** ro | pending |
| i18n parity (extension) | `apps/extension/_locales/**/messages.json` | lint-staged → `node scripts/i18n-parity-ext.mjs` | same key set across `_locales/*` | pending |
| tokens drift | `packages/design-tokens/src/**` | lint-staged → `node scripts/tokens-drift.mjs` | rebuild + `git diff --stat` over `dist` and all mirrors (Tokens.kt, tokens.css ×3, prehydrate.js ×4) is empty; fails with the `git add` line to run | pending |
| OpenAPI drift | `server/src/**/*.ts`, `server/openapi.yaml`, `server/package.json` | lint-staged → `node server/scripts/openapi-check.mjs` | Express routes ⇄ `openapi.yaml` paths | pending |
| hex gate | `{packages/ui,apps/mixai,server/ui,apps/tv-tizen}/src/**/*.{ts,tsx,css}`, `apps/tv-android/**/*.kt` | lint-staged → `node scripts/hex-gate.mjs --staged` | no `#rrggbb` / `Color(0x…)` outside `scripts/hex-gate.allowlist.json` | verified 2026-09-18 (probe `#ff0000` → RED, removed → GREEN) |
| tracker csv | `docs/mixai-design-tracker.md` | lint-staged → `node scripts/tracker-drift.mjs` | regenerated `docs/mixai-design-tracker.csv` equals the staged one | pending |
| server/packages version bump | `server/**`, `packages/{ui,design-tokens,sdk,ai}/**` | lint-staged → `node scripts/check-version-generic.mjs --staged` | that surface's `package.json` version > base (`origin/main`, fallback `HEAD`); a surface absent at base passes as new | verified 2026-09-18 (`--base=HEAD` probe → RED, removed → GREEN) |
| commit message | every commit | `.husky/commit-msg` → `pnpm exec commitlint --edit "$1"` (`commitlint.config.mjs`) | Conventional Commits; header ≤ 120; scope in the enum = warning only | verified 2026-09-18: `bad message` → exit 1, `feat(web): x` → exit 0 (see below) |

lint-staged runs with `--no-stash` (never touches the working tree). Every command ignores the file
list it receives and re-reads the index, so a partial stage cannot bypass it. Bypass on purpose with
`git commit --no-verify` (generated-only commits) and say so in the message.

## CI (GitHub Actions)

| Workflow | Triggers (paths) | Jobs / steps | Runtime | Local equivalent |
|---|---|---|---|---|
| `web-ci.yml` | `apps/web/**`, `packages/**`, `scripts/**` | **fast-gates**: i18n parity web+ext, hex gate, (PR) web version + migrations vs base · **packages** matrix design-tokens/ui: typecheck, test, tokens `build` + `git diff --exit-code -- dist ../../apps ../../server/ui/public` · **web**: `lint:check`, `typecheck`, `test`, `build`, `bundle-budget.mjs --check .next` (baseline method `next-dir`) · **runtime**: prod build → `lhci autorun` (`/`, `/offline`, `/status`; a11y ≥ 0.9 error, perf ≥ 0.7 warn) → `pnpm start` → `playwright test e2e/a11y.spec.ts --project=w390 --project=w1440` (axe serious/critical) · **knip**: `pnpm dlx knip@6 --no-exit-code`, report artifact | Node 22, `pnpm install --frozen-lockfile --ignore-workspace` per dir; ~25–30 min worst job | `pnpm i18n:check`, `pnpm hex:check`, `pnpm -C apps/web lint:check typecheck test`, build via `run-build.ps1`, `pnpm -C apps/web bundle:check .next`, `pnpm -C apps/web lhci`, `pnpm -C apps/web e2e -- e2e/a11y.spec.ts` |
| `server-ci.yml` | `server/**`, `packages/sdk/**` | **server**: `build:headless` (tsc), `ui:typecheck`, `vitest`, `openapi:check`, `openapi:lint` (redocly), regenerate `Models.kt` + `packages/sdk/src/generated/mmo-server.d.ts` and `git diff --exit-code`, (PR) `check-version-generic.mjs --base` · **sdk**: typecheck + test · **docker-smoke** (push to main only): amd64 build, `docker run`, `/health` within 60 s | Node 22 | `pnpm -C server build:headless ui:typecheck test openapi:check openapi:lint openapi:gen`; `git --no-pager diff --stat -- apps/tv-android/**/generated packages/sdk/src/generated` |
| `extension-ci.yml` | `apps/extension/**` | version-bump vs base, manifest MV3 sanity, `vendor:polyfill` drift | Node 24 (that app only) | `node apps/extension/scripts/check-version.mjs`; `pnpm -C apps/extension vendor:polyfill` |
| `docs-ci.yml` | `**/*.md`, `docs/**`, `lychee.toml` | **links**: `lycheeverse/lychee-action@v2 --offline` with `lychee.toml` (excludes localhost/LAN/mixai.ro/mailto) · **tracker**: `tracker-regen-csv.mjs` + `git diff --exit-code` on the csv | ~1 min | `lychee --config lychee.toml --offline './**/*.md'` (needs lychee installed); `pnpm tracker:drift` |
| `deps-weekly.yml` | cron `0 6 * * 1`, dispatch | `pnpm outdated --format json` in every dir with a lockfile → markdown with the known-blockers table (TS 7 / ESLint 10 on web, tauri 2.x, cpal/symphonia, pnpm 10.0.0 in Dockerfile) → single rolling issue "Weekly dependency report" (`gh issue list` finds it, `peter-evans/create-issue-from-file@v5` creates/updates) | ~5 min | `pnpm -C <dir> outdated` |
| `ci-lint.yml` | `.github/workflows/**` | `raven-actions/actionlint@v2` (shellcheck of `run:` blocks included) | seconds | `actionlint` at repo root (winget `rhysd.actionlint`) |
| `companion-release.yml`, `mmo-server-docker.yml`, `extension-release.yml`, `native-release.yml`, `tv-android-release.yml`, `release.yml` | tags `companion-v*`, `server-v*`, `extension-v*`, `native-v*`, `tv-v*`, dispatch | release artefacts (not gates) | — | — |

Unchanged rules: never `pnpm install` at repo root in CI (per-app lockfiles); never auto-update
lockfiles; workflows are LF without BOM.

## Root tooling versions (installed 2026-09-18 with `pnpm add -D --ignore-workspace` at repo root)

| Package | Version |
|---|---|
| husky | 9.1.7 |
| lint-staged | 17.5.1 |
| @commitlint/cli | 21.2.2 |
| @commitlint/config-conventional | 21.2.2 |
| knip (CI, via `pnpm dlx`) | 6.x |
| actionlint (local, winget) | see `actionlint -version` |

Root install works with `pnpm install --ignore-workspace` (the extension store entry breaks only a
workspace-mode install). If `pnpm exec lint-staged --version` fails, run that command once.

## Verification log (WP13-04/05, 2026-09-18)

Run: `.copilot-tmp/wp13b-verify.ps1` → `.copilot-tmp/wp13b-verify.log`. Results are pasted in the
section below as they were produced; anything not listed here is **unverified locally** (CI-only
behaviour: LHCI/axe/knip/docker-smoke/lychee/deps-weekly issue creation run for the first time on push).

<!-- VERIFY-LOG-START -->
```text
# tool versions (root)
pnpm exec lint-staged --version      → 17.5.1
pnpm exec commitlint --version       → @commitlint/cli@21.2.2
actionlint -version                  → 1.7.12

# commitlint
'feat(web): add thing'               → exit 0
'fix(unknown-scope): x'              → exit 0, ⚠ scope must be one of [web, server, …]  (warning only)
'bad message'                        → exit 1, ✖ subject may not be empty, ✖ type may not be empty
commitlint --edit <file 'bad message'> → exit 1 ; --edit <file 'feat(web): ok'> → exit 0

# actionlint on server-ci, web-ci, docs-ci, deps-weekly, ci-lint → exit 0 (no findings)
# CRLF check on the 5 workflows + .husky/{pre-commit,commit-msg} + lychee.toml → none
# node --check check-version-generic / tokens-drift / tracker-drift / commitlint.config → 0

# empty stage
node scripts/check-version-generic.mjs --staged → exit 0
node scripts/hex-gate.mjs --staged              → "0 files scanned … hex-gate: OK", exit 0
pnpm exec lint-staged --no-stash                → "could not find any staged files", exit 0

# MUTATION (probe files staged: packages/ui/src/__gate_probe__.css with #ff0000, server/src/__gate_probe__.ts)
pnpm exec lint-staged --no-stash →
	✖ node scripts/hex-gate.mjs --staged
			packages/ui/src/__gate_probe__.css:1: #ff0000  .x { color: #ff0000; }
			hex-gate: FAIL — use tokens from @mmo/design-tokens …
	✖ node scripts/check-version-generic.mjs --staged  (task killed after the first failure)
	exit 1
node scripts/check-version-generic.mjs --staged --base=HEAD →
	✖ Version bump required — MMO Server: server/package.json version is still 3.1.0 (base 3.1.0)   exit 1
node scripts/check-version-generic.mjs --staged (base origin/main) →
	✓ version bumped: MMO Server: 1.0.47 → 3.1.0 ; @mmo/ui: new at origin/main (1.0.0)   exit 0
# RESTORE (git rm --cached probes, delete files) → hex-gate OK exit 0, check-version-generic exit 0

# prepare-husky.cjs with CI=1 → exit 0, no-op ; with HUSKY=0 → exit 0, no-op
```

Not verified locally (first run happens in GitHub Actions): LHCI + axe + knip jobs in `web-ci`,
`server-ci` docker-smoke `/health`, lychee (not installed here), `deps-weekly` issue creation,
`raven-actions/actionlint@v2`. The i18n / tokens-drift / OpenAPI / tracker-drift lint-staged rows
were exercised only for config loading (glob → command), not mutated — WP13-06.
<!-- VERIFY-LOG-END -->

## WP13-06 — mutation tests

Each gate gets: break the invariant → run the gate → RED (paste) → restore → GREEN (paste). Column
"Mutation test" above flips from `pending` to `verified <date>` per row. Verified so far (log above):
commit message, hex gate (`--staged`), server/packages version bump. Everything else: pending.
