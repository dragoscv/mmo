# MixAI Design System & UX Overhaul — canonical plan and tracker

> Single source of truth for the cross-surface design overhaul (2026-09). Pairs with
> `docs/mixai-design-tracker.csv` (same items, spreadsheet form). Update both in the same commit.
> Status vocabulary: `todo` · `doing` · `done` · `blocked` · `dropped` (with reason).

## 0. Decisions log (answers to askQuestions rounds)

| # | Question | Decision | Date |
|---|---|---|---|
| D1 | Surfaces in scope | all six: web, mixai, native, server/ui, tv-tizen + tv-android, extension | 2026-09-17 |
| D2 | Where the design system lives | new `packages/design-tokens` + `packages/ui` | 2026-09-17 |
| D3 | Dependency upgrades | every stable major, one verified slice each | 2026-09-17 |
| D4 | Web bundler | try Turbopack for `next build`; revert to `--webpack` if workers/wasm/audio break | 2026-09-17 |
| D5 | Tracker location | `docs/mixai-design-tracker.md` + `.csv` | 2026-09-17 |
| D6 | Primitive base for `packages/ui` | **Base UI** (`@base-ui/react` 1.8) — shadcn default since 2026-07; all 21 web primitives rewritten (`render` prop, Floating UI) | 2026-09-17 |
| D7 | Theme dimensions exposed | mode, accent (6 presets + custom hue), surface (glass/solid/flat), density, radius, **accent-from-artwork** (NowPlaying/Watch) | 2026-09-17 |
| D8 | Companion UI | rewrite as Vite + React mini-app on `@mmo/ui`, same preload API | 2026-09-17 |
| D9 | MixAI DJ skins | become `surface` presets on the brand accent; deck A/B colours kept; green stays as `emerald` accent | 2026-09-17 |
| D10 | Mobile navigation | bottom tab bar (5) + "More" sheet + mini-player above; drawer kept for full tree | 2026-09-17 |
| D11 | Risky majors | ALL in: TS 7 (fallback 5.9), vitest 5, Electron 44, ai SDK 7, express 5 | 2026-09-17 |
| D12 | Delivery order | WP0 → WP1 (web upgrades) → WP2 (web UI) → WP3–7 in parallel subagents → WP8 | 2026-09-17 |
| D13 | Extra recommendations | ALL in: web CI, `/dev/ui` catalog, unified command palette + shortcuts, nuqs, haptics/sound cues (opt-in), `@serwist/next`, OpenAPI-generated Kotlin/TS clients | 2026-09-17 |
| D14 | Versioning | **major bump everywhere**: web 2.0.0, companion 3.0.0, extension 3.0.0, mixai/native 1.0.0, tv 1.0.0 | 2026-09-17 |

## 1. Research summary (verified 2026-09-17)

**apps/web** — Tailwind 4.0.17 precompiled by `@tailwindcss/cli` into `public/globals.css` (no PostCSS);
shadcn `radix-vega` with 21 primitives (missing skeleton/sheet/switch/scroll-area/separator/avatar/sidebar);
custom `ThemeProvider` (key `theme`, default dark, `<html class="dark">` hardcoded → light-mode flash;
`next-themes` installed but unused); **no accent, surface or density preference**; `framer-motion` 12;
`next-intl` via cookie `mmo-locale` used in only 8 files (labels mixed EN/RO); **0 `loading.tsx`, no
`not-found.tsx`**, 35 `force-dynamic` pages block on data; 7 of 18 settings routes are stubs; three
different "not signed in" patterns; brand purple re-hardcoded ~26×; no ultra-wide handling (settings
double-constrained and off-centre); storage-key drift `mmo-` vs `mmo:` breaks profile sync;
`components.json` points at a non-existent file; `next build --webpack`.

**apps/mixai** — Vite 6, plain CSS + inline styles, 3 dark-only skins (green `#00e08a` default), zustand,
no i18n, no icons, `framer-motion` declared but unused, no error boundary, versions drift 0.2.0/0.1.0.

