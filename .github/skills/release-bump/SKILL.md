---
name: release-bump
description: Bump versions and changelogs per surface so husky/CI gates pass and release workflows fire — web package.json, extension manifest+package, server, mixai/native/tv, tag prefixes companion-v/server-v/extension-v/native-v/tv-v. Use when a commit touches apps/web or apps/extension (husky refuses without a bump), when cutting a release, or when asked "what version should this be". Trigger words: version bump, check-version, CHANGELOG, release tag, SemVer, husky refused.
---

# Version bump + changelog + tag

Gates: husky `apps/web/scripts/check-version.mjs --staged` (any staged `apps/web/**`) and
`apps/extension/scripts/check-version.mjs --staged` (any staged `apps/extension/**`, BOTH `manifest.json` and
`package.json`). CI re-runs the extension check with `--base=origin/main`. Other surfaces have no gate yet
(planned WP13-04 lint-staged for server/packages) — bump them anyway.

## Where the version lives
| Surface | File(s) | Changelog | Tag → workflow |
|---|---|---|---|
| web (`music-organizer`) | `apps/web/package.json` | root `CHANGELOG.md` | — (Vercel) |
| extension | `apps/extension/manifest.json` + `apps/extension/package.json` (identical) | root `CHANGELOG.md` | `extension-v*` → `extension-release.yml` |
| server / Companion | `server/package.json` (+ `server/openapi.yaml` `info.version` if API changed) | `server/CHANGELOG.md` | `companion-v*` (installers), `server-v*` (Docker) |
| mixai DJ | `apps/mixai/package.json`, `apps/mixai/src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` | root `CHANGELOG.md` | (native-release matrix) |
| native shell | `apps/native/package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`, Android `versionCode` | root `CHANGELOG.md` | `native-v*` → `native-release.yml` |
| tv-tizen | `apps/tv-tizen/package.json` + `config.xml` `version=` | root `CHANGELOG.md` | `tv-v*` |
| tv-android | `apps/tv-android/app/build.gradle.kts` `versionCode`/`versionName` | root `CHANGELOG.md` | `tv-v*` → `tv-android-release.yml` |
| packages/* | own `package.json` | — | `release.yml` (Changesets, dispatch) |
Current majors (D14, 2026-09-18): web 2.x, server 3.x, extension 3.x, mixai/native/tv 1.x. Planned WP14: web 2.1.0,
server 3.1.0, tv 1.1.0.

## Procedure
1. Decide SemVer from the diff: breaking storage key / API / DOM attribute → major; feature → minor; fix → patch.
2. Edit the version field(s) with a targeted edit (re-read the file first — other agents bump concurrently).
3. Changelog entry (Keep-a-Changelog, newest first, RO or EN matching the file): what changed for the user, WP id.
   Re-read `CHANGELOG.md` immediately before editing; never overwrite the file wholesale.
4. Stage explicit paths only, then preview the gate BEFORE committing:
   ```powershell
   git add -- apps/web/package.json CHANGELOG.md <your files>
   node apps/web/scripts/check-version.mjs --staged
   node apps/extension/scripts/check-version.mjs --staged     # when extension files are staged
   ```
5. Commit with Conventional Commits + WP id: `feat(web): WP11-03 media home hero (2.1.0)`. If the pre-commit
   hook blocks with "another commit is in progress", wait 30–60 s and retry.
6. Tag only when releasing (ask first — tags trigger paid/long workflows): `git tag server-v3.1.0; git push origin server-v3.1.0`.
   Verify the run: `gh run list --workflow mmo-server-docker.yml --limit 1` and quote the conclusion.
7. Tracker: mark the WP row `done <sha>` and `node scripts/tracker-regen-csv.mjs` in the same commit when the
   release closes a WP.

## Verify
- Both check-version scripts print OK for the staged set; `git --no-pager diff --cached --name-only` lists
  exactly the intended files (foreign staged files: keep them, commit, and NAME them in the report).
- For the extension: `node -e "const a=require('./apps/extension/manifest.json').version,b=require('./apps/extension/package.json').version;if(a!==b)process.exit(1)"` exits 0.

## Common failures
- Husky red "version not bumped" although you bumped → the bump is not STAGED, or the merge base already has
  that version (bump again).
- Extension: only one of the two files bumped — the script names the missing one.
- Server release missing the API version → `openapi.yaml` `info.version` still old; `Models.kt` header shows it.
- `git commit -a` / `git add -A` in a shared clone sweeps other agents' work — never.
- CHANGELOG conflict with another agent → their edit is in the tree; re-read and add yours below, do not revert.
