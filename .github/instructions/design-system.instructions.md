---
applyTo: "packages/ui/**, packages/design-tokens/**, apps/*/src/**/*.tsx, apps/*/src/**/*.css, server/ui/**"
description: "Design tokens, theme dimensions, generated mirrors — one source of truth (ADR-0008)"
---

# Design system (spec: `docs/design-system.md`, ADR-0008)

## Rules
- Every colour, radius, duration, breakpoint comes from `packages/design-tokens/src/tokens.ts`. A literal
  `#7c5cff`, `oklch(...)` or `Color(0xFF…)` in app code is a bug (only `--brand*` and `--deck-a..d` are fixed,
  and they still live in tokens). Use Tailwind utilities / CSS vars (`var(--primary)`, `bg-primary`).
- Colour roles are OKLCH triples on `var(--accent-h)`; never hardcode lightness/chroma per screen.
- Theme = independent `data-*` axes on `<html>`: `data-mode`, `data-accent`, `data-surface`, `data-density`,
  `data-radius`, `data-motion`, `lang` (+ env flags `data-tv`, `data-standalone`). CSS reacts to attributes,
  never to a theme name. Variants: `dark:`, `glass:`, `solid:`, `flat:`, `compact:`, `tv:`, `standalone:`,
  `ultrawide:`, `motion-full:`.
- Persisted prefs: ONE blob `localStorage["mixai:prefs:v1"]` (`ThemePrefs`). Legacy `theme`, `mixai-ui`,
  `mmo-locale` are migrated once — never write them again.
- No flash: `prehydrate.js` in `<head>` before any stylesheet on web, mixai, server/ui, tv-tizen.
- Skeletons match final geometry (no CLS). Decorative motion only under `motion-full:` and only on hero /
  NowPlaying. All `--dur-*` become 0 under `data-motion="reduced"`.
- Content widths via `content-sm|md|lg|xl` utilities; z-index via `--z-*`; TV uses `overscan`, 4 px focus ring.
- WCAG 2.2 AA: visible `:focus-visible`, 44 px touch targets, `EmptyState tone="error"` has `role="alert"`.

## Changing a token
1. Edit `packages/design-tokens/src/tokens.ts` (and `generate.ts` if a new format is needed).
2. `pnpm tokens:build` at root → rewrites `dist/*` and the mirrors listed in `src/build.ts`:
   `apps/tv-android/.../ui/theme/Tokens.kt`, `apps/tv-tizen/src/tokens.css`, `apps/extension/tokens.css`,
   `apps/native/web/tokens.css`, `apps/web/public/prehydrate.js`, `apps/tv-tizen/public/prehydrate.js`.
3. Re-copy the sRGB fallback in `apps/tv-tizen/src/styles.css` (`@supports not (color: oklch(0 0 0))`) —
   Tizen Chromium predates OKLCH; this block is NOT generated.
4. Commit the source **and** every mirror in one commit. `web-ci` runs `pnpm build` in design-tokens and
   fails on `git diff --exit-code -- dist ../../apps`.
Skill: `tokens-regen`.

## Adding a surface (design-system.md §9)
`@import "tailwindcss"; @import "<rel>/design-tokens/dist/tokens.css"; @import "<rel>/ui/src/styles.css";
@source "<rel>/ui/src";` → `prehydrate.js` in `<head>` → `<ThemeProvider>` + `<ThemeSettings/>` → tsconfig
paths `@mmo/ui`, `@mmo/design-tokens` + React dedupe → register in `docs/mixai-design-tracker.md`.
Skill: `add-ui-surface`.

## Gotchas
- `Cannot read properties of null (reading 'useState')` → two Reacts. `packages/ui` has its own
  `node_modules/react`; dedupe in the consumer (Next: `turbopack.resolveAlias` with RELATIVE
  `./node_modules/<pkg>` paths — absolute Windows paths fail "windows imports are not implemented yet";
  Vite: `resolve.dedupe` + alias `react`, `react-dom`, `react/jsx-runtime`, `motion`, `@base-ui/react`).
- `packages/*` source imports must have NO `.ts` extension (web tsc lacks `allowImportingTsExtensions`),
  EXCEPT `design-tokens/src/build.ts`/`generate.ts` which run under `node --experimental-strip-types`.
- Vite alias for `@mmo/ui/styles.css` must precede the `@mmo/ui` directory alias.
- Tokens are `oklch()`; non-web mirrors are plain CSS vars (`tokens.plain.css`) / Kotlin `object Tokens`.

## Verify
- `pnpm -C packages/design-tokens test` and `pnpm -C packages/ui typecheck` + `test` (hidden process, see AGENTS.md).
- `pnpm tokens:build; git --no-pager status --short packages/design-tokens/dist apps` → nothing unexpected.
- Hex gate (planned WP13-03: `node scripts/hex-gate.mjs`); until then `rg -n '#[0-9a-fA-F]{6}\b' apps/<x>/src -g '*.tsx' -g '*.css'`
  and `rg -n 'Color\(0x' apps/tv-android/app/src` must not grow.
