# Web bundle report — WP2-16 (2026-09-18)

Scope: `apps/web` client JS per route. Baseline = working tree at `eae5170`
**before** this slice; after = same tree + the WP2-16 edits below. Both builds
are `next build` (Turbopack), measured the same way.

## How it was measured

Turbopack's `next build` prints **no size table** (Next 16.3 only lists routes
+ revalidate/expire), and `next build --webpack` currently fails on a
pre‑existing import (`src/lib/device-code.ts` → `node:crypto` reaches the
client component `app/activate/activate-client.tsx`; see hotspots). So sizes
are read from the build artefacts instead, which is bundler‑independent:

```
First Load JS(route) = Σ unique client .js chunks in
    .next/build-manifest.json (rootMainFiles + polyfills)
  ∪ .next/server/app/<route>/page_client-reference-manifest.js → entryJSFiles
Shared = chunks present on every route.
```

Sizes are uncompressed bytes on disk (Turbopack emits unminified module names
but minified code; brotli on the wire is ~4–5× smaller). Scripts:
`.copilot-tmp/wp216-measure.mjs`, `wp216-diff.mjs`, `wp216-attrib.mjs`;
baseline recipe `.copilot-tmp/wp216-baseline2.ps1` (git worktree + robocopy of
the live tree with only WP2‑16 files reverted, `turbopack.root` widened so the
node_modules junctions resolve).

Verification: baseline build exit 0 (137 route entries), after build exit 0
(`.copilot-tmp/build-logs/20260918-132049-pnpm-filter-music-organizer-build.log`),
`tsc --noEmit` 0, `lint-baseline check` 0, vitest 355/356 (1 known
`url-guard` failure, pre-existing).

## Top 15 routes — before → after

| Route | Before | After | Δ |
|---|---:|---:|---:|
| **shared by all routes** | 541.4 kB | 541.4 kB | 0 |
| `/daw` | 3648.1 kB | 2644.1 kB | −1004.0 kB (−27.5%) |
| `/watch/stats` | 3258.5 kB | 2393.3 kB | −865.2 kB (−26.6%) |
| `/activate` | 3257.4 kB | 2791.6 kB | −465.8 kB (−14.3%) |
| `/live` | 3225.8 kB | 2664.2 kB | −561.5 kB (−17.4%) |
| `/playlists` | 3194.7 kB | 2855.1 kB | −339.6 kB (−10.6%) |
| `/library` | 3160.2 kB | 2820.9 kB | −339.3 kB (−10.7%) |
| `/remote` | 3097.3 kB | 2610.6 kB | −486.7 kB (−15.7%) |
| `/editor` | 3078.7 kB | 2592.5 kB | −486.1 kB (−15.8%) |
| `/download` | 2926.6 kB | 2438.7 kB | −487.9 kB (−16.7%) |
| `/watch/movies/[id]` | 2918.7 kB | 2431.5 kB | −487.2 kB (−16.7%) |
| `/watch` | 2914.9 kB | 2427.3 kB | −487.6 kB (−16.7%) |
| `/watch/shows/[id]` | 2911.9 kB | 2424.7 kB | −487.2 kB (−16.7%) |
| `/watch/movies` | 2910.8 kB | 2423.2 kB | −487.6 kB (−16.8%) |
| `/watch/shows` | 2910.8 kB | 2423.2 kB | −487.6 kB (−16.8%) |
| `/watch/collections` | 2908.5 kB | 2421.0 kB | −487.6 kB (−16.8%) |

Sum over all 68 page routes: **195.0 MB → 161.7 MB (−17.1%)**. No route
regressed by more than 1 kB.

"Shared by all" is unchanged at 541 kB because it is the Next/React runtime +
polyfills + the root entry chunk; the ~488 kB that every route lost lives in
the **root `layout` entry**, which the shared metric does not include (it is
per-entry, not per-chunk-intersection). That layout entry went from ≈2.04 MB
to ≈1.55 MB.

### Shared chunks (unchanged)

| Chunk | Size | What |
|---|---:|---|
| `40hydqoifj4w8.js` | 229.7 kB | react-dom |
| `1p-w87usepyhl.js` | 126.0 kB | Next app-router runtime |
| `0cz1d0mv5g_q7.js` | 110.0 kB | polyfills (`polyfillFiles`) |
| `0anj4dqzhxs5b.js` | 31.3 kB | react + scheduler |
| `0rrd5w4pvdpca.js` | 26.2 kB | Next client bootstrap |
| `turbopack-…js` | 10.7 kB | Turbopack runtime |
| `0uks6p-cbyo30.js` | 7.5 kB | layout entry glue |

