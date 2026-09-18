---
name: web-verify
description: Full verification of apps/web (typecheck, vitest, baseline-aware lint, Turbopack build through the serialised wrapper, optional e2e/dev smoke) in a hidden process with a log, plus how to attribute failures to pre-existing state. Use before committing web changes, when asked "is web green", or when the shared terminal keeps killing pnpm. Trigger words: web verify, typecheck web, vitest web, lint:check, next build, music-organizer, run-build.ps1.
---

# Verify apps/web

Package name is `music-organizer`. Never run these in the shared terminal (other agents' Ctrl+C kills them
and output interleaves) — write a script, run it hidden, read the log.

## Procedure
1. Write `.copilot-tmp/web-verify.ps1`:
   ```powershell
   $ErrorActionPreference = 'Continue'
   Set-Location E:\gh\mmo\apps\web
   "== typecheck"; pnpm typecheck; "TSC_EXIT=$LASTEXITCODE"
   "== test";      node node_modules/vitest/vitest.mjs run; "VITEST_EXIT=$LASTEXITCODE"
   "== lint";      node scripts/lint-baseline.mjs check; "LINT_EXIT=$LASTEXITCODE"
   "DONE"
   ```
   (`node scripts/lint-baseline.mjs check` ≈ 2–3 min; the `pnpm lint:check` wrapper has hung for 25 min under load.)
2. Launch and wait:
   ```powershell
   Start-Process pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','E:\gh\mmo\.copilot-tmp\web-verify.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput E:\gh\mmo\.copilot-tmp\web-verify.log
   ```
   Then `Select-String -Path .copilot-tmp/web-verify.log -Pattern '_EXIT=|error TS|Test Files|Tests |problems'`.
3. Build (serialised — one build per repo; bare `pnpm build` is refused by a hook):
   ```powershell
   pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'pnpm --filter music-organizer build'
   pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Status   # exit 3 = someone else is building; read their log or -Wait
   ```
   Logs land in `.copilot-tmp/build-logs/<timestamp>-*.log` with the exit code appended. Read the newest log
   before starting — another session may have just built the same tree. Warm build ≈ 90 s; `build:webpack`
   is the only variant that prints the First Load JS table (bundle budget, WP13-03 `scripts/bundle-budget.mjs`).
4. Optional dev smoke (Playwright, host-side): start `next dev -p 13791`, probe `http://localhost:13791`
   (NOT `127.0.0.1` — "Blocked cross-origin request to Next.js dev resource" appears only in the server log and
   the client never hydrates). Kill the orphan afterwards: `Get-NetTCPConnection -LocalPort 13791`.
5. Optional e2e: `pnpm e2e` (Playwright; `pnpm e2e:install` once). Specs: `smoke`, `theme-matrix`, `a11y`,
   `ui-catalog`, `maestro-song`.
6. Attribute failures: anything red that you did not touch → skill `pre-existing-proof` (HEAD worktree) before
   claiming "pre-existing". Known historical set lives in repo memory; re-prove, don't assume.

## Verify (what to report)
- Exit codes for typecheck / vitest / lint / build, quoted from the log (VERIFIED), and the
  `Test Files … | Tests …` summary line.
- Husky preview: `git add -- <paths>; node apps/web/scripts/check-version.mjs --staged` → OK (version bumped).

## Common failures
- TS5097 `.ts` import extension errors from `packages/design-tokens`/`packages/ui` → another agent's WIP; filter
  them, re-run later, do not "fix" their files.
- `Failed to type check` / TS1109 in `.next/dev/types/validator.ts` → a concurrent dev server truncated it;
  `Remove-Item -Recurse .next/dev/types` and rebuild.
- `Cannot find module 'postgres'` (or `music-metadata`, `systeminformation`) with the package present → hollow
  pnpm store; `pnpm add --ignore-workspace <pkg>@<locked>`; `pnpm install --frozen-lockfile` will NOT fix it.
- vitest jsdom `window.localStorage` undefined → inject an in-memory Storage; the `@vitest-environment` pragma is
  ignored (`environmentMatchGlobs` decides by `.test.ts` vs `.test.tsx`).
- Only `RUN` printed then nothing → vitest was killed in the shared terminal; use the hidden process.
- `run-build.ps1` exit 3 → lock held; never delete `build.lock`, pass `-Wait`.