**apps/native** — one vanilla `index.html` that still says "MMO", palette `#a855f7`; Capacitor 7.6.5;
`AndroidManifest.xml` missing so `ANDROID_TV.md` edits are unapplied; safe-area only promised.

**server/ui** — 1400-line vanilla `index.html`, "Connect to MMO", `#a855f7`, emoji icons, dark only,
Electron 34.5.8, fake titlebar on Windows over the native frame.

**apps/tv-tizen** — Vite 7 + React 19, own `focus.ts`, RO hardcoded, `#7c5cff`; no search/resume/series.
**apps/tv-android** — Compose TV, ~40 literal `Color(0xFF…)`, EN hardcoded, `imageUrl = null` posters,
`tv-foundation` alpha, no MediaSession.

**apps/extension** — vanilla MV3, third palette (`#9333ea`), content button says "MMO", popup says v1.0,
7/15 platform adapters, README describes an architecture that is not implemented.

**Tooling** — no root turbo/catalogs, per-app lockfiles (`shared-workspace-lockfile=false`), packages
consumed via tsconfig `paths`; husky enforces `apps/web` version bump; **no CI for web**;
docs describing UI: `docs/concept/ui-ux.md` (legacy palette), `docs/mixai/00-architecture-and-plan.md`
§8, `docs/arhitectura/03-stack-tehnologic.md`, `docs/aplicatie/*` (ASCII mockups), `NAVIGARE.md`.

