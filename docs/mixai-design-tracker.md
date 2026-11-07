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
| D25 | WP16 order + look | TV Android → Tizen → web; **cinematic backdrop-first** (Apple TV / Infuse): full-bleed backdrop follows focus, logo treatment, glass OSD; own library before recommendations | 2026-11-04 |
| D26 | Profiles | "Who's watching" on every surface, optional 4-digit PIN (scrypt hash), kids profile with max age (0/12/14/15/18) mapped from TMDB certifications (RO CNC → age); **owned by MMO Server** (`media.sqlite`), web mirrors `/media/profiles` — no PROD migration | 2026-11-04 |
| D27 | Music on TV | full: library (albums/artists/playlists/genres), artist + album pages, queue, synced lyrics (LRCLIB cached on server), background playback (Android `MediaSessionService`) | 2026-11-04 |
| D28 | Live TV | **native server module `server/src/livetv`**: M3U(+XMLTV), Xtream Codes, HDHomeRun sources added by the user; EPG grid, fast zapping, catch-up (Xtream archive), DVR with `-c copy` (never re-encode). We ship no channel lists. RO channels from our own IPTV server = separate repo, out of WP16 | 2026-11-04 |
| D29 | Sync + hub | progress + watchlist + profile prefs on MMO Server, TV profile id unified; **authenticated WS hub `/hub`** (LAN + tunnel): device registry, remote control / play-on-TV from web, Watch Together with SyncPlay-style clock sync (lowest-RTT + EMA, scheduled commands, rate/seek drift correction), chat + reactions | 2026-11-04 |
| D30 | TV Android nav | own stack + `SaveableStateHolder` + `AnimatedContent` + `SharedTransitionLayout` (no Navigation Compose) | 2026-11-04 |
| D31 | Web | unify on `/media`: search, browse, season/episode, profile gate, now playing, live TV; `/watch/*` redirects; legacy player features (skip, party, cast, bookmarks) kept, restyled with tokens | 2026-11-04 |
| D32 | Extra ideas (all in) | hero muted trailer after 3 s focus; ambient screensaver; auto collections/franchises + "Surprise me"; voice search (Android) + phone keyboard via remote; versions picker; sleep timer + "still watching?"; global Continue (video+episodes+music+recordings) + customisable nav; year-in-review stats; PWA offline downloads | 2026-11-04 |
| D33 | Cadence | small vertical slices, each committed with version bump + CHANGELOG and device-verified | 2026-11-04 |
| D34 | Phone apps | **native**: Kotlin/Compose Android phone app reusing tv-android's data layer (shared module) + SwiftUI iOS app; verified on S25 + iPhone 17 Pro Max; published to **production 100 %** on Play + App Store (owner, 2026-11-06). Feature set/new ideas decided in a research round (WP16-45) | 2026-11-06 |
| D35 | Web home + live check | `/` → `/media` (classic fan-out on `/?classic=1`); live web e2e runs on a cloud VM with a tunnel to the companion; a 2 h prod session row may be minted + deleted for it | 2026-11-06 |
| D36 | Phone architecture (WP16-45 round 1+2) | Android: `:core` library inside the tv-android Gradle build (data layer, packages kept `ro.mixai.tv.data*`), phone app at `apps/phone-android/app` included via `projectDir`, id **`ro.mixai.app`** (native replaces the Capacitor shell in stores), minSdk 31, Material 3 Expressive. iOS: SwiftUI, iOS 26, XcodeGen + local SPM `MixaiCore`, models from `server/scripts/openapi-swift.mjs` (Codable, CI drift check), AVPlayer on server HLS `-c copy` + VLCKit fallback for containers AVPlayer refuses; builds on vmui-mac via the codai `ios-build.ps1` pattern, install via TestFlight / iphone-bridge | 2026-11-05 |
| D37 | Phone platform scope | profiles, home, browse, title, player (gestures, PiP, background audio, Cast + AirPlay, Play on TV, Watch Together with chat **report/block/filter**), music + lyrics, Live TV (user-added sources only + legal notice), downloads (Android original file; iOS server remux to MP4 `-c copy`), phone-as-TV-remote, widgets + Live Activities/Live Updates, push (companion → mixai.ro relay → FCM v1 + APNs; push-token migration **asked before prod**), Android Auto + CarPlay (audio entitlement requested), App Intents/shortcuts, tablet/iPad layouts, Sentry (explicit `dataCollection`, no PII); sign-in = MixAI account (+ **Sign in with Apple**: Auth.js Apple provider + native token exchange) + LAN discovery + Quick Connect | 2026-11-05 |
| D38 | Phone v1 ideas (all in) | smart downloads (next 3 episodes on Wi-Fi + charging, auto-delete watched), offline-first progress queue, phone ↔ TV handoff mid-scene, player gestures + night mode/dialogue boost, fading sleep timer (end of episode/chapter), "original only on Wi-Fi" data saver, dual subtitles, search inside subtitles → jump, Plex importer, karaoke lyrics + translation line, family stats + kids screen-time caps, Wear OS / Apple Watch remote + now playing, household scene bookmarks | 2026-11-05 |
| D39 | Stores + reviewers | Play = owner's **existing personal** developer account (12 testers × 14 days closed test may gate production — checked in Console), ASC team S6D533QSV2; owner only signs in, agent drives the consoles in the integrated browser; public **demo server** on GCE e2-small europe-central2 (`demo.mixai.ro`, Blender open films + CC music, legal looping demo channel, reviewer account); no "IPTV" wording or channel brands in listings | 2026-11-05 |
| D40 | Product family (ADR-0013) | **MixAI** umbrella (mixai.ro) · **MixAI Server** · **MixAI TV** (watching, every OS + store) · **MixAI Music** (separate listening app, every platform) · **MixAI Studio** (organizer, app.mixai.ro) · **MixAI DJ** · **MixAI Connector** (extension) | 2026-11-06 |
| D41 | Domains | one Cloud Run web service, host routing in `proxy.ts`: mixai.ro = suite landing + launcher, tv.mixai.ro = MixAI TV (`/media` at `/`), music.mixai.ro = MixAI Music, app.mixai.ro = Studio, dj.mixai.ro = DJ landing; session cookie on `.mixai.ro`; old paths 308; run.app unchanged until store builds move | 2026-11-06 |
| D42 | App IDs | published IDs never change: phones keep `ro.mixai.app` renamed **MixAI TV** at the next update (after iOS 1.1.0 approval); tvOS = target of the same App Store record; desktop TV `ro.mixai.tv.desktop`; Music `ro.mixai.music`; `apps/native` → `ro.mixai.studio` | 2026-11-06 |
| D43 | MixAI TV platforms | Android TV/Google TV, Fire TV, Samsung Tizen, LG webOS, Apple TV, Windows (MS Store), macOS (Mac App Store + DMG), Linux (Flathub), web PWA, Android + iOS/iPadOS; Roku out of scope | 2026-11-06 |
| D44 | Desktop tech | Tauri 2 reusing the MixAI TV web UI as a static SPA, LAN via `tauri-plugin-http`; MS Store = **MSIX** (store-signed, `privateNetworkClientServer`); Mac App Store pkg (sandbox network.client); Flathub (GNOME runtime, offline sources) | 2026-11-06 |
| D45 | Store order | build every package; submit first to low-risk stores (Microsoft, Apple tvOS/Mac, Flathub, Play TV, Amazon); Samsung Partner + LG seller applications in parallel; Live TV always "your own server / your own M3U", review notes → demo.mixai.ro | 2026-11-06 |
| D46 | LG webOS | `apps/tv-tizen` becomes TV-web with a `platform/` adapter (tizen \| webos \| browser): keys, app control, network, model, codec caps; packages `.wgt` + `.ipk` | 2026-11-06 |
| D47 | Music scope | MixAI Music separate on every platform from now (owner); MixAI TV keeps a light music entry that deep-links to Music when installed | 2026-11-06 |
| D48 | New ideas (in) | AI "Ce vedem diseară?" concierge · AI RO subtitles (Whisper + translation) · "Previously on" recap · natural-language search · RO EPG pack + legal free channels (TVR+, Arte) · skip intro/credits markers + trickplay · Google TV Engage SDK · MixAI Dash (server health + push) · Family Hub (time limits, kids PIN) · Party DJ mode · Smart DVR (ad detection, AI chapters) · Simkl/Letterboxd sync · Home Assistant scenes | 2026-11-06 |
| D49 | Idea backlog (later) | AI Romanian dubbing for kids content (owner: not now, remember) | 2026-11-06 |
| D50 | MixAI Music Android shape | separate app module `:music` (`apps/music-android`, `ro.mixai.music`) + shared `:music-ui` library extracted from `:phone` (MusicDeps interface, no AppDeps/nav/R coupling); NOT a flavor (owner after research: Plex/Plexamp, Jellyfin/Finamp ship separate apps; Auto/Wear review per app; a flavor would carry Cast/PiP/FCM/video). v1 = Media3 MediaLibraryService (Android Auto + Assistant voice, empty query starts a mix), offline track downloads (manual + next N, Wi-Fi only, cap), radio + BPM/key + synced lyrics + queue sync, gapless + ReplayGain + crossfade, Glance widget, Wear OS standalone, Chromecast/DLNA. Play: app record + internal test, then closed test (12×14 rule) | 2026-11-06 |
| D51 | MixAI Music iOS + TV handoff | separate App Store app `MixAIMusic` (`ro.mixai.music`), shared Swift package for MusicPlayer/MusicViews; CarPlay audio entitlement requested as soon as the App ID exists; MixAI TV opens Music when installed (`mixai-music://`, Android `<queries>`), otherwise its built-in player; Tizen/webOS keep the built-in player | 2026-11-06 |
| D52 | MixAI Music shared Android code | new `:mobile-common` library (brand theme + tokens + fonts, QR, server connect: discovery / Quick Connect / manual, MixAI account sign-in incl. Google) used by `:phone` and `:music`; Music v1 offers account sign-in like the phone (owner 2026-11-07) | 2026-11-07 |

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

### 6.1 Media Home closure run (WP14-01, 2026-09-18, logs `.copilot-tmp/wp14-*.log`)