## What was lazy-loaded (`next/dynamic`, `ssr: false`, `@mmo/ui` Skeleton fallback)

| Boundary file | Widget → chunk moved off the critical path | Why here |
|---|---|---|
| `src/components/layout-lazy.tsx` (new, used by `app/layout.tsx`) | `VideoPlayerHost` (hls.js host, subtitles, bookmarks, watch-party) and `MaestroChatDock` (`ai` + `@ai-sdk/react`) | Mounted on **every** route but render nothing until a video plays / the dock opens. No Skeleton — they were invisible before, a fallback would flash. This is the −488 kB every route got. |
| `src/components/daw/daw-page.tsx` | `DAWDockview` (`dockview` + `mobile-drag-drop` + all 10 DAW panels) | Toolbar/transport paint first; dockview is client-only (localStorage layout, touch DnD polyfill). Extra −516 kB on `/daw`. |
| `src/components/daw/daw-dockview-api.ts` (new) | — | `getDockviewApi`/`PANEL_IDS`/`resetDockviewLayout` moved here (types only from `dockview`) so `daw-toolbar` / `daw-panel-manager` stop re-importing the heavy module. `daw-dockview.tsx` re-exports them for compatibility. |
| `src/components/live/live-page.tsx` | `LiveWidgetGrid` (`react-grid-layout/legacy`) | Client-only (measures container, persists layout). Generic signature restored via cast. Extra −74 kB on `/live`. |
| `src/components/watch/stats-chart-lazy.tsx` (new, used by `app/watch/stats/page.tsx`) | `WatchDailyChart` (`recharts`) | Server page can't call `dynamic({ssr:false})` directly, hence the thin client wrapper. Extra −377 kB on `/watch/stats`. |
| `src/components/now-playing.tsx` | `SortableUpNext` (`@dnd-kit/core` + `sortable` + `utilities`) | Only needed once the queue panel opens; NowPlaying is in the root layout. Included in the layout delta above. |

Already dynamic before this slice (no change): `dashboard-charts` (recharts on
`/`), `VisualizationCanvas`, `MixerView`, `yjs-provider`, `hls.js` inside
`video/player.tsx` (`await import`).

## `force-dynamic` audit

`cacheComponents` is **off** in `next.config.ts` (explicitly deferred there),
so `"use cache"` is not available; caching goes through `revalidate` / Data
Cache instead.

**Removed (13)** — the declaration was redundant; the route stays dynamic
because of something it genuinely does, but Next now decides that from the
code instead of a blanket flag:

- `settings/{appearance,daw,live,mixer,sound-editor,notifications}` — no
  per‑user server data at all (panels read client-side state); the only
  request‑bound call is `getTranslations()` (locale cookie).
- `analysis`, `download`, `editor`, `mixer`, `remote`, `daw`, `live` — the
  only server work is the `auth()` gate (session cookie); all data is
  fetched client-side.

**Kept (all others, ~35)** — they read per-user server data on the server:
`auth()` **and** DB/action reads (`library*`, `watch/*`, `playlists`,
`profiles`, `profile`, `scanner`, `plugins`, `recordings`, `music`,
`training`, `generate`, `voice-wizard`, `drives`, `devices`,
`settings/{account,advanced,companions,devices,library,music,security,video}`,
`watch/settings`, `pair`, `activate`, `status` (health snapshot, `revalidate=0`)).
The `force-dynamic` there is belt-and-braces but harmless; removing it changes
nothing measurable, so it was left.

**`/get`** — was dynamic only because it called `headers()` to build its own
origin for the manifest fetch, which also disabled the Data Cache for that
fetch. Now uses `AUTH_URL` (fallback `https://mixai.ro`) and
`export const revalidate = 300`. The manifest fetch is cached 5 min. The HTML
is **still ƒ** because the root layout calls `getLocale()` (cookie) — see
hotspot 4.

`optimizePackageImports`: added `@mmo/ui` and `motion`. `lucide-react`,
`date-fns` and `recharts` are already in Next 16's built‑in default list
(`next/dist/server/config.js`) so listing them is documentation only; they are
included so the intent is visible. No measurable change from this on its own
(Turbopack tree-shakes these barrels already); kept because it is free.

