---
applyTo: "apps/web/**"
description: "apps/web (Next 16 Turbopack, React 19.3, next-intl RO/EN): commands, version bump, lint baseline, dev-server traps"
---

# apps/web — Next 16 PWA (package name `music-organizer`)

Read `apps/web/AGENTS.md` (Next.js generated block, rewritten by `next dev`) before touching App Router code.

## Rules
- Server-first: RSC + Server Actions; `"use client"` only where needed. Route interception lives in `proxy.ts`
  (headers only, matcher `/api/auth`) — it is NOT an auth gate; pages guard themselves with `auth()`.
- Login redirect convention: `/login?callbackUrl=<same-origin path>` (legacy `?from=` still read).
- i18n: `next-intl`, locales `ro` (default) + `en` in `messages/{en,ro}.json`; every new string in BOTH
  files (parity gate `apps/web/scripts/i18n-parity.mjs`, added in WP13-03). Locale is mirrored from the
  `mixai:prefs:v1` blob to the `mmo-locale` cookie.
- UI from `@mmo/ui` (Base UI) + tokens; no hex, no Radix, no `framer-motion` (see design-system/base-ui rules).
- URL state: `nuqs` (`<NuqsAdapter>` in layout; `useQueryStates(..., { shallow:false, clearOnDefault:true })`).
- SW: `@serwist/next` **configurator mode** (`serwist.config.mjs`, `build = next build && serwist build`);
  HTML/RSC/actions are NetworkOnly (PII). Never add `@serwist/next/typings` to tsconfig `types`.
- `/dev/ui` catalog is dev-only (404 in prod unless `MIXAI_DEV_UI=1`).
- **Version bump**: any staged file under `apps/web/` requires `apps/web/package.json` `version` bumped
  (husky `check-version.mjs --staged`, CI `--base=origin/main`). Current major is 2.x.
- Deps: `pnpm add --ignore-workspace <pkg>` INSIDE `apps/web`. Blocked at latest: TypeScript 5.9 (typescript-eslint
  has no TS 7 API), ESLint 9 (eslint-plugin-react peer). Weekly retry noted in tracker §8.

## Commands (run from `apps/web`)
- `pnpm dev` (port 13789) · `pnpm typecheck` · `pnpm test` (vitest) · `pnpm e2e` (Playwright) ·
  `node scripts/lint-baseline.mjs check` (baseline-aware ESLint, ~3 min; `pnpm lint:check` via pnpm.cmd has hung) ·
  `pnpm lhci`.
- Build ONLY via the wrapper at repo root:
  `pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'pnpm --filter music-organizer build'`
  (`build:webpack` is the escape hatch and the only one that prints the First Load JS table).
- Env: `SKIP_ENV_VALIDATION=1` for CI-like builds; `.env.local` is PRODUCTION for `DATABASE_URL` (see web-db).

## Gotchas (exact strings)
- `Blocked cross-origin request to Next.js dev resource` (server log only; browser shows no hydration, no
  errors) → you hit `http://127.0.0.1:PORT`; Next 16 dev binds `localhost`. Use `http://localhost:PORT` in
  probes or set `allowedDevOrigins`.
- `Module not found ... windows imports are not implemented yet` → absolute Windows path in
  `turbopack.resolveAlias`; use `./node_modules/<pkg>`.
- `Failed to type check` / TS1109 in `.next/dev/types/validator.ts` → truncated by a concurrent dev server;
  delete `.next/dev/types` and rebuild.
- `Cannot find module 'postgres'` (or `music-metadata`, `systeminformation`) while the package exists →
  hollow `.pnpm/<pkg>@ver/node_modules/`; `pnpm install --frozen-lockfile` says "Already up to date" and does
  NOT fix it. Run `pnpm add --ignore-workspace <pkg>@<locked-version>`.
- vitest `environmentMatchGlobs`: `.test.ts` → node, `.test.tsx` → jsdom; the `// @vitest-environment` pragma
  is IGNORED. jsdom has no `window.localStorage` (opaque origin) → inject an in-memory Storage.
- TS5097 `.ts` import-extension errors from `packages/*` in web tsc = another agent's WIP; filter, don't fix blind.
- `e2e/` is excluded from tsconfig → typecheck a spec with
  `tsc --noEmit --strict --esModuleInterop --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --types node e2e/x.spec.ts playwright.config.ts`.
- `react-hooks/set-state-in-effect` and `react-hooks/purity` are lint ERRORS here.

## Verify
- `pnpm typecheck`, `pnpm test`, `node scripts/lint-baseline.mjs check` — all through a hidden
  `Start-Process pwsh -File .copilot-tmp/web-verify.ps1 -RedirectStandardOutput <log>` (skill `web-verify`).
- Pre-existing failures: prove with skill `pre-existing-proof`; known set is listed in repo memory, not assumed.
- Dev smoke: `next dev` on a spare port + Playwright against `http://localhost:<port>`; read the server log FIRST.