**Latest stable (npm view, 2026-09-17)** — next 16.3.5 · react 19.3.0 (`<ViewTransition>` stable) ·
typescript 7.0.2 · tailwindcss 4.3.3 · vite 8.3.0 · motion 13.4.0 · lucide-react 1.47.0 · radix-ui 1.6.7 ·
shadcn CLI 4.21 (Base UI default since 2026-07) · @tanstack/react-table 9.2.4 · ai 7.0.105 · vitest 5.0.1 ·
electron 44.4.1 · electron-builder 26.15.3 · @capacitor/* 8.5.2 · @tauri-apps/cli 2.11.4 ·
better-sqlite3 13.0.3 · @vitejs/plugin-react 6.1.1 · @vitejs/plugin-legacy 8.2.3 · next-intl 4.14.5.

## 2. Design direction

**Brand: "Neon Nocturne"** — deep indigo base, violet `#7c5cff` dominant, magenta `#e84ff0` + cyan
`#22d3ee` as the two-stop signature gradient, warm-ivory text. Rendered in **OKLCH** so accents can be
re-hued at runtime (`oklch(from var(--accent) …)`).

**Theme dimensions** (all persisted, all synced per profile, all readable before first paint):

| Dimension | Values | Default |
|---|---|---|
| `mode` | `light` · `dark` · `system` | `system` |
| `accent` | `violet` (brand) · `magenta` · `cyan` · `emerald` · `amber` · `rose` · `custom:<hue>` | `violet` |
| `surface` | `glass` (translucent, blur, glow) · `solid` (opaque, subtle shadow) · `flat` (no blur/shadow, hairline borders) | `glass` desktop / `solid` mobile |
| `density` | `comfortable` · `compact` | `comfortable` |
| `radius` | `sm` · `md` · `lg` | `md` |
| `motion` | `full` · `reduced` (also follows `prefers-reduced-motion`) | `full` |
| `locale` | `ro` · `en` | browser → `ro` |

Storage: one JSON key `mixai:prefs:v1` (migrated from `theme`, `mmo-locale`, `sidebar-collapsed`,
`mixai-ui`), mirrored as `data-*` attributes on `<html>` by a 1 KB pre-hydration script.

**Layout system**
- Content max-width tokens `--content-sm/md/lg/xl/full` and a `Page` component; ultra-wide (`≥ 2000px`,
  `≥ 21:9`) keeps reading columns ≤ 1400 px and turns lists into multi-column grids via `@container`.
- Breakpoints: Tailwind defaults + `3xl: 1920px`, `4xl: 2560px`; aspect-ratio variants `ultrawide`.
- Mobile: `viewport-fit=cover`, `--safe-*` utilities, bottom tab bar + `vaul` sheets, 44 px targets,
  overscroll containment, `<Activity>`-kept player.
- TV (10-foot): 24 px root, focus ring 4 px accent, 5 %/10 % overscan margins, D-pad spatial nav.

**Motion** — `motion` 13 presets (`fade`, `rise`, `scale`, `stagger`), React 19.3 `<ViewTransition>`
for route changes, skeletons that match final layout (no CLS), progress bars for long jobs.

## 3. Architecture

```
packages/design-tokens        # source of truth
  src/tokens.ts               # OKLCH palette, spacing, radius, motion, breakpoints (typed)
  src/build.ts                # emits: css/tokens.css (Tailwind v4 @theme + data-* variants),
                              #        json/tokens.json, kotlin/Tokens.kt, tizen/tokens.css, ext/tokens.css
  css/…  json/…  kotlin/…     # generated, committed
packages/ui                   # @mmo/ui — shadcn owned source on radix-ui (unified), Tailwind v4
  src/components/*            # primitives + composites: Skeleton, EmptyState, PageHeader, Page,
                              # AppShell, Sidebar, BottomTabBar, DataTable (TanStack 9), Sheet, Switch,
                              # ScrollArea, Separator, Avatar, ProgressJob, ThemePicker, AccentPicker…
  src/theme/*                 # ThemeProvider (prefs store, prehydrate script string, sync hook)
  src/motion/*                # presets, <PageTransition>, reduced-motion aware
  src/i18n/*                  # shared RO/EN messages for ui strings
  src/hooks/*                 # useMediaQuery, useSafeArea, useContainerSize, useHaptics
```
Consumed via tsconfig `paths` (existing repo convention, no build step) by web, mixai, server/ui;
generated CSS/Kotlin consumed by tizen, tv-android, extension, native.

## 4. Work packages (WP) and items

Status column mirrors the CSV. IDs are stable — reference them in commits (`feat(ui): WP2-05 …`).

### WP0 — Foundation & tooling
| ID | Item | Status |
|---|---|---|
| WP0-01 | `packages/design-tokens` with typed OKLCH tokens + generator (CSS/JSON/Kotlin) | done 4f9e671 |
| WP0-02 | `packages/ui` on **Base UI** (D6) — 40+ primitives incl. DataTable (TanStack 9), Sidebar, BottomTabBar, AppShell, CommandDialog, shortcuts registry | done 4f9e671 |
| WP0-03 | ThemeProvider v2: prefs store `mixai:prefs:v1`, migration from legacy keys, prehydrate script, `data-*` attrs, artwork accent | done 4f9e671 |
| WP0-04 | Root scripts (`lint`, `typecheck`, `test`, `build` fan-out) + `.github/workflows/web-ci.yml` (lint/typecheck/test/build) | done e837d87 |
| WP0-05 | Docs: `docs/design-system.md` (tokens, dimensions, usage), replace `docs/concept/ui-ux.md`, update NAVIGARE/README/stack doc | todo |

### WP1 — Dependency upgrades (one slice = one commit, verified)
| ID | Item | Status |
|---|---|---|
| WP1-01 | web: next 16.3.5, react 19.3, eslint-config-next, @next/bundle-analyzer | done e837d87 |
| WP1-02 | web: tailwindcss 4.3.3 (+cli), tw-animate-css, radix-ui 1.6.7, lucide-react 1.47, tailwind-merge | done e837d87 |
| WP1-03 | web: framer-motion 12 → motion 13 (16 import sites) | done e837d87 |
| WP1-04 | web: vitest 2 → 5 (+vite 8, `projects`), jsdom 29, @testing-library/*, @playwright/test 1.63 | done e837d87 |
| WP1-05 | web: ai 5 → 7 + @ai-sdk/* v4 (packages/ai on LanguageModelV4) | done 206652f |
| WP1-06 | web: @tanstack/react-query 5.103; @tanstack/react-table 9 (DataTable) | done e837d87 |
| WP1-07 | web: typescript 7.0.2 | **blocked upstream** — typescript-eslint 8.70 has no TS 7 API (typescript-eslint#10940); web stays 5.9.3, packages/* on 7.0.2. Re-try when 8.71+ ships. ESLint stays 9.x: eslint-plugin-react 7.37 peer `^9.7` (no ESLint 10). |
| WP1-08 | web: removed `next-themes`; zod 4.6, drizzle 0.45.2, hls.js, recharts, sonner, next-intl 4.14, nuqs added | done e837d87 |
| WP1-09 | web: `next build` on Turbopack — VERIFIED BUILD OK 126.7 s, 65 routes, static 6.7 MB; `build:webpack` escape hatch kept | done e837d87 |
| WP1-10 | mixai: vite 6 → 8, plugin-react 6, @tauri-apps/* 2.11.x, TS 7, drop unused framer-motion | todo |
| WP1-11 | tv-tizen: vite 7 → 8, plugin-legacy 8, plugin-react 6, hls.js latest | todo |
| WP1-12 | native: @capacitor/* 7 → 8, @tauri-apps/* 2.11.x | todo |
| WP1-13 | server: electron 34 → 44, electron-builder 26.15, better-sqlite3 13, music-metadata, drizzle-orm 0.45, vitest 5, express 5 (evaluate) | todo |
| WP1-14 | tv-android: AGP/Kotlin/Compose BOM/Media3/tv-material latest stable; `libs.versions.toml` | todo |
| WP1-15 | packages/*: align TS 7, vitest 5, ai peers | todo |
| WP1-16 | Cargo: tauri 2.11.x, plugins, mixai-core crates (cpal/symphonia/rubato) | todo |

### WP2 — apps/web
| ID | Item | Status |
|---|---|---|
| WP2-01 | `globals.src.css` now imports `@mmo/design-tokens` + `@mmo/ui/styles.css`; legacy :root/.dark/@theme removed; ThemeProvider swapped for `@mmo/ui` binding; prehydrate.js in `<head>` (no flash); dynamic theme-color | doing (hardcoded purple sweep pending) |
| WP2-02 | Settings › Appearance on shared `ThemeSettings` + `ThemePreview` (mode/accent+custom hue+artwork/surface/density/radius/motion/feedback/locale); `settings.appearance` i18n ns; LocaleSwitcher deleted | done |
| WP2-03 | App shell: `AppShell` from `@mmo/ui`, sidebar rail/expanded, mobile bottom tab bar, safe-area, `Page` container with ultra-wide rules | todo |
| WP2-04 | `loading.tsx` skeletons for every route group + `not-found.tsx` + shared `ErrorState` | todo |
| WP2-05 | Unify auth/empty states: one `NotSignedIn`/`NoCompanion`/`EmptyState` everywhere (16 pages) | todo |
| WP2-06 | Replace 7 settings stubs with real pages (daw, devices, live, mixer, notifications, security, sound-editor) | todo |
| WP2-07 | `/settings/companions` real table (DataTable) instead of JSON dump | todo |
| WP2-08 | Player bar + NowPlaying: tokens, `<Activity>`, mobile mini-player, motion presets | todo |
| WP2-09 | Route transitions with React 19.3 `<ViewTransition>`; reduced-motion guard | todo |
| WP2-10 | Responsive tables → `DataTable` with column priority collapsing (library, hidden, playlists, render-jobs, mixer settings, lora) | todo |
| WP2-11 | i18n: every hardcoded string through next-intl; nav-tree + global-search from one source; RO+EN complete | todo |
| WP2-12 | Storage keys: `mixai:` + `mmo:` prefixes now syncable (drift fix); prefs migrated from `theme`/`mmo-locale`/`mixai-ui`; `components.json` fix pending | doing |
| WP2-13 | Nav discoverability: add `/voice-wizard`, `/library/import`, `/lora/validate`, `/pair`; rename `/downloads` → `/get`; metadata title format | todo |
| WP2-14 | Fonts: single `font-sans` source, `next/font` for Inter + Space Grotesk; `theme-color` follows mode/accent | todo |
| WP2-15 | Watch: replace inline-style auth fallbacks; watch skins become surface presets on shared tokens | todo |
| WP2-16 | Perf: bundle analyze, lazy heavy widgets (dockview, recharts, hls, react-grid-layout), `"use cache"` where force-dynamic is not needed | todo |
| WP2-17 | Tests: component tests for ThemeProvider, AppShell, EmptyState, DataTable; Playwright a11y + visual smoke at 390/768/1440/3440 widths | todo |
| WP2-18 | Docs: `docs/aplicatie/settings.md`, `dashboard.md`, `03-stack-tehnologic.md`, CHANGELOG, web version bump | todo |

### WP3 — apps/mixai (Tauri desktop)
| ID | Item | Status |
|---|---|---|
| WP3-01 | Tailwind v4 + `@mmo/design-tokens`; skins (neon-glass/studio-metal/flat-pro) re-expressed as `surface` presets + deck accents | todo |
| WP3-02 | Light mode + accent + density via shared ThemeProvider; sync with cloud prefs | todo |
| WP3-03 | Replace emoji glyphs with lucide; `@mmo/ui` Button/Slider/Select/Tooltip/Sheet in Settings & TopBar | todo |
| WP3-04 | Responsive grid: min 1100 px → fluid from 1024 px, 4-deck only ≥ 1600 px, ultra-wide side panels | todo |
| WP3-05 | Skeleton/loading for decks + Library; error boundary; empty states | todo |
| WP3-06 | i18n RO/EN (shared ui messages + app messages) | todo |
| WP3-07 | Version alignment (package/tauri.conf/Cargo), docs `docs/mixai/00-…` §8 | todo |

### WP4 — apps/native (Tauri + Capacitor shell)
| ID | Item | Status |
|---|---|---|
| WP4-01 | Bootstrap page rebrand ("MixAI"), generated tokens CSS, light/dark by `prefers-color-scheme`, safe-area | todo |
| WP4-02 | Restore `AndroidManifest.xml` (leanback per ANDROID_TV.md), Capacitor 8 sync, `dist/` build script | todo |
| WP4-03 | Web app: safe-area utilities + `standalone` display detection (consumed by WP2-03) | todo |
| WP4-04 | Docs/README/version alignment | todo |

### WP5 — server/ui (Companion)
| ID | Item | Status |
|---|---|---|
| WP5-01 | Rebuild as small Vite + React app on `@mmo/ui` (auth, main, virtual-audio, updater), same preload API | todo |
| WP5-02 | Light/dark from `nativeTheme` + shared tokens; proper titlebar per OS (no double frame on Windows) | todo |
| WP5-03 | Copy: "Connect to MixAI Companion"; i18n RO/EN | todo |
| WP5-04 | Electron 44 + builder; asar includes built `ui/dist`; docs `docs/companion/README.md` | todo |

### WP6 — TV (tizen + android)
| ID | Item | Status |
|---|---|---|
| WP6-01 | tizen: generated `tokens.css`; RO/EN messages; focus ring/overscan tokens | todo |
| WP6-02 | tizen: skeleton rows, series grouping, resume, search screen, Quick Connect pairing | todo |
| WP6-03 | android: `Tokens.kt` generated; delete ~40 literal colors; `strings.xml` EN + `values-ro` | todo |
| WP6-04 | android: posters (TMDB/artwork URLs), series grouping, resume, MediaSession now-playing, settings screen | todo |
| WP6-05 | Both: shimmer skeletons, empty/error states, README for tv-android, ADR-0004 correction | todo |

### WP7 — apps/extension
| ID | Item | Status |
|---|---|---|
| WP7-01 | Generated tokens CSS; popup/options/content on brand; light/dark | todo |
| WP7-02 | Rebrand "MMO" → "MixAI" in content script/ids; popup version from manifest; `_locales` RO/EN | todo |
| WP7-03 | Adapters for the 8 missing platforms or trim host list to match; wire `audioOnly`; docs dead links | todo |

### WP8 — Verification & closure
| ID | Item | Status |
|---|---|---|
| WP8-01 | Matrix: typecheck/lint/test/build per app green (or pre-existing failures proven via HEAD worktree) | todo |
| WP8-02 | Playwright visual + axe at 4 widths, light+dark, RO+EN | todo |
| WP8-03 | design-critic pass on web shell, mixai, companion | todo |
| WP8-04 | CHANGELOG entries (web/companion/extension/tv), version bumps, ADR-0008 design system | todo |
| WP8-05 | Reality-check round with askQuestions | todo |

## 5. Recommendations beyond the brief (proposed; decide in §7)

1. **Command palette everywhere** (`cmdk` exists on web) — mixai and companion too, same shortcuts.
2. **Haptics + sound cues** on mobile/DJ actions (`navigator.vibrate`, opt-in).
3. **Keyboard-shortcut overlay** unified (`?`) across web/mixai (both have one; different).
4. **Profile-scoped themes**: each viewing profile keeps its own accent (Netflix-style).
5. **Dynamic accent from artwork** (`colorjs.io`) as an optional `accent: "artwork"` mode on NowPlaying/Watch.
6. **Offline-first shell** for the PWA via `@serwist/next` (current SW is hand-rolled).
7. **`nuqs`** for URL-state in library filters (shareable views).
8. **Storybook-less catalog**: `/dev/ui` route (dev-only) rendering every `@mmo/ui` component in all themes — cheap visual regression.
9. **OpenAPI-generated Kotlin/TS clients** for MMO Server so TV apps stop hand-writing `MmoApi.kt` (ADR-0004 promise).
10. **Web CI** (WP0-04) — currently nothing guards web except husky.

## 6. Verification matrix

| Surface | Commands | Notes |
|---|---|---|
| web | `pnpm --filter music-organizer typecheck / lint:check / test / build` via `run-build.ps1` | 13 pre-existing test failures (memory) |
| mixai | `pnpm -C apps/mixai typecheck && build` | tauri build optional |
| tv-tizen | `pnpm -C apps/tv-tizen build` + `.copilot-tmp/tizen-smoke.mjs` | |
| tv-android | `.copilot-tmp/tv-build-java.ps1` | hidden Gradle process |
| server | `pnpm -C server build && test` (Node 22 ABI) | |
| extension | `node apps/extension/scripts/check-version.mjs` + manifest lint | |
| packages | `tsc --noEmit`, vitest where present | |

## 7. Added scope from round 2 (D13)

| ID | Item | Status |
|---|---|---|
| WP9-01 | `/dev/ui` catalog route (dev-only) rendering every `@mmo/ui` component × mode × surface × accent | todo |
| WP9-02 | Unified command palette + shortcuts registry (`@mmo/ui/command`) on web, mixai, companion | todo |
| WP9-03 | `nuqs` URL state for library/playlists filters | todo |
| WP9-04 | Haptics (`useHaptics`) + sound cues (opt-in pref `feedback`) | todo |
| WP9-05 | `@serwist/next` replaces hand-rolled SW; offline shell | todo |
| WP9-06 | OpenAPI spec for MMO Server (`server/openapi.yaml`) + generated TS (`@mmo/sdk`) and Kotlin (tv-android) clients | todo |
| WP9-07 | server: express 4 → 5 | todo |
