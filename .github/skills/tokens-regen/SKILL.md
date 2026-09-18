---
name: tokens-regen
description: Regenerate design tokens and every committed mirror after editing packages/design-tokens (tokens.ts / generate.ts). Use when a colour, radius, motion, breakpoint or theme dimension changes, when web-ci fails "Run pnpm -C packages/design-tokens build and commit the output", or when Tokens.kt / tokens.css / prehydrate.js look stale. Trigger words: tokens, tokens:build, Tokens.kt, prehydrate.js, tokens.plain.css, OKLCH, accent hue.
---

# Regenerate design tokens + mirrors

Source of truth: `packages/design-tokens/src/tokens.ts` (+ `generate.ts` for formats). Mirror list is the
`mirrors` array in `packages/design-tokens/src/build.ts`. Spec: `docs/design-system.md` §4.

## Procedure
1. Edit `packages/design-tokens/src/tokens.ts`. Keep colour roles as OKLCH triples on `var(--accent-h)`;
   only `--brand*` / `--deck-*` are fixed hex.
2. Build from repo root (fast, no install needed):
   ```powershell
   pnpm tokens:build
   ```
   Expected output: `wrote dist/tokens.css|tokens.plain.css|tokens.json|Tokens.kt|prehydrate.js` then
   `mirrored … → /apps/tv-android/app/src/main/java/ro/mixai/tv/ui/theme/Tokens.kt`,
   `/apps/tv-tizen/src/tokens.css`, `/apps/extension/tokens.css`, `/apps/native/web/tokens.css`,
   `/apps/web/public/prehydrate.js`, `/apps/tv-tizen/public/prehydrate.js`.
   (WP13-03 adds mixai + server/ui `prehydrate.js` to the list.)
3. Tizen sRGB fallback is NOT generated: open `apps/tv-tizen/src/styles.css`, find
   `@supports not (color: oklch(0 0 0))` and update the sRGB values to match the new tokens (source values:
   `Tokens.kt` dark/violet).
4. Run the package tests + typecheck (hidden process — shared terminal kills vitest):
   ```powershell
   pnpm -C packages/design-tokens test; pnpm -C packages/design-tokens typecheck; pnpm -C packages/ui typecheck
   ```
5. Inspect what changed and stage EXPLICITLY (never `git add -A`):
   ```powershell
   git --no-pager status --short packages/design-tokens apps
   git add -- packages/design-tokens/src packages/design-tokens/dist apps/tv-android/app/src/main/java/ro/mixai/tv/ui/theme/Tokens.kt apps/tv-tizen/src/tokens.css apps/tv-tizen/public/prehydrate.js apps/extension/tokens.css apps/native/web/tokens.css apps/web/public/prehydrate.js
   ```
   Touching `apps/web/**` or `apps/extension/**` triggers the husky version-bump gates → bump
   `apps/web/package.json` and `apps/extension/{package,manifest}.json` (skill `release-bump`).
6. Consumers that need a rebuild to see the change: web (`run-build.ps1`), mixai/tv-tizen `pnpm build`,
   tv-android Gradle (`Tokens.kt`), extension reload.

## Verify
- `pnpm tokens:build` again → `git --no-pager status --short` shows NO further changes (idempotent).
- CI equivalent: `pnpm -C packages/design-tokens build; git --no-pager diff --exit-code -- packages/design-tokens/dist apps` exits 0.
- Hex gate (WP13-03 `node scripts/hex-gate.mjs`; until then `rg -n '#[0-9a-fA-F]{6}\b' apps/*/src -g '*.tsx' -g '*.css'`)
  did not grow.

## Common failures
- `web-ci` "Generated tokens are committed" red → a mirror was not staged (most often `Tokens.kt`).
- Node < 22.6 → `--experimental-strip-types` unknown; use Node 22 (`fnm use 22`).
- `build.ts`/`generate.ts` import each other WITH `.ts` extension on purpose (strip-types needs it); every other
  `packages/*` file must NOT use `.ts` extensions (web tsc lacks `allowImportingTsExtensions`).
- Tizen looks wrong while web is right → step 3 skipped (sRGB block stale).
- CRLF in generated files → `build.ts` normalises to LF; if a diff is whole-file, your editor re-saved with CRLF.