| Command | Exit | Result |
|---|---|---|
| web `pnpm exec tsc --noEmit` | 0 | clean (TS5097 from other agents' WIP filtered) |
| web `vitest run --maxWorkers=2` | 1 | 50 files / 447 tests: **446 passed, 1 failed** — `url-guard.test.ts` "rejects private hosts in production" (pre-existing, in the known 13; the other 12 are now green) |
| web `node scripts/i18n-parity.mjs` | 0 | RO/EN parity OK |
| web `node scripts/lint-baseline.mjs check` | 0 | no new problems vs baseline |
| web `run-build.ps1 -Command 'pnpm --filter music-organizer build' -Wait` | 0 | Turbopack + serwist |
| web `bundle-budget.mjs --check apps/web/.next` | 0 | 72 routes, 3 new (`/`, `/media/[kind]/[tmdbId]`, `/settings/media`), all ≤ budget; typical +5.7 kB shared chunk |
| server `pnpm build:headless` (tsc, Node 22.23.2) | 0 | |
| server `pnpm ui:typecheck` | 0 | |
| server `vitest run` | 1 → 0 | 18 files / 146 tests: `metrics.test.ts` timed out at 5 s under the parallel matrix load; re-run alone 2/2 passed (6.3 s) — load, not a regression |
| server `openapi-check.mjs` | 0 | 194/194 routes, no drift |
| `pnpm -C apps/tv-tizen typecheck` / `build` | 0 / 0 | built in 26 s |
| tv-android `assembleDebug` (hidden Gradle) | 0 | |
| `pnpm -C packages/ui typecheck` / vitest | 0 / 0 | 8 files / 46 tests |
| `pnpm -C packages/design-tokens build` + `tokens-drift.mjs` | 0 / 0 | mirrors match |
| `node scripts/hex-gate.mjs` | 0 | 0 hits |
| `node scripts/tracker-drift.mjs` | 1 → 0 | stale only because this item edits the tracker; CSV regenerated in the same commit |
| Versions | — | web 2.2.0 · server 3.1.0 · tv-android 1.1.0 (versionCode 3) · tv-tizen 1.1.0 · extension 3.0.1 · `@mmo/sdk` 0.1.0 · `@mmo/ui` 1.0.0 · `@mmo/design-tokens` 1.0.0 |

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
| WP10-01 | `server/src/media/` scaffold: SQLite `media.sqlite` (titles/providers/recs_cache/progress/track_plays/library_index), env `TMDB_API_KEY`, `MOTN_API_KEY`, `MEDIA_REGION`=RO; no-op without keys | done 5e2af4b |
| WP10-02 | TMDB client with limiter + `append_to_response`; trending/popular/discover(watch_region) | done 5e2af4b |
| WP10-03 | Availability resolver: MOTN v4 (7 d) → TMDB providers (24 h) → registry search URLs; registry (Netflix, Disney+, HBO Max, Prime, Apple TV+, SkyShowtime, Voyo, AntenaPlay, YouTube, Google TV) with web/android/tizen launch data | done 5e2af4b |
| WP10-04 | Recs engine + rows builder (Continue, Top picks, Because you watched ×3, Trending RO on your providers, Upcoming RO, New in library) 24 h cache | done 5e2af4b |
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
| WP11-05 | Listen rows: `track_plays` recording, Continue listening, New albums (album grouping), Favourites, Playlists aggregated, `AlbumCard`; localStorage history migrated once | done 5e5f2b8 |
| WP11-06 | Settings › Media: region, preferred providers, hide watched, curator toggle; Settings › Video merged | done 5e5f2b8 |
| WP11-07 | Codai curator (env-gated): `lib/media/curator.ts` (`generateObject` + zod, `codai-fast`, 6 s, 24 h `unstable_cache` per user/profile/region/rows hash), `CuratorNote` under the hero; `/media/home?providers=` from prefs + preferred-first offers with badge; `POST/GET /api/media/sync` (device bearer → `watch_history`/`track_plays`/`media_sync_state`) | done |
| WP11-08 | i18n RO+EN for new strings + sweep hardcoded RO in `/watch/**` + `components/video/**` → `watch.*` keys (parity strict); a11y: rows `role=list` (verified), `aria-live` server notices, focus-visible on curator links, hero reduced motion (verified) | done |
| WP11-09 | Tests: `sync-map`, `curator` (success/timeout/invalid JSON), preferred ordering (vitest); `e2e/media-home.spec.ts` (anon landing; signed-in hero+rows 390/1440/3440 light+dark + axe on `/` and `/media/movie/550` behind `E2E_SESSION_COOKIE`); `a11y.spec.ts` + `/media/movie/550` | done |

### WP12 — TV apps
| ID | Item | Status |
|---|---|---|
| WP12-01 | tv-android: `MediaRepository` on `/media/*`, hero + rows, title screen with provider buttons, `ProviderLauncher` + `<queries>`, Watch Next, progress via server + local fallback; RO/EN | done (1.1.0: `data/{MediaRepository,ProgressSync,ProviderLauncher,WatchNext}.kt`, `ui/{MediaRows,TitleScreen}.kt`, Home hero + server rows with `/video/scan` fallback, `tvprovider` 1.1.0 + `mixai://title/…` deep link, legacy progress migrated once; watchlist button omitted on TV — web only) |
| WP12-02 | tv-tizen: `/media/*` client, hero + rows, title screen, `launch.ts` (`launchAppControl`, `getAppInfo`, privilege), progress via server | done (`lib/{media,media-types,launch,progress-sync}.ts`, `screens/{Title,media-cards}.tsx`, Home hero + `HomeRow`s with scan fallback, focus row memory, `application.launch/info` privileges, config.xml 1.1.0; mock e2e 22/22 incl. fake `window.tizen`; installed + launched on Odyssey G8, TV opened 5 TCP sessions to the local server `/media`) |
| WP12-03 | Device verification: Google TV 192.168.100.31 + Odyssey 192.168.100.135 — open Netflix/YouTube from a title, progress round-trip web↔TV | done (Google TV 1.1.0: `mixai://title/tv/84958` → "Where to watch · Disney Plus" → CENTER → `topResumedActivity=com.disney.disneyplus/…MainActivity`, `ProviderLauncher: started com.disney.disneyplus`; Netflix `netflix.com/search` is NOT in the TV app's intent filter (only `/title|/watch|/browse`, `nflx://`) → FIXED 7bea411: `ProviderLauncher` falls back to the app launcher when the pinned URL is unrouted → `topResumedActivity=com.netflix.ninja/.MainActivity`, `ProviderLauncher: started com.netflix.ninja` (Google TV, 2026-09-19); progress: local movie 1368492 play 25 s → `/media/progress` 600→619 s, rev 3→5, `continue` row; Odyssey: `was_execute` resumed + 6 TCP sessions to :17899 (debug key hook `lib/e2e-press.ts` + `open:tv:236235` → Netflix offer pressed remotely 2026-09-19: Netflix not installed on the monitor → browser fallback took the screen ~6 s then app resumed; installed-app path proven by mock e2e); web signed-in `/` 390/1440/3440 ×2 modes OK, axe 1× `aria-allowed-role`, `/media/movie/…` "Titlu indisponibil" because `devices.lan_url` is stale and `api.mixai.ro` has no DNS here; server→web push VERIFIED against local web (MMO_WEB_APP_URL): after migration 0030 applied to prod + device row registered, `PUT /media/progress` Mandy 460885 pos 968 → `POST /api/media/sync 200 pushed=1` → `watch_history` row position_sec 968, `media_sync_state.revision=11`. Server 3.2.0: 0 ffmpeg/ffprobe after boot and `/video/scan`. Guide `docs/aplicatie/media-home.md`) |

### WP13 — Agent config & gates (D23)
| ID | Item | Status |
|---|---|---|
| WP13-01 | `AGENTS.md`, `.github/copilot-instructions.md`, 11 `.github/instructions/*.instructions.md` | done 0fb356c |
| WP13-02 | 11 `.github/skills/*/SKILL.md` | done 0fb356c |
| WP13-03 | Scripts promoted: `scripts/tracker-regen-csv.mjs`, `apps/web/scripts/i18n-parity.mjs`, `apps/web/scripts/bundle-budget.mjs`, `scripts/hex-gate.mjs`; tokens mirror list += mixai/server prehydrate | done d501776 |
| WP13-04 | Husky `prepare` + lint-staged path-scoped gates (i18n, tokens, OpenAPI, hex/Color(0x), tracker csv, version bumps server/packages) + commitlint | done — root `lint-staged` config, `scripts/{check-version-generic,tokens-drift,tracker-drift}.mjs`, `commitlint.config.mjs`, `.husky/commit-msg` |
| WP13-05 | CI: `server-ci.yml`, web-ci += bundle budget/LHCI/axe/knip, `docs-ci.yml` lychee, actionlint, `deps-weekly.yml` | done — actionlint clean locally; first CI run pending push |
| WP13-06 | Mutation-test every gate (break → red → restore) → `docs/arhitectura/gates.md` | done 2026-09-18 — all 11 hook gates + bundle budget + lint-baseline compare RED/GREEN in gates.md; scripts gained `--dir`/`--spec`/`--baseline-file`/`--results` overrides |

### WP14 — Closure
| ID | Item | Status |
|---|---|---|
| WP14-01 | Matrix green; design-critic on Media Home; CHANGELOGs; versions web 2.2.0, server 3.1.0, tv 1.1.0, sdk 0.1.0, extension 3.0.1; ADR-0009 + ADR-0010 | done — matrix §6.1 (1 pre-existing web test red, count 13 → 1); critic `docs/followups/design-critic-media-home-2026-09-18.md` (web `/` 47/60 after Rx1–2 applied in `media-home.css`, title 42, TV Android 41, Tizen 39); ADR-0010; root + server CHANGELOGs; design-system §6 media patterns; functionalitati matrix; READMEs |
| WP14-02 | Round 4 askQuestions reality check | done (2026-09-19: push main → yes; keep dev device row; MOTN key later; tizen debug press hook built + used) |

### WP15 — Video playback without eating the PC (2026-11-03)
Decisions: original video always; video transcode OFF by default (`allowVideoTranscode`); incompatible audio → E-AC3 5.1 640k (then AC3, AAC);
analyses cheap (audio-only / keyframes, 1 at a time, idle priority, disk cache). Measured on a 4K DV HDR HEVC MKV (E-AC3 5.1), ffmpeg 7.1.1.

| ID | Item | Status |
|---|---|---|
| WP15-01 | Live HLS: no full transcode unless allowed; `q` default `original`; 1 cached ffprobe instead of 2 per playlist + segment request | done — live `q=720p` → `X-MMO-Mode: remux`; playlist 1.7–1.9 s from cold at `start=1800` |
| WP15-02 | Segment route no longer restarts sessions at 0 (resume was broken for every `start>0`) | done — same ffmpeg pid across playlist + init + 2 segments |
| WP15-03 | Copy paths read at 2x realtime (`-readrate 2 -readrate_initial_burst 60`), BelowNormal priority | done — steady 30 s: 0.02 cores, 191 MB read (was 101 MB/s, 3 GB temp per 30 s, 1.25 cores) |
| WP15-04 | fMP4 `init.mp4` written to the session dir (`cwd`) — was written to the server cwd and 404'd | done — init 200 in 12 ms (was 404) |
| WP15-05 | Audio convert → E-AC3 5.1 640k / AC3 / AAC stereo by `caps`; no caps → AAC stereo | done — 8 unit tests `transcode-video.test.ts` |
| WP15-06 | Full transcode fixed for 10-bit sources (`format=yuv420p`) — opt-in only | done — 3.7 cores NVENC, runs (was: died < 1 s) |
| WP15-07 | Subtitles: all text tracks in ONE pass, cached on disk; bitmap tracks skipped | done — cold 5.4 s for all tracks, warm 26 ms (was 1 full-file read per track, 367 MB/s each) |
| WP15-08 | Card still `GET /video/thumbs/{id}/still.jpg` (1 keyframe, 640 px) replaces sprite tile on TV cards | done — cold 273 ms, warm 3 ms, ~0 CPU (sprite was 11.6 cores per card) |
| WP15-09 | Sprite = 144 keyframe seeks in the analysis queue (no full decode) | done (code); same keyframe path as WP15-08 |
| WP15-10 | Intro/credits/loudness/crop: audio-only or keyframes, `-threads 1`, global FIFO queue (1), IDLE priority | done — intro 1.0 s (was 11.5 cores), loudness 12×20 s sampled 8 s, ~0 CPU (was 6.9 cores) |
| WP15-11 | Pre-remux job at IDLE priority | done |
| WP15-12 | tv-android: HLS `q=original` + `caps`, resume via `?start=`, absolute progress, still.jpg, bitmap subs skipped | done — APK build see session note |
| WP15-13 | tv-tizen: resume via `?start=` (no more waiting for ffmpeg up to the resume point), offset-aware time/seek/progress, still.jpg | done — `tsc` clean |
| WP15-14 | Contract: openapi `still.jpg`, `VideoFlags.allowVideoTranscode` + `analysisQueue`, `q` default; Models.kt + SDK regenerated | done — `openapi:check` OK 195/195 |
| WP15-15 | Device check Tizen (Odyssey G8): resume at 30:00 of the 4K DV film via CDP (`sdb forward` to the web inspector) | done — `playing` after 1.79 s, 3836×1604 decoded, ffmpeg remux `-ss 1800` BelowNormal 0.037 cores, server 0.036 cores |
| WP15-16 | Ultrawide 21:9/32:9 fed 16:9 (Odyssey via Chromecast 3840×2160 @120×157 dpi; Tizen engine fixed 1920×1080): UI squeezed by panel/16:9, video box sized for film aspect on the real panel; setting Auto/16:9/21:9/32:9 RO+EN | done — Android logcat `raw=2.314 snapped=2.370`, video layer `displayFrame=[480 0 3360 2160]` for a 16:9 film (= correct pillarbox on 21:9); Tizen `--squeeze=1.34375`, `#root` 2580 px, screenshot OK; `screen-format.test.mjs` 3/3 |
| WP15-17 | Deleted files: `/video/stream` → 404 `file_missing`; `/video/scan` + `/media` library prune entries whose file is gone (root online); TV errors say "file no longer on disk" | done — live: 404 `file_missing`, scan 75 files 0 missing, media library 74 items 0 missing |
| WP15-18 | Web player forced 16:9/4:3/21:9 = largest centred box (container query units) | done — 12 viewport×ratio combos (3440×1440, 1920×1080, 390×844, 844×390) ratio exact, inside=true |
| WP15-19 | Tizen on Odyssey still pillarboxed (black bars L/R): app ran in a 16:9 window. `config.xml` `base_screen_resolution=extensive` + `viewport width=device-width` → native 21:9 surface; squeeze now only a fallback when the engine stays 16:9 | done (tv-tizen 1.3.1) — live: viewport 2580×1080, squeeze 1, no overflow, rows use full width (screenshot); 2.39:1 4K film `<video>` 2580×1080 = full screen; `screen-format.test.mjs` 4/4 |

### WP16 — Better than Plex: cinematic UI/UX on every surface (2026-11-04)
Decisions D25–D33. Must not regress WP15 (original-quality playback, `?start=` resume, ultrawide box, still.jpg, analysis queue).

**Research summary (2026-11-04, 5 parallel inventories).**
- *Plex 2024–25 redesign complaints*: slow/buggy focus (no up from library to nav), un-hideable Discover/Live/Rentals, Continue split per library, own library buried under promos. Premium feel (Infuse 8 / Apple TV) = restraint, huge artwork, logo treatment, honest format badges, fast thumbnail scrub, minimal OSD.
- *tv-android 1.3.0*: hand-rolled `mutableStateListOf<Screen>` stack, only top screen composed → focus + scroll lost on Back; no transitions; stock media3 controller unreachable by D-pad (no tracks/skip/up-next); Coil defaults, no prefetch; `/media/home` memory-only 5 min cache; no search UI (API exists); music = one row, no background service; settings minimal; emoji icons; two detail designs (Movie/Show file pages + TMDB Title).
- *tv-tizen 1.3.1*: union-state router remounts screens (Home re-POSTs `/video/scan` on every Back); `focus.ts` O(n) rect reads, no virtualisation; OSD buttons not focusable; no audio tracks/skip/up-next; `data-motion=reduced` forces all durations to 0; no settings screen; cache memory only; posters w500 for 220 px.
- *web 2.2.1*: two video UIs (`/` + `/media` on servers vs legacy `/watch` on Postgres); `<ViewTransition>` already wraps pages + `media-${kind}-${id}` names; player has skip/up-next/party/cast but inline rgba + English labels; no media search page, no season pages, no artist/album pages, no profile gate; `watch_profiles` lacks PIN/max rating.
- *server 3.3.1*: `/media/*` (home/title/search/progress/plays/library), profile = opaque string, certification cached (one region); no series/season model (flat season/episode on files); watch party WS on LAN only, `/ws` broadcast-only without auth; Subsonic has artists/albums/playlists/lyrics (LRCLIB lane) but no play queue; **no live TV at all**; single shared device token.
- *Tech*: Compose `SharedTransitionLayout` (no `AndroidView` sharing → morph poster, crossfade into player); Media3 1.11 `DefaultPreloadManager` for zapping/episodes; tv-material 1.1 (Carousel, NavigationDrawer, Surface glow); React `<ViewTransition>` only inside transitions; Tizen ≤8 lacks View Transitions → FLIP with transform/opacity; SyncPlay clock sync (4-timestamp, lowest RTT, scheduled `When`), Xtream `player_api.php` (base64 EPG, `tv_archive`), HDHomeRun `discover.json`/`lineup.json`, LRCLIB `/api/get` cached server-side.

**Design language (all surfaces).** Full-bleed backdrop layer under the UI that crossfades (300 ms, transform/opacity only) to the focused item's backdrop; scrim from tokens; title logo instead of text when TMDB has one; metadata chips (year · age rating · runtime · 4K/HDR/DV/Atmos/5.1); one primary action (Play / Resume S2E4 · 12 min left); left rail nav (Home, Search, Movies, Shows, Music, Live TV, Settings; reorder/hide) collapsing to icons; focused card scale 1.06 + ring + lift, rows remember focus; Back = one level, Home Back = rail, rail Back = exit confirm. Icons = lucide (web) / Material Symbols vector (Android) / inline SVG sprite (Tizen), no emoji.

#### WP16-A — Server foundations
| ID | Item | Status |
|---|---|---|
| WP16-01 | Profiles: `media.sqlite` v3 `profiles` (id, name, avatar, color, kind adult/kid, max_age, pin_hash scrypt, prefs JSON, sort); `/media/profiles` CRUD + `POST /media/profiles/:id/unlock` (PIN, 5 tries/5 min lock) → short-lived profile token; `default` profile seeded; legacy `profile_id` strings mapped | done bbd03361 |
| WP16-02 | Age ratings: `pickCertification` → `ageFor(cert, country)` table (RO CNC AG/AP-12/I.C.-14/N-15/IM-18, US, GB, DE); `age` on TitleCard/TitleDetails/library rows; `/media/home|search|title|library` filter by profile max_age (unrated blocked for kids) | done bbd03361 |
| WP16-03 | Series model: TMDB `/tv/{id}/season/{n}` cached 7 d; `GET /media/title/tv/:id/season/:n` → episodes with still, overview, runtime, air date, local file + progress per episode; next-up episode in title + continue | done bbd03361 |
| WP16-04 | Watchlist per profile on server (`watchlist` table, `/media/watchlist` GET/PUT/DELETE, row on home) + push to web sync | done bbd03361 |
| WP16-05 | Global Continue: episodes (next-up), movies, music albums, recordings in one `continue` row with `kind`; "Surprise me" + TMDB collections (franchise rows) | doing - up-next episodes in Continue + franchise row done bbd03361; music/recordings + Surprise me pending |
| WP16-06 | Versions: title `files[]` grouped into versions (resolution/HDR/edition label from probe + filename) | done bbd03361 (version on title + season files) |
| WP16-07 | Hub `/hub` WS: auth (device token or profile token), device registry (`hello {deviceId,name,platform,caps,profileId}`), presence, `GET /hub/devices`; remote commands (`play {fileId,startSec}`, pause/seek/stop/next, `text` input for search), state snapshots 1 Hz; SSE fallback | done d2cf59f5+789377e8 (server 3.5.0; SSE fallback not built - WS only) |
| WP16-08 | Watch Together on the hub: rooms with invite link (works over tunnel), clock sync (4-timestamp, lowest-RTT window 8 + EMA), server state machine idle→waiting→playing⇄paused, commands scheduled at `now+maxRTT+150ms`, drift: rate 0.95–1.05 above 120 ms (stop < 40 ms), seek > 1.5 s; chat + reactions with media timestamp; old `/video/party` kept as alias | done d2cf59f5 server side (sync-math shared rules, invites, guest /video?inv=; old /video/party kept as is) - clients in WP16-27/34/39 |
| WP16-09 | Music API for TV: `/media/music/home` (recent, newest, most played, playlists, genres), artists/albums/tracks pages via Subsonic store; play queue per profile `/media/music/queue` GET/PUT; lyrics `/media/music/lyrics/:trackId` (synced LRC → JSON lines; sidecar `.lrc` read; LRCLIB fallback via existing lane, cached) | done 3259ead1 (server 3.6.0) |
| WP16-10 | Stats: `/media/stats?profile&year` (hours, titles, top genres/artists, streaks) | done 3259ead1 (server 3.6.0) |
| WP16-11 | OpenAPI + `openapi:check` + Models.kt + SDK regen; tests for profiles/PIN lockout/age filter/season/watchlist/hub clock+drift/queue/lyrics; server minor bump | done bbd03361/d2cf59f5/3259ead1 - OpenAPI 241 routes, Models.kt 72 classes, SDK 0.5.0; tests 171 (profiles 10, hub 9, livetv 43, music 17, stats 9); live smoke `.copilot-tmp/wp16-live.ps1`: PIN 403 then token 200, watchlist, stats, music, M3U source 2 channels + stream 302, hub WS welcome/devices/time, status /ws still connects |

#### WP16-B — Live TV / IPTV / DVR (server)
| ID | Item | Status |
|---|---|---|
| WP16-12 | `server/src/livetv/` module + `livetv.sqlite`: sources (m3u url/file + xmltv url, xtream host/user/pass, hdhomerun ip), refresh schedule, channels (number, name, logo, group, tvg-id, source, stream url, archive days), favourites, hidden groups per profile | done 3259ead1 (server 3.6.0) |
| WP16-13 | Parsers: streaming M3U/M3U8 (`#EXTINF` attrs, `tvg-*`, `group-title`, `catchup*`), XMLTV (streaming SAX, gz), Xtream `player_api.php` (categories, live streams, short EPG base64, archive), HDHomeRun discover/lineup; EPG matching tvg-id → name fuzzy | done 3259ead1 (server 3.6.0) |
| WP16-14 | API `/livetv/*`: sources CRUD + test, channels (filter group/fav), `guide?from&to&channels` window, now/next, `stream/:channelId` (redirect or copy-proxy HLS/TS with `-c copy`, never transcode unless allowed), catch-up URL builder | done 3259ead1 (server 3.6.0) |
| WP16-15 | DVR: recordings (one-off from guide, series rule by title, padding), scheduler, tuner limit per source, `ffmpeg -c copy` to TS then remux MKV at IDLE (ffmpeg-jobs), recordings appear in library + Continue; conflicts reported | done 3259ead1 (server 3.6.0) |
| WP16-16 | Tests (parsers with fixtures, guide window, scheduler conflicts) + OpenAPI | done 3259ead1 (server 3.6.0) |

#### WP16-C — TV Android (2.0.0)
| ID | Item | Status |
|---|---|---|
| WP16-17 | Navigation shell: stack + `SaveableStateHolder` (state/scroll/focus kept on Back), `AnimatedContent` + `SharedTransitionLayout`, left rail (icons → labels on focus), Back semantics, exit confirm | done 8b40b566 - stack + SaveableStateHolder + AnimatedContent + SharedTransitionLayout, rail (hide/reorder, mini-player), Back: top-level -> rail -> exit confirm; device: rail expands, Search opens, exit dialog, Back from Title restores the card |
| WP16-18 | Image pipeline: Coil `SingletonImageLoader.Factory` (memory 20 %, disk 256 MB, crossfade, exact sizes, RGB_565 for posters on low-RAM), prefetch next row + focused title backdrop; `/media/home` disk cache (stale-while-revalidate, etag) → Home < 1 s cold | done 61e0f7a3 - Coil loader (20 %/15 % mem, 256 MB disk, RGB_565 low-RAM), prefetch next 10 + backdrops, home disk cache SWR + per-profile decode memo; benchmark build Home first frame 0.80 s cached (debug 5.0 s - debuggable ART), decode 58 ms |
| WP16-19 | Profile picker + PIN pad (D-pad + number keys) + kids badge; profile switch in rail | done 8b40b566/61e0f7a3 - ProfilePicker + PinPad (number keys, shake, tries left, locked countdown), kids badge, editor (age 0/7/12/14/15/18, PIN set/remove); device PIN path not exercised (server has 1 profile) |
| WP16-20 | Home: backdrop layer follows focus, hero with logo/chips/Play-Resume, muted trailer link, rows (Continue global, watchlist, collections, recs), row focus memory | done 61e0f7a3 - hero follows focused card (150 ms), logo/chips/Play-Resume/More info/My list, rows incl. continue landscape + watchlist + collections; device: 'Continue watching / The Wolf and the Lamb / Top picks'; D-pad p50 93 -> 38 ms (janky 83 -> 17 %) after overdraw fix (offscreen backdrop layer, single opaque base) PERF 2026-11-06 (2.1.2): poster-row Home D-pad p50 57-61 -> 36-40 ms (janky ~49 -> 27-33 %) on Chromecast benchmark build: baked scrim strips, ModulateAlpha backdrop crossfade, hero fade instead of AnimatedContent, snapshotFlow focus; A/B evidence .copilot-tmp/atvd2 (ab1/ab2/ab-fx4, perf-fx1..fx5). |
| WP16-21 | Library browse: Movies/Shows grids (`LazyVerticalGrid`, 1000+ items, filters genre/year/rating/resolution, sort, A–Z jump) | done 61e0f7a3 - LazyVerticalGrid from /media/library, lazy card resolve (pages of 30, 4 concurrent), sort/genre/decade/resolution/unwatched, A-Z strip; device: 'Movies / 6 of 6 titles' |
| WP16-22 | Title page redesign (single design; old Movie/Show screens removed): backdrop, logo, chips, Play/Resume, versions, trailer, watchlist, watched, cast row, seasons tabs + episode list with stills/progress, similar; shared element poster→title | done 61e0f7a3 - single title page (seasons tabs + episodes, versions picker, trailer, watchlist, watched, cast, where to watch, more like this), sharedPoster key, 403 kids / 503 states; old Movie/Show screens deleted |
| WP16-23 | Search: on-screen keyboard grid + voice (SpeechRecognizer) + recent; results library/TMDB/music/channels | done 61e0f7a3 - TvKeyboard + voice (RecognizerIntent) + recent per profile; library/TMDB/music/channels sections; hub `text` -> Search(initial) |
| WP16-24 | Player OSD (Compose over SurfaceView): scrub bar with sprite thumbnails, ±10 s with hold acceleration, audio/subtitle picker, subtitle size/delay, speed, screen format, info panel, skip intro/recap/credits buttons, up-next card with countdown, still-watching prompt, sleep timer; Back hides OSD first; keeps WP15 HLS/resume/ultrawide | done 61e0f7a3 - custom Compose OSD (WP15 HLS/resume/ultrawide kept): scrub + sprite thumbs + hold acceleration, audio/subs + style, speed, screen format, info, skip intro/recap (auto-skip pref), Up Next countdown, still watching, sleep timer, profile prefs (audio/sub language, forced only, size, bg); device: OSD texts + hub remote play ack ok; skip/Up Next not exercised (no markers on test file); HLS audio switch needs server `audio=` param |
| WP16-25 | Music: `MediaSessionService` background playback, Music home, artists/albums/playlists, album + artist pages, now playing (artwork backdrop, synced lyrics, queue panel), mini-player in rail | done 61e0f7a3 - MusicService (MediaSessionService) + controller, music home/artists/albums/playlists/search, artist + album pages, now playing (synced lyrics, queue, ambient); device: tabs + 'No music library yet' (server has no music) - playback not exercised |
| WP16-26 | Live TV: channel list + EPG grid (virtualised both axes, now line, ±day), zapping with `DefaultPreloadManager` (N±1) + last-channel toggle, number entry, now/next overlay, catch-up, record button, recordings | done 61e0f7a3 - channel list + 600 ms preview, EPG grid (virtualised, 6 h windows), DefaultPreloadManager N+-1 + last channel, number entry, banner, catch-up, record; device (test HLS feeds): zap 348-463 ms, first open 1.6-1.9 s, guide p95 16.7 ms; HLS via redirect (proxy breaks relative playlists) |
| WP16-27 | Hub client: register, remote commands (play-on-TV from web), Watch Together join/sync/reactions overlay | done 61e0f7a3 - HubClient (OkHttp WS, backoff, clock estimator), remote commands (play/pause/seek/stop/text/navigate), Watch Together screen (invite + QR, members, chat, reactions) + room-following player with DriftCorrector; device: room created, reaction shown, /hub/command play ack ok; 2-member sync not exercised |
| WP16-28 | Settings: server, account, profiles, playback (autoplay, skip intro auto, preferred audio/subs language), subtitles style, screen format, language, nav customise, cache clear/size, about/diagnostics; ambient screensaver (DreamService) | done 61e0f7a3 - two-pane settings (profiles, playback, subtitles, language, navigation, server, account, cache, Watch Together name, diagnostics), StatsScreen, MixaiDreamService registered (pm query-services lists it) |
| WP16-29 | Strings RO/EN parity, no emoji/hardcoded, device verification (uiautomator + logcat + frame stats `dumpsys gfxinfo`), design-critic ≥ 52 | doing - EN/RO 685/685 keys, hex-gate 0, unit tests 13/13 (SyncMath 7, SearchLogic 6), assembleDebug + assembleBenchmark green; design-critic 44 -> 52/60 (docs/design-critic/wp16-tv.md, tv 2.1.0 6b8c30f9; staged home, heading font, reduce motion, title focus, ambient backdrop); 2.1.1 c7e32a06 unique MediaSession (remote play crash). Open: Home D-pad p50 57 ms on server rows (budget 45) |

#### WP16-D — TV Tizen (2.0.0)
| ID | Item | Status |
|---|---|---|
| WP16-30 | Shell: keep-alive route stack (screens hidden, not unmounted → focus + scroll restored), left rail, exit confirm; `focus.ts` v2 (scoped containers, cached rects per row, wrap, overlay traps); motion re-enabled with transform/opacity (reduced only by user pref) | done - shell/nav/focus v2/ui kit (2f5c63c8); Odyssey 2580x1080 verified |
| WP16-31 | Data: localStorage/IndexedDB cache of `/media/home` + title (SWR, etag), virtualised rows/grids (windowed), poster sizes w342/w185, `decoding=async`, backdrop preload of focused + next | done - home SWR per profile (first paint 372 ms after mount from cache), title memo, virtual Row/Grid, image LRU + clearLoaded on Settings > Cache |
| WP16-32 | Profiles + PIN; Home backdrop-follows-focus + hero; library grids + filters; title page with seasons/episodes/versions/cast; FLIP card→title transition (View Transitions when available) | done (2.1.0) - Who's watching + PIN, Home backdrop-follows-focus + hero, library grids/filters/A-Z, title + season pages; device-verified on Odyssey |
| WP16-33 | Search (TMDB + library + music + channels, on-screen keyboard grid); player OSD focusable (scrub thumbs, tracks, subtitles, speed, skip, up-next, still-watching); settings screen | done (2.1.0) - search + keyboard, player OSD (tracks, subtitle style, speed, format, skip, up-next) with ctx for Watch Together, settings two-pane incl. device name override sent in hub hello |
| WP16-34 | Music (library, artist/album, now playing + lyrics + queue, mini-player); Live TV (EPG grid, zapping with 2 `<video>` elements, catch-up, record); hub client (remote + Watch Together) | done (2.1.0) - music engine attached at app start (server queue restore + remote), artist/album/now playing + lyrics, Live TV channels/EPG/preloaded zap 23-80 ms/catch-up (minutes)/recordings |
| WP16-35 | i18n parity, SVG icons, device verification Odyssey (CDP frame timing, screenshots 2580×1080), design-critic ≥ 52 | doing - i18n EN/RO keys added per screen, SVG sprite, Odyssey verified (home/music/settings via CDP); design-critic 44 -> 52/60 (tizen 2.2.0 a05b3b5d + 2b204569: staged entrance 680 ms, Space Grotesk/Inter, 0.75 rem floor, library fixes; home cached paint 343-415 ms) |

#### WP16-E — Web (3.0.0)
| ID | Item | Status |
|---|---|---|
| WP16-36 | Profile gate ("Who's watching", PIN, kids) on `/media` + `/profiles` rewrite on server profiles (i18n) | done (web 3.0.0, d7cf5dd9) - Who's watching gate + PIN pad + kids on server profiles (components/mmo/profile-gate.tsx), profile menu switch/manage |
| WP16-37 | Media shell: rail/top nav (Home, Search, Movies, Shows, Music, Live TV), backdrop-follows-hover/focus, hero muted trailer after 3 s, keyboard roving focus in rows | done - /media shell: glass top bar nav (roving arrows, '/' search), hub status, backdrop follows hover/focus, hero logo + muted trailer after 3 s, rows with arrow keys up/down/left/right; Home cache-first per profile (window.__mixaiPerf.home); / redirects to /media (?classic=1 keeps WP11 home) |
| WP16-38 | Pages: `/media/search`, `/media/browse/[kind]` (filters, virtualised grid), season/episode `/media/tv/[id]/season/[n]`, collections, watchlist, stats (year in review); `/watch/*` → `/media` redirects | done - /media/search, /media/browse/[kind] (sort/genres/unwatched/A-Z, 1000+ incremental + content-visibility), unified title page (versions, seasons/episodes, cast, offers, My list, trailer, Play on TV, Download), season page, list, stats, collections; /watch/* 307 -> /media, legacy detail pages forward by TMDB id |
| WP16-39 | Player restyle with tokens + i18n: OSD, tracks, speed, versions, skip, up-next, still watching, sleep; Watch Together on hub; "Play on TV" device picker (hub remote) + phone-as-remote page | done - /media/play/[kind]/[tmdbId] custom OSD (audio=<n>, subs+style, speed, fit, skip, up next, still watching, sleep, PiP, keyboard/touch), progress putProgress, hub remote; Watch Together panel + drift sync; PlayOnTvButton + remote mode; public /together guest page (TV QR) |
| WP16-40 | Music: artist/album pages, full-screen now playing with synced lyrics + queue | done - web music engine (2 audio elements, server queue, Media Session, plays), music home/artist/album/playlist/genre/search, now playing with synced lyrics + queue, mini-player in shell, per-track download |
| WP16-41 | Live TV: channels + EPG grid + player (hls.js) + recordings; settings › Live TV sources | done - /media/live channels + preview, EPG grid (role=grid, windowed), zapping player with preloaded neighbour (__mixaiZap), catch-up, recordings (server 3.8.0 /livetv/recordings/:id/file fallback), sources CRUD + channel table |
| WP16-42 | PWA offline downloads (Serwist + IndexedDB, per profile) | done - offline downloads: IDB + Cache mixai-offline-v1 parts, SW Range 206/416, token-free keys, quota/persist, static offline shell public/offline, /media/downloads, DownloadButton |
| WP16-43 | Verification: vitest, typecheck, lint baseline, cloud e2e 390/1440/3440 light/dark + axe, View Transition long-task measure, design-critic ≥ 52 | done - VERIFIED: vitest 137/137, tsc 0 errors (6 old missing-module errors were a hollow pnpm store, relinked), eslint 0, hex-gate 0 (119 files), i18n parity OK, next build OK 86.6 s; e2e/media-wp16.spec.ts (13 routes x 390/1440/3440 x light/dark, axe wcag22aa, cache < 1 s, keyboard). Live run 2611051121-d0jm 10/10. Design critic (docs/design-critic/wp16-web.md): 37 -> 51/60 in web 3.1.6. Fixed: backdrop/trailer painted under AppShell bg (never visible), heading face never applied app-wide (tokens :root beat next/font on html), 3-act entrance, Ken Burns, card ring/glow, placeholder art + still frames, poster->title morph; reruns 2611052100-7fev 10/10 + 2611052111-bk09 11/11 (new design probe: heading face loaded, shell isolated), axe 0 x 13 routes. 1 point short of 52 = no TMDB logo/trailer in the test companion's data (evidence gap, not code) RESCORE 2026-11-06: 52/60 (target met). Companion with TMDB key; server 3.9.6 6e4b0037 (include_video_language, ro had videos=[] -> no trailers anywhere; media db v5 stale titles); web 3.1.7 c011f91d hero prefers a candidate with logo art; live rev mixai-web-00011-t86 (authed /media 200 from its log line); cloud run out-critic3 11/11, axe 0 x 13, Home shows TMDB logo lockup over backdrop (docs/design-critic/wp16-web.md "Rescore"). |

#### WP16-F — Closure
| ID | Item | Status |
|---|---|---|
| WP16-44 | CHANGELOGs, versions (server 3.4.0, tv 2.0.0, web 3.0.0, sdk), docs (`docs/aplicatie/media-home.md`, live TV guide, ADR-0011 hub + ADR-0012 live TV), design-critic report | done 2026-11-05 - ADR-0011 hub/Watch Together, ADR-0012 live TV/DVR, media-home guide RO (df773472); design-critic reports docs/design-critic/wp16-{tv,web}.md; CHANGELOGs per surface current (server 3.9.4, web 3.1.6, tizen 2.2.0, tv 2.1.1, phone 1.1.0, ios 1.1.0) |

#### WP16-G — Phone apps (added 2026-11-06, D34)
| ID | Item | Status |
|---|---|---|
| WP16-45 | Research + decision round: phone feature set vs Plex/Infuse/Jellyfin mobile, shared Android module with tv-android, iOS model generation from openapi.yaml, sign-in (device code / pairing), store listings, new ideas | done 2026-11-05 - competitor/store-policy/codebase research (4 parallel agents), two askQuestions rounds → D36–D39 |
| WP16-46 | Android phone app (Kotlin/Compose, Media3, shares data layer with tv-android): profiles, home, browse, title, player (PiP, background audio, cast/Play on TV, Watch Together), music + lyrics, Live TV, downloads; verified on S25 | doing - slice 1 (phone 1.0.0): onboarding, profiles, home, title, player (gestures, PiP), search, library, music + lyrics, live, settings. Slice 2 (phone 1.1.0): downloads (Media3 DownloadService + WorkManagerScheduler, offline/airplane playback), smart downloads, offline progress flush, Play on TV + handoff (continue/pull back), Cast button, TV remote, Watch Together (sync, chat, reactions, report/block/kick), FCM push (token registration needs an account session), native Google sign-in + Keystore session, night mode, dual subtitles, subtitle search, scene bookmarks, sleep fade, data saver, kids caps + family stats, Plex import, karaoke words, Sentry env-gated; 104 unit tests; S25 verified. Not built: lyrics translation (no server endpoint), D-pad passthrough/volume on the remote (TV has no key/volume action), widgets, Auto, Wear, tablet layouts. TV 2.1.0 crash on play-while-playing reported (phone sends stop first) |
| WP16-47 | iOS app (SwiftUI, AVPlayer, background audio, PiP, AirPlay, offline): same scope; verified on iPhone 17 Pro Max | doing - slice 1 (ios 1.0.0, `apps/ios`): XcodeGen project (ro.mixai.app, iOS 26, Swift 6), MixaiCore client layer (MmoClient, HomeStore SWR, ProfileStore + PIN, Bonjour Discovery, Quick Connect, DeviceAuth, HubClient + SyncMath port, ProgressSync, music/Live TV/WebVTT) with Swift Testing on real-server fixtures (47/47 `swift test`); SwiftUI app (Liquid Glass tabs, mini-player accessory, zoom morph, onboarding, Home/Title/Player with PiP+AirPlay+tracks+sleep+skip intro, Search, Library, Music + synced lyrics, Live + notice, Settings), Tokens.swift mirror, EN+RO String Catalog; `scripts/ios-build.ps1` + `apps/ios/scripts/build.sh` on vmui-mac. Verified on iPhone 17 Pro Max (iOS 27.3, dev IPA @e98a9f7b): Bonjour found both companions, Quick Connect approved (platform ios), Home from the companion, River HLS playback advancing 1:32→1:48 with subtitles, no app faults. Blocked: TestFlight (no ASC app record yet), App Group id (portal). Server bug found: audio-only mkv → `/video/stream` 500 (`0:v:0` map). Slice 2 (ios 1.1.0, commit 1dee01ee, TestFlight build 344 VALID, internal group "MixAI internal"): App Group group.ro.mixai.app shared with widgets + Watch, native Sign in with Apple (verified on device: POST /api/auth/native/apple 200) + Google web fallback, delete account, APNs push registered (POST /api/push/register 200), Live Activities + widgets extension (Continue Watching, Now Playing), offline downloads (server MP4 remux, background URLSession, smart downloads; verified: 35.1 MB on disk, offline playback), Play on TV + remote, Watch Together (room + chat verified), dual subs, subtitle search, bookmarks, fading sleep, night mode, data saver, VLCKit 4 fallback, App Intents, iPad sidebar, family/kids/Plex import, licences, Sentry 9.33, CarPlay scene behind MIXAI_CARPLAY (entitlement requested via developer.apple.com form), watchOS remote app, +268 EN/RO strings, privacy manifest, MixaiCore 70/70 swift test. Open: Live Activity not seen on device during download, Watch app not device-tested (no Apple Watch), CarPlay pending Apple approval, D38 ideas |
| WP16-48 | Store release to PRODUCTION 100 % on Play + App Store (owner 2026-11-06), listings RO/EN, screenshots, privacy labels, review notes | doing - App Store part SUBMITTED 2026-11-05 (iOS 1.1.0 build 355 @6f02e7d3, watch app excluded, ASC app 6831207488, reviewSubmission ac6ff21b-39df-47b2-ba7a-a40983ddc048 state WAITING_FOR_REVIEW): API = categories Entertainment + Music, content rights DOES_NOT_USE_THIRD_PARTY_CONTENT, age rating declaration (messaging + UGC = Watch Together chat, parental controls = Kids profile, socialMediaAgeRestricted false, rest NONE/false) -> FOUR_PLUS (4+), appInfo + version localizations en-US + ro from `apps/ios/store/listing/{en-US,ro}.json` (support/marketing = web home, privacy = web /privacy, live in web 3.1.2), copyright 2026 Dragos Catalin Vladulescu, free (USA base) + 175/175 territories (availableInNewTerritories), review detail (owner contact, no demo account, notes = demo server https://34-118-46-71.sslip.io + nip.io fallback, Live TV legal note, WT moderation, SIWA, in-app deletion), release AFTER_APPROVAL, no phased release (100 %), screenshots APP_IPHONE_67 1320x2868 RGB x6 per locale (Home, Library, Now Playing, Music, Live, Downloads on the demo server; Title pages excluded because TMDB "More like this" shows third-party posters and provider logos). Web UI = App Privacy published (Name, Email, User ID, Device ID, Product Interaction; App Functionality, linked, no tracking; Diagnostics none, Sentry DSN unset). DSA trader status = account-level, In Review since 2026-10-28 (reused, nothing per app). iPhone only (TARGETED_DEVICE_FAMILY 1, ead4e3b7): App Store requires iPad screenshots + iPad testing for family 2 and there is no iPad device or Simulator on vmui-mac; the regular-width layout stays in code for a later release. watchOS app not embedded (6f02e7d3): submission 409 `STATE_ERROR.SCREENSHOT_REQUIRED.APPLE_WATCH` (WATCH_SERIES_3_PROFILE) and there is no Apple Watch/Simulator to capture or test it; target kept in project.yml for a later release. Web for the listing: /privacy shipped in web 3.1.2 (6bd2b2f1, rev 00007-s4f) + locale override fix 3.1.5 (d76ba9f0, rev 00008-z85; `?lang=en` renders EN, verified from the revision's log lines). Privacy manifest aligned (37fb9d48: + UserID, ProductInteraction; - Crash/Performance). Play part: SENT FOR REVIEW (Publishing overview: "Your changes are now in review"; Production track: "Active - Release 1.1.0 in review - 178 countries / regions") 2026-11-05 (ro.mixai.app, console app 4975802724658050513, dev acct 5206135689750310170 personal, production NOT gated by the 12-tester rule): AAB 1.1.0 vc2 (R8, 14.6 MB, ReTrace mapping + native debug symbols attached, signed with a NEW upload key = Secret Manager mmo-mw-prod mixai-phone-upload-keystore-{b64,password,alias}, upload SHA-256 EF:6E:6A:25:2C:9F:E5:42:F8:77:B1:CD:D4:04:C9:11:17:E4:72:D7:90:6C:B4:96:BF:A8:F7:6F:F7:F9:07:C6; Play App Signing key SHA-256 BE:33:C2:41:69:15:A5:26:A6:BA:68:FA:9B:FE:BC:C0:97:73:9A:A5:D0:66:ED:B5:CE:AE:0D:1B:63:5D:72:32, both in assetlinks.json, web 3.1.3 d985c123, live). Production release '1.1.0', EN+RO notes, 100 % (first release), 178 countries, free. Devices (release APK, same upload key): S25 cold start TotalTime x5 = 344/137/180/134/113 ms (median 137), A51 = 3301 (first after install)/1905/852/1011/845 ms (median 1011), 0 crashes, 0 ANR on both; reviewer path (manual URL https://34-118-46-71.sslip.io -> Pair with a code -> Reviewer -> Home rows) passed on both (LAN DNS hijacks sslip.io, so the test used temporary Private DNS one.one.one.one, restored). App content: privacy /privacy?lang=en, ads no, sign-in details = demo-server steps (docs/store/review-notes.md), ad ID no, government/financial/health none, target 13+, IARC PEGI 3 / ESRB E / USK 0 + Users interact, Data safety (name, email, user IDs, app interactions, device IDs; collected not shared; encrypted; deletion /account/delete; WT chat not declared = own-server hub only), FGS dataSync (downloads, https://youtube.com/shorts/yD_RRplAiGQ) + mediaPlayback (https://youtube.com/shorts/PG5bqbNpINk), unlisted, personal notifications blurred. Store listing EN default + RO: name MixAI, short/full description (no IPTV/channel brands), icon 512 from the launcher mark, feature graphic 1024x500, 4 phone shots 9:16/16:9 (Home, Player, Music, Live; Title page excluded = TMDB third-party posters), category Video Players & Editors, contact = developer account email, website = web origin. Android Auto not opted in (no automotive_app_desc / car MediaLibraryService in the phone manifest). Trader status (account-level, due Feb 2027) not needed: console did not block publishing. Pre-review check once flagged "Privacy policy page returns a page not found error" while /privacy answered 200 to curl + Googlebot UA; re-saving the URL with ?lang=en cleared it. Scripts .copilot-tmp/play/ DOMAIN 2026-11-05/06: Sitebunker NS -> clyde/rachel.ns.cloudflare.com (22:25Z), CF zone active, records via scripts/cloudflare-dns-mixai.ps1 (ce61c90f: apex 4 A + 4 AAAA Google, www CNAME ghs, demo A; DNS-only), Search Console domain property verified, Cloud Run domain mappings mixai.ro + www (cert provisioning; 1.1.1.1 held the old nexloc delegation -> purged via one.one.one.one/purge-cache), Google OAuth client origins + redirect URIs for mixai.ro, www and run.app added, support@ + postmaster@mixai.ro = Brivio Stalwart mailing lists -> owner inbox (MX mx.fabricai.ro, SPF, DKIM ed25519 + RSA, DMARC p=none), leaked CF token mixai-dns-agent deleted. run.app keeps serving the same app during review (no redirect, owner). Stores 23:00Z: iOS WAITING_FOR_REVIEW, Play changes in review. WEB ON mixai.ro 2026-11-05 23:48Z: Google-managed certs issued 23:34Z (GTS WR3, mappings recreated after the 1.1.1.1 purge), deploy-clean web @7fc1526a -AppUrl https://mixai.ro -> rev mixai-web-00010-7bd 100 %; authed /media 200 answered by 00010-7bd (log line), 0 x 5xx; https://mixai.ro + www + /privacy 200 over valid TLS, Auth.js callback https://mixai.ro/api/auth/callback/google accepted by Google (sign-in page, no redirect_uri_mismatch); run.app unchanged for the in-review builds. support@mixai.ro verified end to end (SMTP from the demo VM -> owner Gmail inbox 23:34Z). REMAINING for done: Play + App Store approval. PLAY LIVE 2026-11-06 05:40Z: Production track "Active - Latest release 1.1.0 - 178 countries / regions" (was "in review"); public listing https://play.google.com/store/apps/details?id=ro.mixai.app 200, title "MixAI - Apps on Google Play". App Store 1.1.0 still WAITING_FOR_REVIEW (05:38Z). |
| WP16-49 | `:core` extraction: move tv-android `data/*` (minus WatchNext, ProviderLauncher) + MusicService into `apps/tv-android/core`; client identity (platform/version/name) + origin as constructor params; generator path + server-ci drift path + docs updated; TV assembleDebug/benchmark + unit tests green | done c9be4e12 (tv 2.0.2): 17 data files + MusicService moved (R100), ClientIdentity, generator + server-ci path; TV builds/tests green, Chromecast smoke ok. Agent-config path refs = owner trust-surface proposal 01JTVCORE20261106 |
| WP16-50 | Server for phones: `platform` values `android-phone`/`ios`, Watch Together chat report/block/filter, subtitle text search endpoint, iOS download remux (`-c copy` MP4), scene bookmarks, family stats caps, push relay hook; OpenAPI + Models.kt + Swift models | done 2026-11-05 - server 3.9.0: hub formFactor/playbackTarget, chat ids + RO/EN filter + report/block/kick (`chat_reports`, `hub_blocks`), `/media/subtitles/search` (FTS5) + index job, `/video/file` + `/video/download?container=mp4` (LRU cache), `/media/bookmarks`, usage/caps (403 `daily_cap`), `/media/stats/family`, push relay (README § Push relay), Plex importer; 284/284 server tests, openapi:check OK, live smoke on scratch build |
| WP16-51 | Web for phones: Auth.js Apple provider + `/api/auth/native/apple`, account deletion page (public URL), push relay (FCM v1 + APNs) + token table (prod migration only with owner consent) | doing — web 3.1.0: SIWA web + native apple/google exchange, `/account/delete` + `DELETE /api/account`, `/api/push/{relay,register}`, AASA + assetlinks; Services ID `ro.mixai.web` + key `F2YDTZV29A` in Secret Manager. Open: `mixai-web-fcm-sa`, assetlinks fingerprint. 0031 applied to prod 2026-11-05, backup 1793892449973 (register/unregister 200 on rev mixai-web-00005-blf) |
| WP16-52 | `server/scripts/openapi-swift.mjs` → `apps/ios/MixaiCore/Sources/.../Models.swift` + CI drift check | done dfce4bbc (server 3.8.1): 72 structs = 72 Kotlin classes, deterministic, `openapi:gen` runs Kotlin+Swift+SDK; swift test 70/70 on vmui-mac (iOS slice 2) |
| WP16-53 | Public demo server `demo.mixai.ro` (GCE e2-small, server-deadline-free always-on, Blender films + CC music, demo channel, reviewer account) | done 2026-11-05 - `infra/demo/*` (28c2728d): VM `mixai-demo` europe-central2-a, IP 34.118.46.71, 80/443 only, image `mmo-server:3.9.4-31fb136b` (server 3.9.2 `MMO_DEMO=1` auto-approve + read-only, 3.9.3 Dockerfile, 3.9.4 headless without electron); 11 films + 8 PD episodes + 19 CC tracks (ATTRIBUTION.md), 2 looping `-c copy` HLS channels + 48 h XMLTV; live over HTTPS: pair auto-approved, home 4 rows w/ TMDB posters (TTFB cold 2.8 s / warm 70 ms), music 3 artists, livetv 2 ch + guide, ffprobe both HLS OK, Range 206, admin 403; reviewer steps `docs/store/review-notes.md`; apps keep https/443 (ServerUrlTest). `demo.mixai.ro` A record set, resolves after the registrar NS switch (sslip.io name live meanwhile) DNS live 2026-11-05 22:43Z: https://demo.mixai.ro Let's Encrypt cert (caddy restart after SERVFAIL backoff), deploy-clean demo @217a6fbf -> DEMO_HOST=demo.mixai.ro, M3U/XMLTV + Live TV source on demo.mixai.ro (2 ch, 527 programmes), /pair/info 200. Server 3.9.5 (a8b756c9): audio-only files stream as audio HLS instead of 500 (not yet in the demo image). DEMO ON 3.9.5 2026-11-06: deploy-clean demo-image @bf781b0f -> mmo-server:3.9.5-bf781b0f (digest d13af691), deploy-clean demo -> VM runs it; verify (verify2.ps1): health/pair 3.9.5, pair auto-approved, home 6 rows w/ posters (TTFB cold 187 / warm 74 ms), music 3 artists, livetv 2 ch + 60 programmes, ffprobe both HLS OK, Range 206, admin 403, 17899 closed. DEMO ON 3.9.6 2026-11-06 05:50Z: mmo-server:3.9.6-74beccbe (trailers via include_video_language) deployed via deploy-clean; verify2: health/pair 3.9.6, auto-approve, home 6 rows (cold 166 / warm 76 ms), livetv 2 ch + 60 progr., ffprobe HLS OK, Range 206, admin 403. |
| WP16-54 | Cloud web e2e harness `scripts/e2e-cloud/` (brivio pattern) + companion quick tunnel; run WP16-43 matrix | done 46fc2893 + 51672d3e: vm-prod mode + companion forwarder over quick tunnel, ~4 min/run, ~0.01 USD; runs 2611051121-d0jm 10/10, 2611052111-bk09 11/11, axe 0 x 13 routes |


## 12. MixAI product family on every OS and store (2026-11-06)

Decisions D40–D49, [ADR-0013](adr/0013-product-family-and-domains.md), inventory [`docs/arhitectura/app-inventory.md`](arhitectura/app-inventory.md).
Research (2026-11-06): store requirements per platform (Tauri 2 has no native MSIX; Samsung EU sales need Partner status; LG needs UX scenario + checklist;
Fire TV Vega OS runs no APK; Apple 5.2.3/2.1 demo account), Plex/Jellyfin/Emby family patterns (separate music + dash apps, kids = profile), 2026 TV design trends.

### WP17 — Product family, domains, stores

| ID | Item | Status |
|---|---|---|
| WP17-01 | ADR-0013 product family + domains + IDs; app inventory doc; tracker §12 | done 2026-11-06 |
| WP17-02 | Store accounts: Amazon Appstore, Samsung TV Seller Office (+ Partner request for RO/EU), LG Seller Lounge (Individual), Flathub (GitHub + domain verification); MS Partner Center app reservations (MixAI TV, MixAI Music, MixAI Studio, MixAI DJ) | doing: Microsoft Partner Center reservations done 2026-11-06 — MixAI TV 9P3WGV62ZRN5, Music 9PC31TGKW4FP, Studio 9NKKC4WGMX67, DJ 9P5P2WN26RMS (app-inventory.md). **blocked** on the owner for Amazon Appstore, Samsung TV Seller Office (+Partner), LG Seller Lounge, Flathub (accounts do not exist yet) |
| WP17-03 | Brand assets per product (MixAI TV, Music, Studio, DJ, Server marks + store icons/feature graphics) via Brand Designer | todo |
| WP17-10 | Web: host routing in `proxy.ts` (tv./music./app./dj./apex), Auth.js cookie domain `.mixai.ro`, 308 map for old paths, per-host manifest/PWA name/icons/metadata, Cloud Run domain mappings + DNS (CF token needed), sitemap/robots per host | done 2026-11-06: host routing LIVE (MIXAI_HOST_ROUTING=1) on rev mixai-web-00014-k72 (web 3.2.1, f6e3d702); Google-managed certs for tv./music./app./dj. issued 09:48Z after delete + recreate of the mappings. VERIFIED from the demo VM: mixai.ro/media -> 308 tv.mixai.ro/, /media/music -> music., /library -> app.mixai.ro/library, /dj -> dj., tv./music -> music.; one `.mixai.ro` product cookie signs in tv./music./apex (authenticated /api/auth/session answered by mixai-web-00014-k72). 3.2.1 also stops /api/auth/session from returning the session token |
| WP17-11 | MixAI Studio on app.mixai.ro: organizer shell rename, nav, launcher back to suite | done 2026-11-06: Studio live on app.mixai.ro (title "MixAI Studio", 200 signed in, cloud e2e host-app screenshot) |
| WP17-12 | mixai.ro suite landing (cinematic, per-product sections + per-platform download matrix) + signed-in app launcher with morph transitions; RO/EN | done 2026-11-06: SuiteLanding + SuiteLauncher live on mixai.ro. Critic 51/60 -> fixes in web 3.2.2/3.2.3 (hero 1.382fr, one sentence per line >=1024px); VERIFIED 3.2.3 on rev mixai-web-00016-ndn (authenticated marker requests x13) and cloud e2e suite-wp17 run 2611061520-sxs9 exit 0 |
| WP17-20 | MixAI TV Android TV: Play TV listing (TV screenshots, banner), Engage SDK replaces Watch Next, release track | todo |
| WP17-21 | MixAI TV Fire TV: `amazon` flavor without GMS, Amazon listing + submission | **blocked** on the owner (Amazon Developer account, WP17-02). Ready: no flavor needed (0 GMS refs in the APK dex, minSdk 26 = Fire OS 7/8, leanback required, WatchNext no-ops without TvProvider); upload steps in apps/tv-android/README.md § Fire TV |
| WP17-22 | MixAI TV Samsung: Seller Office submission (after Partner approval), QA checklist | todo |
| WP17-23 | MixAI TV LG webOS: platform adapter in TV-web, `appinfo.json`, `.ipk` via ares-cli, emulator/device test, UX scenario doc + self-checklist, submission | doing: platform adapter (webOS deviceInfo/platformBack, Back key 461), webos/appinfo.json (ro.mixai.tv, requiredACG []), scripts/package-ipk.ps1 → ro.mixai.tv_2.3.0_all.ipk (563 KB) built 2026-11-06; emulator/device test + LG Seller Lounge submission wait on an LG account |
| WP17-24 | MixAI TV Apple TV: tvOS target (MixaiCore .tvOS), focus UI, AVKit player, Top Shelf, TestFlight, App Store | doing (in review): tvOS target `MixAITV` (bundle ro.mixai.app = universal purchase with iPhone). VERIFIED 2026-11-06: appletvos build, iOS build, MixaiCore 70 tests, Apple TV 4K simulator on demo.mixai.ro; tvOS App Store version 1.1.0 (TV_OS) with EN+RO description, 5 Apple TV screenshots (3840x2160, real app on the demo server), privacyPolicyText, TV reviewer notes, build 381 (1e86ca46: readable buttons, cancellation-safe loads) -> submitted 14:58Z, WAITING_FOR_REVIEW. Top Shelf = static image (dynamic Top Shelf extension = later) |
| WP17-25 | MixAI TV desktop `apps/tv-desktop` (Tauri 2, static TV web UI, tauri-plugin-http LAN, updater) + Windows MSIX → Microsoft Store | doing: MixAI TV desktop 0.1.1 (Tauri 2, ro.mixai.tv.desktop) - 0.1.0 had a blank window (fetch override rerouted Tauri IPC http://ipc.localhost), fixed + verified rendering and pairing with demo.mixai.ro over CDP. Microsoft Store 9P3WGV62ZRN5 submission 1 IN CERTIFICATION since 2026-11-06 10:32Z: free, all markets, Entertainment/Photo + video, IARC 3+, MixAITV_0.1.1.0_x64.msix validated, EN + RO listings (4 screenshots from the real app on the demo server, box/poster/tile/hero art), certification notes = demo-server path |
| WP17-26 | MixAI TV macOS: Developer ID DMG + Mac App Store pkg (sandbox, local network) | doing (in review): Mac App Store "MixAI TV for Mac" (app 6831661758) 0.1.1 (384) WAITING_FOR_REVIEW since 2026-11-06 (submission 71545b3d; sandboxed smoke ok, App Privacy published). Developer ID DMG VERIFIED 2026-11-06: build-dmg.sh (macos-appstore.ps1 -Mode dmg, 481595e5) -> notarised + stapled universal DMG, spctl "source=Notarized Developer ID", published on GitHub release tv-desktop-v0.1.1 (HTTP 200) and linked from the mixai.ro download matrix (web 3.2.5). Remaining: Apple review outcome |
| WP17-27 | MixAI TV Linux: Flathub manifest (offline cargo/node sources), AppImage | blocked on the owner for Flathub only (submission = PR to flathub/flathub from the owner's GitHub account, WP17-02). Done 2026-11-06: AppImage (82 MB) + deb (3.4 MB) built in WSL (scripts/linux/build.sh) and published on GitHub release tv-desktop-v0.1.1 (tag exists for the Flathub manifest), linked from mixai.ro (web 3.2.5); flatpak manifest/metainfo/desktop entry/flatpak-sources.sh in b0a4ea3a |
| WP17-28 | Phone Android rename to MixAI TV + tablet layout (after WP16-48 iOS approval) | todo |
| WP17-29 | iPhone rename to MixAI TV + iPad (regular width layout exists) + Apple Watch embed with screenshots | todo |
| WP17-30 | Store listing URLs → https://mixai.ro / tv.mixai.ro on every listing (privacy, support, marketing); review notes → demo.mixai.ro | todo |
| WP17-40 | MixAI Music web on music.mixai.ro (from WP16-40 web music module): home, library, artist/album/playlist, radio, lyrics (LRCLIB), queue, offline | doing: server 3.10.0 (618ff63e) adds /media/music/radio (seed + 12 similar artists interleaved, hidden excluded), /tracks (A-Z paged), /playlists, on-demand LRCLIB lyrics persisted on hit / 24 h miss cache (music.test 24/24); web 3.2.6: Start radio (album, artist, Now Playing), Songs + Playlists tabs, downloadable on every TrackList + Download all on album/playlist, player plays finished downloads from /__offline first, /media/downloads shared on every host (per-origin storage), pre-3.10 servers -> "update the server" (unit music.test 4/4, products/offline tests, tsc, eslint). Live VERIFIED 2026-11-06: web 3.2.6 rev mixai-web-00019-7jq answered the authenticated marker requests (music.mixai.ro/?tab=songs 200, music.mixai.ro/media/downloads 200 = shared path works); companion 3.10.1 installers published (release v3.10.1: Windows exe, mac dmg x64+arm64, AppImage). Remaining: demo/Pi server on 3.10.x so radio/songs answer there |
| WP17-41 | MixAI Music Android (`ro.mixai.music`, shares `:core`), Play listing | doing: D50 (separate :music + :music-ui), D52 (shared :mobile-common). (a) DONE d23f7d6e: :music-ui used by :phone. (b) DONE 2026-11-07: :mobile-common (theme+tokens mirror, states, QR, discover/Quick Connect/manual, account sign-in incl. Google, session vault, profile picker) + :music app ro.mixai.music 0.1.0 (welcome, connect, profiles, Music/Search/Settings tabs, now playing, mini player, mixai-music:// links); unit tests mobile-common 4, music-ui 10, music 4, phone 90 green; A51 smoke vs demo server: pair, profile, home, play + mini player, search, settings. Next (c) MediaLibraryService + Auto + voice, (d) downloads, (e) gapless/ReplayGain/crossfade, (f) Glance widget, (g) Wear OS, (h) Cast/DLNA, (i) Play internal/closed test |
| WP17-42 | MixAI Music iOS (target, shares MixaiCore), CarPlay (entitlement requested 2026-11-05), App Store | todo (D51: separate app ro.mixai.music + CarPlay entitlement request) |
| WP17-43 | MixAI Music desktop (Tauri, MS Store MSIX, Mac App Store, Flathub) | todo |
| WP17-44 | MixAI Music DJ automix (beat-matched crossfades from the Rust engine) + synced lyrics | todo |
| WP17-45 | MixAI TV music entry deep-links to MixAI Music when installed (Android TV, Tizen/webOS, tvOS, web) | todo |
| WP17-50 | MixAI Studio desktop shell (`apps/native` → `ro.mixai.studio`), MS Store | doing (in certification): MixAI Studio 1.1.0 (apps/native, ro.mixai.studio, identity DragosCatalin.MixAIStudio). Fixed 2026-11-06: withGlobalTauri missing -> bootstrap never called invoke and fell through to mixai.ro (MIDI prompt from mixai.ro); now Welcome to MixAI Studio -> app.mixai.ro (VERIFIED by launch screenshot). Shared scripts/package-msix.ps1 + AppxManifest template (66faf205). Store 9NKKC4WGMX67 submission 1152921505702335065 submitted 2026-11-06: free/all markets, Music, privacy URL, IARC 3+/PEGI 3, EN+RO listings with 5 cloud-captured Studio screenshots (e2e/studio-store-shots.spec.ts, 5/5 pass on rev mixai-web-00017-cf5) + tile/poster/box/hero art, cert notes. Remaining: certification outcome |
| WP17-51 | MixAI DJ release: Windows MSIX (MS Store), macOS, Linux, landing dj.mixai.ro | doing (in certification): MixAI DJ 1.0.0 MSIX (identity DragosCatalin.MixAIDJ, 4.5 MB, scripts/package-msix.ps1) submitted to Microsoft Store 9P5P2WN26RMS 2026-11-06 (sub 1152921505702335363: free/all markets, Music, IARC 3+, EN+RO listings, 3 real window captures via PrintWindow, cert notes = local-file path, no account). Fixed on the way: apps/mixai build failed on Vite 8 (minify "esbuild" needs separate esbuild) -> "oxc" (7fe8c30b). VERIFIED: release exe launches, audio core up, 2/4 decks + settings render. Not yet: macOS/Linux DJ builds and dj.mixai.ro download links (landing page exists) |
| WP17-52 | MixAI Server distribution: winget manifest, GHCR multi-arch image, Pi one-liner, landing section | doing: GHCR VERIFIED 2026-11-06 - ghcr.io/dragoscv/mmo-server:3.9.6 + latest, amd64+arm64 manifest (mmo-server-docker.yml tracked + fixed SC2046, run 42253038148 green). Companion release CI was red since 3.9.x: pnpm/action-setup version vs packageManager conflict, then pnpm v11 layout, then workspace-mode install -> fixed (pin 10.0.0 via server/package.json, npm_config_ignore_workspace) 697c0904/e2056813/67d346cb/9f197dcb; then electron-builder "Could not detect abi for version 44.10.2" (npm package-lock still on node-abi 4.29 / Electron 34) -> npm overrides node-abi ^4.40 + lock regenerated, server 3.10.1 (04f28be3). Companion 3.10.1 installers VERIFIED on release v3.10.1 (exe, dmg x64+arm64, AppImage, deb, rpm); Windows publish died on a release-create race (422) -> latest.yml regenerated from the published exe and attached, workflow now pre-creates the release. winget manifest packaging/winget/manifests/m/MixAI/Server/3.10.1 generated + `winget validate` succeeded. Blocked on owner: PR to microsoft/winget-pkgs from the owner GitHub account |
| WP17-53 | MixAI Connector: publish Chrome Web Store, AMO, Edge Add-ons | doing (in review): owner decision 2026-11-06 = stores get a store-safe edition only. apps/extension/store/build.mjs -> "MixAI Connector" (storage+activeTab, NO host permissions, NO content scripts): popup searches app.mixai.ro/library?search=<tab title>; downloader stays on GitHub releases. extension-release.yml publishes only mixai-connector-store-vX.zip to stores. Also fixed: release zip lacked _locales/i18n.js/tokens.css (Edge rejected it), SVG icons -> PNG (3.0.2). VERIFIED: e2e/connector-store.spec.ts loads the edition in Chromium (cloud) and asserts manifest + search URL. Edge Add-ons: Store ID 0RDCK9P2CNJ3 In review (3.0.3). Chrome Web Store + AMO: no developer accounts/API secrets exist (owner, WP17-02) |
| WP17-60 | Idea: AI "Ce vedem diseară?" concierge (codai) on every MixAI TV surface | todo |
| WP17-61 | Idea: AI Romanian subtitles on the server (Whisper + LLM translation, cached) | todo |
| WP17-62 | Idea: "Previously on" recap from watched subtitles (spoiler-safe) | todo |
| WP17-63 | Idea: natural-language search over plot + subtitle embeddings | todo |
| WP17-64 | Idea: Romanian EPG pack + legal free channels (TVR+, Arte) in Live TV | todo |
| WP17-65 | Skip intro/credits markers (server detection) + trickplay thumbnails on every player | todo |
| WP17-66 | MixAI Dash: server health (streams, transcodes, disk, temperature) + push alerts in Studio + phone | todo |
| WP17-67 | Family Hub: per-profile time limits, kids PIN, who-is-watching ambient screen | todo |
| WP17-68 | Party DJ mode: TV visualizer, phones queue tracks, DJ takes requests | todo |
| WP17-69 | Smart DVR: ad/recap detection, AI chapters, auto-skip | todo |
| WP17-70 | Simkl + Letterboxd sync (Trakt API is VIP-only since Aug 2026) | todo |
| WP17-71 | Home Assistant scenes (dim lights on play, pause on doorbell) | todo |
| WP17-72 | Idea: continue on another device — "Play on Living room TV" handoff via hub from web/phone/desktop | todo |
| WP17-73 | Idea: phone-as-QR sign-in on every TV + desktop surface (scan, approve, done) | todo |
| WP17-74 | Idea: desktop TV media keys / Windows SMTC + macOS Now Playing + PiP mini-player | todo |
| WP17-75 | OS-aware download matrix on mixai.ro (highlights your platform, store badges, QR for phones) | doing: matrix + UA detection in WP17-12; store badges + QR pending store links |
| WP17-76 | Idea: custom Chromecast web receiver branded MixAI TV (cast from web/phone) | todo |
| WP17-77 | Idea: status.mixai.ro public status + per-product changelog pages | todo |
| WP17-78 | Idea: Discord Rich Presence + Last.fm/ListenBrainz scrobbling in MixAI Music | todo |
| WP17-79 | Idea: server setup wizard from mixai.ro (detect OS, one-liner, pair by QR) | todo |
| WP17-80 | Idea: Watch Together over the internet via a relay, with emoji reactions | todo |
| WP17-81 | Music: sonic radio from audio embeddings, served as OpenSubsonic `sonicSimilarity` (getSonicSimilarTracks / findSonicPath) | todo |
| WP17-82 | Music: BPM/key-aware queue, Smart Reorder (Camelot wheel), energy-curve set builder handed to MixAI DJ | todo |
| WP17-83 | Music: Party mode — collaborative queue by QR, guests on the web without the app, votes; TV + phone + web | todo |
| WP17-84 | Music: Last.fm/ListenBrainz scrobbling from the server (offline queue) + listening stats and yearly Wrapped RO/EN (extends WP17-78) | todo |
| WP17-85 | Music: RO↔EN lyrics translation (codai) + word-level karaoke (TTML/ELRC) | todo |
| WP17-86 | Music: crate sync with MixAI DJ (star on phone → crate + cue points) | todo |
| WP17-87 | Music: smart offline from listening habits (radio seeds, upcoming queue, storage cap) | todo |
| WP17-88 | Music: Guest DJ personas steering the radio (Deep cuts, Same BPM, Harmonic, Stretch) | todo |
| WP17-89 | Music: stems / karaoke vocal removal (server or on-device) | todo |
| WP17-90 | Verification: per-store checklists, demo-server reviewer path on every client, e2e cloud runs per host, design critic ≥ 52 per new surface | doing: e2e cloud run per host (suite-wp17: mixai.ro + tv./music./app./dj. signed in) green 2026-11-06; design critic suite 51 -> fix shipped; MS Store reviewer notes use the demo path. Per-store checklists for Amazon/Samsung/LG wait on those accounts (WP17-02) |