## Remaining hotspots and suggested next actions

Attribution of the root `layout` entry after this slice (1553 kB, 28 chunks;
`wp216-attrib.mjs`):

| # | Chunk(s) | ~Size | Contents | Next action |
|---|---|---:|---|---|
| 1 | `2uwpbi_8txf9a` | 277 kB | `@tanstack/react-query` + persist client, `next-intl` runtime, serwist provider, audio-engine glue. (Messages are **not** bundled — `getMessages()` streams the active locale via RSC; only EN fallback strings from components appear in chunks.) | Run `ANALYZE=true` once `--webpack` builds again (hotspot 6) to split this chunk by module; likely wins are `@tanstack/query-sync-storage-persister` (only needed offline → `dynamic` inside `OfflineProvider`) and the serwist provider (`SerwistProvider` can be a `dynamic({ssr:false})` island). |
| 2 | `0eyfxpogix44a`, `2udgxd1r20n__` | 325 kB | `motion` (two copies of the animation core — `motion/react` and `@mmo/ui/motion` resolve through the same alias but land in two chunks) + `cmdk` command palette | (a) Move `CommandPalette` behind `dynamic()` opened by ⌘K / the button; (b) audit `packages/ui` for `import { motion } from "motion/react"` in components that only need `AnimatePresence` — use `motion/react-m` + `LazyMotion` (`domAnimation`) once, which drops ~60% of motion. |
| 3 | `0ki2h7ll9ln7j`, `1b-rpt5rogmgk`, `3-jhv61iv_hz3`, `3gk37gvh7ayc8` | 253 kB | audio-player + EQ/mixer contexts, Web MIDI provider (`MidiProvider` + `ControllerBridge`), cast SDK glue, `waveform-seekbar` | `MidiProvider`/`ControllerBridge` (48 kB) render nothing until a controller is connected → `dynamic()` gated on `navigator.requestMIDIAccess` presence. `CastButton`'s SDK loader is already lazy; the wrapper isn't. |
| 4 | root `layout.tsx` | — | `getLocale()`/`getMessages()` read the `mmo-locale` **cookie**, which makes **every** route dynamic (ƒ), including `/get`, `/learn/*` and `/offline` that declare `force-static`/`revalidate`. | Move locale resolution to a `[locale]`-less but header-based scheme: read the cookie in `proxy.ts`, set `x-mmo-locale` request header, and have `i18n/request.ts` read `headers()` inside a `Suspense` boundary in a client `LocaleProvider`, or accept `?lang=` for the public marketing routes. Then `/get`, `/learn/*` become real ISR. |
| 5 | `/playlists`, `/library` (route-own ≈ 2.3 MB) | 2.3 MB | `library-client` / playlists client pull the full track table, filters, DnD and the export dialogs on first paint | Split the export dialogs (`rekordbox`, `usb-copy`) and the bulk-edit sheet behind `dynamic()`; virtualise the table (TanStack Virtual) so the row component tree isn't the payload. |
| 6 | `/activate` | route-own 2.25 MB | `activate-client.tsx` imports `@/lib/device-code.ts` which imports `node:crypto` → whole lib pulled into a client chunk (and breaks the webpack build). | Split `device-code.ts` into pure formatting (client) and crypto (server-only, `import "server-only"`). Also unblocks `next build --webpack` and the bundle analyzer. |
| 7 | `/watch/*` family (≈1.88 MB own) | 1.9 MB | `watch/_theme`, poster popovers with YouTube trailer iframes, `PosterPopover`/`TrailerModal`, hover rows | `TrailerModal` + `HeroTrailer` behind `dynamic()`; rows are already client — check that `movies/[id]` doesn't import the full `player-host` tree via `_player-host.tsx` (it imports `VideoPlayer` statically; make it `dynamic`). |
| 8 | polyfills `0cz1d0mv5g_q7` | 110 kB | Next polyfills for legacy browsers | Set `browserslist` in `package.json` to modern targets (`>0.5%, last 2 versions, not dead, not op_mini all`) — Next drops the polyfill chunk when no legacy target is present. |

Not done in this slice on purpose: the root-layout locale change (#4) and the
`device-code.ts` split (#6) touch files outside the WP2‑16 ownership
(`i18n/request.ts`, `proxy.ts`, `lib/`), and `cacheComponents: true` remains
deferred per the note in `next.config.ts`.
