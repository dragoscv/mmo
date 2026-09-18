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
| D15 | Media Home location | `/` becomes **Media Home** (Watch rows + Listen rows); music dashboard moves to `/dashboard` | 2026-09-18 |
| D16 | Multi-server | aggregated by default across all paired MMO Servers, dedupe by TMDB id, per-server chips + unreachable state | 2026-09-18 |
| D17 | Recommendation brain | **MMO Server** owns TMDB client + cache (SQLite) + recs; web/TV consume `/media/*`; history synced server↔web | 2026-09-18 |
| D18 | Exact deep links | **Movie of the Night** Streaming Availability (free 1k/mo, RO, commercial OK) cached 7 d → fallback TMDB watch/providers → provider search URL; **no** JustWatch GraphQL | 2026-09-18 |
| D19 | Trakt | dropped — own history/watchlist/ratings model + own sync; existing scrobble stays env-gated no-op | 2026-09-18 |
| D20 | Pirate embeds | **remove** `streaming-scrapers.ts`, `/video/streams`, `StreamSourcePicker`, vidsrc flag (ADR-0009) | 2026-09-18 |
| D21 | Shared progress | TVs read/write progress via MMO Server → web (seconds, per profile); local fallback offline; one-shot migration of local progress | 2026-09-18 |
| D22 | Listen half | full: `track_plays` table + actions, Continue listening / New albums / Favourites / Playlists aggregated, `AlbumCard` | 2026-09-18 |
| D23 | Agent config & gates | AGENTS.md + copilot-instructions + 11 instructions + 11 skills; lint-staged path-scoped gates; CI bundle/LHCI/axe/knip/lychee/actionlint; commitlint; weekly `pnpm outdated` issue | 2026-09-18 |
| D24 | Keys | user authenticates in browser (MOTN developer portal) and provides key out-of-band; all integrations no-op without key | 2026-09-18 |

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
| WP0-05 | Docs: `docs/design-system.md` (new canonical), `concept/ui-ux.md` marked historical, `03-stack-tehnologic.md` UI table, NAVIGARE links | done 3eaede0 (README pending WP8-04) |

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
| WP1-10 | mixai: vite 6 → 8, plugin-react 6, @tauri-apps/* 2.11.x, TS 7, drop unused framer-motion | done d5052fe |
| WP1-11 | tv-tizen: vite 7 → 8, plugin-legacy 8, plugin-react 6, hls.js latest | done 3ed6c09 |
| WP1-12 | native: @capacitor/* 7 → 8, @tauri-apps/* 2.11.x | done 19d0402 |
| WP1-13 | server: electron 34 → 44, electron-builder 26.15, better-sqlite3 13, music-metadata, drizzle-orm 0.45, vitest 5, express 5 (evaluate) | done da3538e |
| WP1-14 | tv-android: AGP/Kotlin/Compose BOM/Media3/tv-material latest stable; `libs.versions.toml` | done 3ed6c09 |
| WP1-15 | packages/*: align TS 7, vitest 5, ai peers | done 4ecdca0 |
| WP1-16 | Cargo: tauri 2.11.x, plugins, mixai-core crates (cpal/symphonia/rubato) | done 4ecdca0 |

### WP2 — apps/web
| ID | Item | Status |
|---|---|---|
| WP2-01 | `globals.src.css` imports `@mmo/design-tokens` + `@mmo/ui/styles.css`; ThemeProvider = `@mmo/ui` binding; prehydrate.js (no flash); React dedupe for path-aliased packages | done 3eaede0 — hardcoded purple sweep (26 sites) tracked under WP2-08/WP2-15 |
| WP2-02 | Settings › Appearance on shared `ThemeSettings` + `ThemePreview` (mode/accent+custom hue+artwork/surface/density/radius/motion/feedback/locale); `settings.appearance` i18n ns; LocaleSwitcher deleted | done |
| WP2-03 | App shell: `AppShell` from `@mmo/ui`, sidebar rail/expanded, mobile bottom tab bar, safe-area, `Page` container with ultra-wide rules | done 5d7fdf8 |
| WP2-04 | 47 `loading.tsx` (9 skeleton families in `route-skeletons.tsx`) + `not-found.tsx` + `error.tsx` on `ErrorState` | done 3eaede0 |
| WP2-05 | 12 pages moved to `notSignedInFor(featureKey)` (14 new keys RO+EN); NotSignedIn/NoCompanion on `EmptyState` | done 3eaede0 |
| WP2-06 | Replace 7 settings stubs with real pages (daw, devices, live, mixer, notifications, security, sound-editor) | done 5d7fdf8 |
| WP2-07 | `/settings/companions` real table (DataTable) instead of JSON dump | done 5d7fdf8 |
| WP2-08 | Player bar + NowPlaying: tokens, `<Activity>`, mobile mini-player, motion presets | done (uncommitted) — `surface` bar, `rise`/`fade` on track change, 56px mini-player + `player-height.css`, NowPlaying in `<Activity>`, artwork-accent hue via `dominantHueFromImage`, canvas paint via `themeColor()` |
| WP2-09 | Route transitions with React 19.3 `<ViewTransition>`; reduced-motion guard | done (uncommitted) — `src/app/template.tsx` + `view-transitions.css` (`mixai-page` class, `--dur-page`, reduced-motion → none); watch named morphs untouched |
| WP2-10 | Responsive tables → `DataTable` with column priority collapsing (library, hidden, playlists, render-jobs, mixer settings, lora) | done 4bd3530 |
| WP2-11 | i18n: every hardcoded string through next-intl; nav-tree + global-search from one source; RO+EN complete | done 4bd3530 |
| WP2-12 | Storage keys: `mixai:` + `mmo:` prefixes now syncable (drift fix); prefs migrated from `theme`/`mmo-locale`/`mixai-ui`; `components.json` fixed (4bd3530) | done 3eaede0 + 4bd3530 (components.json → globals.src.css) |
| WP2-13 | Nav discoverability: add `/voice-wizard`, `/library/import`, `/lora/validate`, `/pair`; rename `/downloads` → `/get`; metadata title format | done 4bd3530 |
| WP2-14 | Fonts: single `font-sans` source, `next/font` for Inter + Space Grotesk; `theme-color` follows mode/accent | done 4bd3530 |
| WP2-15 | Watch: replace inline-style auth fallbacks; watch skins become surface presets on shared tokens | done (uncommitted) — skins reduced to `--watch-h` + shape knobs over tokens (netflix 25 / plex 75 / disney 250 / hbo 285 / mmo `--accent-h`); inline paddings → Tailwind; `error.tsx` → `ErrorState`; brand hex out of cinematic/tv-mode CSS |
| WP2-16 | Perf: bundle analyze, lazy heavy widgets (dockview, recharts, hls, react-grid-layout), `"use cache"` where force-dynamic is not needed | done 1d7ea4f |
| WP2-17 | Tests: component tests for ThemeProvider, AppShell, EmptyState, DataTable; Playwright a11y + visual smoke at 390/768/1440/3440 widths | done ee81854 |
| WP2-18 | Docs: `docs/aplicatie/settings.md`, `dashboard.md`, `03-stack-tehnologic.md`, CHANGELOG, web version bump | done 85a8bc3 |

### WP3 — apps/mixai (Tauri desktop)
| ID | Item | Status |
|---|---|---|
| WP3-01 | Tailwind v4 + `@mmo/design-tokens`; skins (neon-glass/studio-metal/flat-pro) re-expressed as `surface` presets + deck accents | done d5052fe |
| WP3-02 | Light mode + accent + density via shared ThemeProvider; sync with cloud prefs | done d5052fe |
| WP3-03 | Replace emoji glyphs with lucide; `@mmo/ui` Button/Slider/Select/Tooltip/Sheet in Settings & TopBar | done d5052fe |
| WP3-04 | Responsive grid: min 1100 px → fluid from 1024 px, 4-deck only ≥ 1600 px, ultra-wide side panels | done d5052fe |
| WP3-05 | Skeleton/loading for decks + Library; error boundary; empty states | done d5052fe |
| WP3-06 | i18n RO/EN (shared ui messages + app messages) | done d5052fe |
| WP3-07 | Version alignment (package/tauri.conf/Cargo), docs `docs/mixai/00-…` §8 | done d5052fe |

### WP4 — apps/native (Tauri + Capacitor shell)
| ID | Item | Status |
|---|---|---|
| WP4-01 | Bootstrap page rebrand ("MixAI"), generated tokens CSS, light/dark by `prefers-color-scheme`, safe-area | done 19d0402 |
| WP4-02 | Restore `AndroidManifest.xml` (leanback per ANDROID_TV.md), Capacitor 8 sync, `dist/` build script | done 19d0402 |
| WP4-03 | Web app: safe-area utilities + `standalone` display detection (consumed by WP2-03) | done 70b637f |
| WP4-04 | Docs/README/version alignment | done 19d0402 |

### WP5 — server/ui (Companion)
| ID | Item | Status |
|---|---|---|
| WP5-01 | Rebuild as small Vite + React app on `@mmo/ui` (auth, main, virtual-audio, updater), same preload API | done cdff3ea |
| WP5-02 | Light/dark from `nativeTheme` + shared tokens; proper titlebar per OS (no double frame on Windows) | done cdff3ea |
| WP5-03 | Copy: "Connect to MixAI Companion"; i18n RO/EN | done cdff3ea |
| WP5-04 | Electron 44 + builder; asar includes built `ui/dist`; docs `docs/companion/README.md` | done 3fa73f2 |

### WP6 — TV (tizen + android)
| ID | Item | Status |
|---|---|---|
| WP6-01 | tizen: generated `tokens.css`; RO/EN messages; focus ring/overscan tokens | done 3ed6c09 |
| WP6-02 | tizen: skeleton rows, series grouping, resume, search screen, Quick Connect pairing | done 3ed6c09 |
| WP6-03 | android: `Tokens.kt` generated; delete ~40 literal colors; `strings.xml` EN + `values-ro` | done 3ed6c09 |
| WP6-04 | android: posters (TMDB/artwork URLs), series grouping, resume, MediaSession now-playing, settings screen | done 3ed6c09 |
| WP6-05 | Both: shimmer skeletons, empty/error states, README for tv-android, ADR-0004 correction | done 3ed6c09 |

### WP7 — apps/extension
| ID | Item | Status |
|---|---|---|
| WP7-01 | Generated tokens CSS; popup/options/content on brand; light/dark | done 19d0402 |
| WP7-02 | Rebrand "MMO" → "MixAI" in content script/ids; popup version from manifest; `_locales` RO/EN | done 19d0402 |
| WP7-03 | Adapters for the 8 missing platforms or trim host list to match; wire `audioOnly`; docs dead links | done 19d0402 |

### WP8 — Verification & closure
| ID | Item | Status |
|---|---|---|
| WP8-01 | Matrix: typecheck/lint/test/build per app green (or pre-existing failures proven via HEAD worktree) | done matrix 22/22 green (.copilot-tmp/matrix.log) |
| WP8-02 | Playwright visual + axe at 4 widths, light+dark, RO+EN | done ee81854 |
| WP8-03 | design-critic pass on web shell, mixai, companion | done docs/followups/design-critic-2026-09-18.md (42–47/60, 5 prescriptions) |
| WP8-04 | CHANGELOG entries (web/companion/extension/tv), version bumps, ADR-0008 design system | done 85a8bc3 (CHANGELOGs, ADR-0008, versions: web 2.0.0, companion 3.0.0, extension 3.0.0, mixai/native/tv 1.0.0) |
| WP8-05 | Reality-check round with askQuestions | done round 3 answered 2026-09-18 (apply 5 Rx, code-split mixai+companion, no push yet) |

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
| WP9-01 | `/dev/ui` catalog route (dev-only) rendering every `@mmo/ui` component × mode × surface × accent | done 5cdc24b |
| WP9-02 | Unified command palette + shortcuts registry (`@mmo/ui/command`) on web, mixai, companion | done 5cdc24b |
| WP9-03 | `nuqs` URL state for library/playlists filters | done 4bd3530 |
| WP9-04 | Haptics (`useHaptics`) + sound cues (opt-in pref `feedback`) | done 4bd3530 |
| WP9-05 | `@serwist/next` replaces hand-rolled SW; offline shell | done 95ef92c |
| WP9-06 | OpenAPI spec for MMO Server (`server/openapi.yaml`) + generated TS (`@mmo/sdk`) and Kotlin (tv-android) clients | done |
| WP9-07 | server: express 4 → 5 | done da3538e |

## 8. Follow-ups

- **WP1-07 — Weekly (Mondays):** retry `typescript@7` on apps/web once typescript-eslint ≥ 8.71 / TS7-capable ships (typescript-eslint#10940), and `eslint@10` once eslint-plugin-react peer allows it; command: `pnpm outdated typescript eslint typescript-eslint eslint-plugin-react` in apps/web. Owner: agent, next check 2026-09-21.

---

## 9. Media Home — research summary (verified 2026-09-18)

- **Web** `/watch/*` already has: TMDB client (`lib/tmdb.ts`, key `TMDB_API_KEY`, 1 h fetch cache), `tmdbWatchProviders(Multi)` + `ExternalProvidersRow` (logos only), `video-recommendations.ts`, `up-next.ts`, `watch-prefs.ts` (`regions ["RO","US"]`, `localOnly`, `hideWatched`), `watch_history` per **profile** (`completed` at >90 %), `PosterRow`/`PosterCard`, `discover/{movie,tv}/[id]` for non-owned titles. Every video path uses **one** `getCompanionLink()`; `aggregateAcrossCompanions` exists but only music uses it. `video_files.device_id` set from an arbitrary first `companion_devices` row. No companion fileId stored → `/video/lookup?path=` at play.
- **Two device tables**: `devices` (urls, token, tunnel) vs `companion_devices` (FK target of `video_files`) bridged by `machine_id = devices.id`.
- **Server**: no video DB, no TMDB API key, no progress, no etag; `POST /video/scan` is the only list (synchronous ffprobe). `tmdb-cache.ts` = images only. `streaming-scrapers.ts` = pirate embed URL builder (flag OFF) → remove (D20).
- **TVs**: single server each, local progress (Android ms / Tizen s), zero deep-link code; tv-android has no `<queries>`; tizen lacks `application.launch` privilege. Both proxy TMDB images through the server.
- **Music**: no server-side play history (localStorage only), no album grouping/card, playlists via single companion.
- **External APIs**: TMDB ~40 req/s, `append_to_response` (≤20); providers `link` = TMDB→JustWatch page (attribution required). MOTN v4 `GET /shows/movie/{tmdbId}?country=ro` → `streamingOptions.ro[].{service,type,link}`, free 1 000 req/mo. Trakt needs VIP to register apps → dropped (D19).
- **Deep links**: web URL / Android package + `ACTION_VIEW`+`setPackage` (`<queries>`) / Tizen `launchAppControl(view,url,PAYLOAD)` + `getAppInfo`. Full table in `docs/aplicatie/media-home.md`.
- **Agent config**: repo has NO `.github/copilot-instructions.md`, instructions or skills; husky bumps only web/extension; LHCI/axe/OpenAPI/i18n gates exist as scripts but are not wired.

## 10. Media Home — architecture

```
 web (Next 16) ──/media/* (device token)──▶ MMO Server A ──▶ TMDB / MOTN (keys on server, SQLite cache)
   │  fan-out to N servers, dedupe by tmdbId  │ media.sqlite: titles, providers, recs, progress, plays, library etag
   │  chips per server                        ◀── TV Android / Tizen (same /media/*; native intents)
   └──▶ Postgres (profiles, history mirror, track_plays, prefs) ◀── sync: server → web on change + hourly
```
- Server `media` module (`server/src/media/`): `tmdb.ts` (bearer, limiter, `append_to_response`), `availability.ts` (MOTN → TMDB providers → search URL; `providers.ts` registry with web/android/tizen launch data), `recs.ts` (profile vector from watched/ratings; RRF over TMDB recs of last 15; WR prior; exclude watched/owned/dismissed; ≤2 per collection; cold-start trending RO), `progress.ts`, `library.ts` (video index + etag), `routes.ts`. TTLs: details/images 30 d, recs 24 h, providers 24 h, MOTN 7 d, trending 6 h.
- Web: `/` = `MediaHome` RSC → fan-out via `aggregateAcrossCompanions`, merge by `tmdbId` with `sources[]`; `HeroBillboard` + `MediaRow` (embla, keyboard/D-pad, virtualised >40) + Listen rows; `/media/[kind]/[tmdbId]` unified title page (Play on <server> if local, else provider deep links); `/dashboard` = old page. Codai curator optional.
- TVs: same JSON; Android `ProviderLauncher` (`<queries>`, fallback), Watch Next channel; Tizen `launch.ts` (`launchAppControl`, `getAppInfo`); progress via `/media/progress` with local fallback queue.

## 11. Media Home — work packages

### WP10 — Server media module
| ID | Item | Status |
|---|---|---|
| WP10-01 | `server/src/media/` scaffold: SQLite `media.sqlite` (titles/providers/recs_cache/progress/track_plays/library_index), env `TMDB_API_KEY`, `MOTN_API_KEY`, `MEDIA_REGION`=RO; no-op without keys | todo |
| WP10-02 | TMDB client with limiter + `append_to_response`; trending/popular/discover(watch_region) | todo |
| WP10-03 | Availability resolver: MOTN v4 (7 d) → TMDB providers (24 h) → registry search URLs; registry (Netflix, Disney+, HBO Max, Prime, Apple TV+, SkyShowtime, Voyo, AntenaPlay, YouTube, Google TV) with web/android/tizen launch data | todo |
| WP10-04 | Recs engine + rows builder (Continue, Top picks, Because you watched ×3, Trending RO on your providers, Upcoming RO, New in library) 24 h cache | todo |
| WP10-05 | Video library index with etag (scan + watcher), `GET /media/library?since=`, server returns `serverId` for attribution | done (`media/library.ts` + `library-hooks.ts`; fed by `/video/scan`, scan jobs and the watcher; tombstones for deltas; `matchTitle` cached TMDB search; `serverId`/`serverName` on home/title/library/status) |
| WP10-06 | Progress + plays API (`/media/progress` GET/PUT seconds per profile; `/media/plays`) + push sync to web `/api/media/sync` | done (`media/sync-client.ts`: 10 s debounce, hourly full push, `meta.last_pushed_revision`, Bearer device token, 404/offline retry, 401 pause; `GET /media/progress?since=<rev>`; `PUT` batch 1..500) — web endpoint `/api/media/sync` still to be built (WP11) |
| WP10-07 | Routes `/media/home`, `/media/title/:kind/:id`, `/media/search`, `/media/etag`; OpenAPI + `openapi:check` + Kotlin/SDK regen; server 3.1.0 | done (mounted `/media` behind `authMiddleware` incl. `/media/status`; 11 routes in `openapi.yaml`, `MOUNTS` entry, `openapi:check` OK 194/194, Models.kt +20 classes, `mmo-server.d.ts` regenerated; `media.*` in `/video/probe` capabilities) |
| WP10-08 | Remove pirate embeds (D20): streaming-scrapers, `/video/streams`, vidsrc flag, web `StreamSourcePicker`; ADR-0009 | done (server 3.1.0, ADR-0009) |
| WP10-09 | Tests: recs scoring, availability chain, progress upsert, routes (vitest, Node 22) | done (7 files / 51 tests under `src/media`: library upsert/prune/etag/delta, TMDB match cache, sync client 200/404/offline/401/debounce, routes `/library?since`, batch progress, `/status` shape, v1→v2 migration; whole server suite 146/146) |

### WP11 — Web Media Home
| ID | Item | Status |
|---|---|---|
| WP11-01 | Move dashboard to `/dashboard` (nav-tree, TAB_KEYS, i18n, tests, revalidate paths, palette) — `/` = `MediaHome` placeholder + `MediaHomeSkeleton`; `nav.home` first leaf, TAB_KEYS `home/library/watch/music` | done |
| WP11-02 | `lib/media/aggregate.ts` fan-out + merge by tmdbId → `sources[]`, per-server status; DB migration `track_plays` + `media_sync_state` (expand-only) — `drizzle/0030_media_home.sql` (NOT yet applied to prod), `actions/track-plays.ts`, `lib/play-recorder.ts` wired into `player-context` (end / ≥90 % / switch, debounced) | done |
| WP11-03 | `/` MediaHome RSC: `HeroBillboard` (backdrop + logo treatment, artwork accent), `MediaRow` (embla 8.6, keyboard, capped at 40 + "See all" instead of a virtualiser), server chips (nuqs `?servers=`), `loading.tsx`, empty/no-server states, ultrawide layout (hero clamps 1600 px) | done 20cf5e8 |
| WP11-04 | Title page `/media/[kind]/[tmdbId]`: local sources per server (`/watch/play/<cid>?server=&cid=`), provider buttons (deep link / search fallback, attribution), trailer, similar, watchlist, mark watched, hide; redirects from `/watch/discover/*` | done 20cf5e8 |
| WP11-05 | Listen rows: `track_plays` recording, Continue listening, New albums (album grouping), Favourites, Playlists aggregated, `AlbumCard`; localStorage history migrated once | todo |
| WP11-06 | Settings › Media: region, preferred providers, hide watched, curator toggle; Settings › Video merged | todo |
| WP11-07 | Codai curator (env-gated): row titles + one-line "why", 24 h cache | todo |
| WP11-08 | i18n RO+EN for new strings + sweep hardcoded RO in watch pages; a11y (rows role=list, focus, reduced motion) | todo |
| WP11-09 | Tests: aggregate merge, row builders, title page states; e2e home at 4 widths light/dark | todo |

### WP12 — TV apps
| ID | Item | Status |
|---|---|---|
| WP12-01 | tv-android: `MediaRepository` on `/media/*`, hero + rows, title screen with provider buttons, `ProviderLauncher` + `<queries>`, Watch Next, progress via server + local fallback; RO/EN | todo |
| WP12-02 | tv-tizen: `/media/*` client, hero + rows, title screen, `launch.ts` (`launchAppControl`, `getAppInfo`, privilege), progress via server | todo |
| WP12-03 | Device verification: Google TV 192.168.100.31 + Odyssey 192.168.100.135 — open Netflix/YouTube from a title, progress round-trip web↔TV | todo |

### WP13 — Agent config & gates (D23)
| ID | Item | Status |
|---|---|---|
| WP13-01 | `AGENTS.md`, `.github/copilot-instructions.md`, 11 `.github/instructions/*.instructions.md` | todo |
| WP13-02 | 11 `.github/skills/*/SKILL.md` | todo |
| WP13-03 | Scripts promoted: `scripts/tracker-regen-csv.mjs`, `apps/web/scripts/i18n-parity.mjs`, `apps/web/scripts/bundle-budget.mjs`, `scripts/hex-gate.mjs`; tokens mirror list += mixai/server prehydrate | todo |
| WP13-04 | Husky `prepare` + lint-staged path-scoped gates (i18n, tokens, OpenAPI, hex/Color(0x), tracker csv, version bumps server/packages) + commitlint | done — root `lint-staged` config, `scripts/{check-version-generic,tokens-drift,tracker-drift}.mjs`, `commitlint.config.mjs`, `.husky/commit-msg` |
| WP13-05 | CI: `server-ci.yml`, web-ci += bundle budget/LHCI/axe/knip, `docs-ci.yml` lychee, actionlint, `deps-weekly.yml` | done — actionlint clean locally; first CI run pending push |
| WP13-06 | Mutation-test every gate (break → red → restore) → `docs/arhitectura/gates.md` | doing — commitlint, hex `--staged`, version-generic verified; rest pending in gates.md |

### WP14 — Closure
| ID | Item | Status |
|---|---|---|
| WP14-01 | Matrix green; design-critic on Media Home; CHANGELOGs; versions web 2.1.0, server 3.1.0, tv 1.1.0; ADR-0009 + ADR-0010 | todo |
| WP14-02 | Round 4 askQuestions reality check | todo |
