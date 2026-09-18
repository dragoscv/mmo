---
name: pre-existing-proof
description: Prove that a failing test/typecheck/lint/build was already failing on HEAD without your change, using a temporary git worktree (safe in a shared clone — no stash/checkout), node_modules junctions, and the identical command. Use before writing "pre-existing failure" in any report, when a red check appears in code you did not touch, or when another agent's WIP is suspected. Trigger words: pre-existing, was it already broken, HEAD worktree, baseline, not my change.
---

# Prove a failure is pre-existing (HEAD worktree)

Never `git stash`, `git checkout --`, `git restore` or `reset --hard` to test HEAD — the clone is shared and those
destroy other agents' uncommitted work. A worktree is a separate directory; the main tree is untouched.

## Procedure
1. Create the worktree at HEAD (or a specific sha) inside scratch:
   ```powershell
   Set-Location E:\gh\mmo
   git worktree add .copilot-tmp\wt-head HEAD
   ```
2. Give it dependencies without installing — junction the `node_modules` of every package the command needs
   (apps/web AND each `packages/*` it imports; `packages/ai` needs its own):
   ```powershell
   New-Item -ItemType Junction -Path .copilot-tmp\wt-head\apps\web\node_modules -Target E:\gh\mmo\apps\web\node_modules
   foreach ($p in 'ui','design-tokens','ai','sdk','db') { if (Test-Path "packages\$p\node_modules") { New-Item -ItemType Junction -Path ".copilot-tmp\wt-head\packages\$p\node_modules" -Target "E:\gh\mmo\packages\$p\node_modules" } }
   ```
   (`server`: junction `server\node_modules`; tv-android: Gradle caches are global, nothing to link.)
3. Run the SAME command in the worktree, hidden, logging to `.copilot-tmp/wt-<name>.log`:
   ```powershell
   # .copilot-tmp/wt-run.ps1
   Set-Location E:\gh\mmo\.copilot-tmp\wt-head\apps\web
   node node_modules/vitest/vitest.mjs run src/lib/x.test.ts; "EXIT=$LASTEXITCODE"
   ```
   `Start-Process pwsh -ArgumentList '-NoProfile','-File','E:\gh\mmo\.copilot-tmp\wt-run.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput E:\gh\mmo\.copilot-tmp\wt-run.log`.
   Builds in a worktree: `run-build.ps1 -Root <wt> -Command 'pnpm --filter music-organizer build:webpack'` (it runs
   through cmd, no `Set-Location`).
4. Compare: same test names / same TS error codes+lines / same lint files failing in BOTH logs → pre-existing.
   Different set → yours. Quote both summaries.
5. Special case — HEAD alone does not build because other agents' uncommitted files are referenced: robocopy
   the live `apps/web/src` + `packages/*/src` into the worktree (`robocopy <src> <dst> /MIR`), then overwrite
   ONLY your files with `git show HEAD:<path> > <wt>/<path>` so the diff isolates your change.
6. Clean up (never leave worktrees — they confuse `git status` for everyone):
   ```powershell
   git worktree remove .copilot-tmp\wt-head --force
   git worktree prune; git worktree list
   ```
   Junctions inside the worktree are removed with it; the real `node_modules` are untouched.

## Verify (report shape)
- "Pre-existing on HEAD `<sha>`: `<N>` failures — `<names>` — identical in `.copilot-tmp/wt-run.log` (exit 1) and
  the live tree." Include both exit codes. Anything not reproduced in the worktree is YOURS to fix.
- Record durable findings (which tests, which sha) in repo memory so the next agent does not re-prove them.

## Common failures
- `fatal: '.copilot-tmp/wt-head' already exists` → a previous run was not cleaned; `git worktree remove … --force`.
- `Cannot find module …` only in the worktree → a `packages/*/node_modules` junction is missing (step 2).
- Junction creation "Access denied" → path exists as an empty dir from the checkout (`.gitkeep`); remove it first.
- Windows `MAX_PATH` errors → `git config core.longpaths true`.
- Different results because `.env.local` is absent in the worktree → copy it in only if the test needs it, and
  remember it points at PRODUCTION (`DATABASE_URL`); never run migrations from the worktree.
- `run-build.ps1` exit 3 → another build holds the lock; `-Wait`.
