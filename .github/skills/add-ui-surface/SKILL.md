---
name: add-ui-surface
description: Wire a new or existing web-based surface (Vite/Next/Electron renderer) onto the shared design system — tokens.css, @mmo/ui, prehydrate.js, ThemeProvider, React dedupe, tracker entry. Use when creating a new app/renderer, when a surface still has its own palette or theme store, or when hooks crash with "Cannot read properties of null (reading 'useState')". Trigger words: new surface, onboard app, ThemeProvider, prehydrate, dedupe, @mmo/ui alias.
---

# Add a surface to the design system (design-system.md §9, ADR-0008)

Reference implementations: `apps/mixai` (Vite + Tauri), `server/ui` (Vite renderer inside server/), `apps/web`
(Next 16), `apps/tv-tizen` (Vite legacy). Non-web surfaces (Compose, vanilla HTML) use `Tokens.kt` /
`tokens.plain.css` instead — see step 7.

## Procedure
1. **CSS entry** (`src/index.css` or `globals.css`):
   ```css
   @import "tailwindcss";
   @import "<rel>/packages/design-tokens/dist/tokens.css";
   @import "<rel>/packages/ui/src/styles.css";
   @source "<rel>/packages/ui/src";
   ```
   Tailwind v4 via `@tailwindcss/vite` (Vite) or the existing web pipeline. No `tailwind.config.js`.
2. **No-flash script**: `<script src="./prehydrate.js"></script>` as the FIRST thing in `<head>`. Copy
   `packages/design-tokens/dist/prehydrate.js` into the surface's `public/` and add the target to the `mirrors`
   array in `packages/design-tokens/src/build.ts` so `pnpm tokens:build` keeps it fresh (WP13-03 does this for
   mixai and server/ui).
3. **Provider**: wrap the root in `<ThemeProvider>` from `@mmo/ui`; add `<ThemeSettings />` to the settings
   screen. Do NOT keep a second theme store (zustand skin, `localStorage["theme"]`) — migrate into
   `mixai:prefs:v1` once, then delete the old key handling.
4. **tsconfig paths** (no `workspace:*`, per-app lockfiles):
   ```json
   "paths": { "@mmo/ui": ["../../packages/ui/src/index.ts"], "@mmo/ui/*": ["../../packages/ui/src/*"],
              "@mmo/design-tokens": ["../../packages/design-tokens/src/index.ts"],
              "react": ["./node_modules/@types/react"] }
   ```
   TS 7: no `baseUrl` (TS5102) — paths are relative to the tsconfig.
5. **React dedupe** (mandatory — `packages/ui` has its own `node_modules/react`):
   - Vite: `resolve.dedupe: ["react","react-dom","motion","@base-ui/react","lucide-react"]` + `resolve.alias`
     for `react`, `react-dom`, `react/jsx-runtime` → `<app>/node_modules/...`; the `@mmo/ui/styles.css` alias
     must come BEFORE the `@mmo/ui` directory alias.
   - Next: `turbopack.resolveAlias` with RELATIVE `./node_modules/<pkg>` (absolute Windows paths fail
     "windows imports are not implemented yet") + webpack alias for `build:webpack`; vitest `resolve.dedupe`.
6. **Install peer deps inside the app**: `pnpm add --ignore-workspace react react-dom motion @base-ui/react lucide-react`
   (server/ui: `pnpm add -D --ignore-workspace` in `server/`). Match the versions used by `packages/ui`.
7. **Non-web surfaces**: Compose → `Tokens.*` from the generated `Tokens.kt`; vanilla HTML → `tokens.css`
   mirror (`tokens.plain.css`) with the same `data-*` attribute names; Tizen additionally needs the
   `@supports not (color: oklch(0 0 0))` sRGB block.
8. **Register** the surface in `docs/mixai-design-tracker.md` (§4 or §11 table) and regenerate the CSV
   (`node scripts/tracker-regen-csv.mjs`). Add a row to the surfaces table in `AGENTS.md` if it is a new app.

## Verify
- `pnpm -C <app> typecheck` and `pnpm -C <app> build` exit 0 (hidden process, read the log).
- Runtime smoke (Playwright, host-side node; NOT the integrated browser which resolves localhost on the
  client): `<html>` has `data-mode`, `data-accent`, `data-surface`, `data-density`, `data-radius`,
  `data-motion`, `lang` BEFORE React mounts; toggling in `<ThemeSettings/>` persists to
  `localStorage["mixai:prefs:v1"]` and survives reload without flash.
- Read computed colours only after `--dur-base` (220 ms).

## Common failures
- `Cannot read properties of null (reading 'useState')` → step 5 incomplete (a second React resolved from
  `packages/ui/node_modules`).
- TS7016 "Could not find a declaration file" across all of `packages/ui` → tsconfig mapped `react` to the JS
  package instead of `@types/react`.
- Styles present but wrong colours → `tokens.css` imported after `styles.css`, or `@source` missing so Tailwind
  purged `@mmo/ui` classes.
- Flash of dark/light on load → `prehydrate.js` not first in `<head>` or path wrong for `base: "./"` apps.
- Labels are RO by default (`Setări`, `Luminos`) — smoke regexes must match RO.
