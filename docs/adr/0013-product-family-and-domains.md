# ADR-0013 — MixAI product family, domains and app identifiers

- Status: Accepted · 2026-11-06 (owner decisions, two question rounds)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §12 (D40–D49, WP17)
- Inventory: [`docs/arhitectura/app-inventory.md`](../arhitectura/app-inventory.md)
- Related: [ADR-0001](0001-naming-mixai-and-mmo-server.md) (brand), [ADR-0004](0004-tv-apps-compose-media3-and-tizen-web.md)
  (TV tech), [ADR-0008](0008-design-system-and-theme-prefs.md) (design system), [ADR-0010](0010-media-module-and-media-home.md)

## Context

Through WP16 every client was called "MixAI", and the web app served both a watching UI (`/media`) and the organizer
(library, AI, DJ live, downloads, settings) under `mixai.ro`. The owner wants a clear separation. Watching apps become
**MixAI TV** and are available in every OS store. `tv.mixai.ro` shows the MixAI TV web UI, and `mixai.ro` becomes the
homepage of the whole MMO suite. Microsoft Store is missing, and `ro.mixai.app` is used by both the phone apps and the
`apps/native` web shell.

Research (2026-11-06) showed the same pattern at Plex, Jellyfin and Emby: a brand homepage, a web app on its own
subdomain, the server, one watching client per OS, a separate music app (Plexamp, Finamp) and an admin/dash surface.
Kids content is a profile mode, never a separate app.

## Decision

### Products

| Product | Purpose | Surfaces |
|---|---|---|
| **MixAI** (umbrella) | Suite homepage, downloads, docs, account | `mixai.ro` |
| **MixAI Server** (MMO Server) | Self-hosted brain: library, streaming, Live TV/DVR, hub, AI jobs | Windows/macOS/Linux companion, Docker, Raspberry Pi |
| **MixAI TV** | Watching: movies, series, Live TV, Watch Together, remote | Android TV/Google TV, Fire TV, Samsung Tizen, LG webOS, Apple TV, Windows, macOS, Linux, web, Android + iOS/iPadOS phones/tablets |
| **MixAI Music** | Listening: library, playlists, radio, lyrics, offline, DJ automix | web PWA, Android, iOS, Windows, macOS, Linux, Android TV/Apple TV (now-playing) |
| **MixAI Studio** | Organizer: library management, AI tagging, downloads, analysis, server admin + Dash | web, desktop shell |
| **MixAI DJ** | Pro DJ desktop (Rust audio) | Windows, macOS, Linux |
| **MixAI Connector** | Browser extension (send to server, download) | Chrome, Firefox, Edge |

Music is a separate product. MixAI TV keeps a light music entry that deep-links to MixAI Music when it is installed, and
plays basic queues itself until then, so existing TV users lose nothing.

### Domains (one Cloud Run web service, host-based routing in `proxy.ts`)

| Host | Serves |
|---|---|
| `mixai.ro`, `www` | Public suite landing (cinematic) + app launcher when signed in |
| `tv.mixai.ro` | MixAI TV web (`/media` shell at `/`) |
| `music.mixai.ro` | MixAI Music web |
| `app.mixai.ro` | MixAI Studio (organizer, settings, admin, Dash) |
| `dj.mixai.ro` | MixAI DJ landing + downloads |
| `demo.mixai.ro` | Public demo MMO Server (exists) |

The Auth.js session cookie is scoped to `.mixai.ro`, so one sign-in covers every host. Old `mixai.ro/media/*` and
organizer paths answer with a 308 to the right host. The `run.app` origin keeps serving everything unchanged until the
store builds that point at it are replaced.

### App identifiers (published IDs never change)

| App | ID | Display name |
|---|---|---|
| Phone Android + iOS (live) | `ro.mixai.app` | MixAI TV (rename at the next update) |
| Android TV / Fire TV | `ro.mixai.tv` | MixAI TV |
| Apple TV (new, same App Store record as iOS: universal purchase) | `ro.mixai.app` tvOS target | MixAI TV |
| Desktop MixAI TV (new, Tauri 2) | `ro.mixai.tv.desktop` | MixAI TV |
| Samsung Tizen | `mXa1TvApp0` | MixAI TV |
| LG webOS (new) | `ro.mixai.tv` | MixAI TV |
| MixAI Music (new) | `ro.mixai.music` | MixAI Music |
| `apps/native` web shell | `ro.mixai.studio` (was `ro.mixai.app`) | MixAI Studio |
| MixAI DJ | `ro.mixai.dj` | MixAI DJ |
| Companion | `ro.mixai.companion` | MixAI Server |

### Technology (extends ADR-0004)

- **Desktop MixAI TV:** Tauri 2. The UI is the MixAI TV web UI built as a static SPA bundle, and the server talks to the
  LAN through `tauri-plugin-http`, which avoids WKWebView mixed-content issues. Microsoft Store gets an **MSIX** (store
  signs it; capability `privateNetworkClientServer`). macOS gets a Developer ID DMG plus a Mac App Store `.pkg` (sandbox
  `network.client`, `NSLocalNetworkUsageDescription`). Linux gets Flathub (GNOME runtime, offline cargo/node sources).
- **LG webOS:** a platform adapter inside `apps/tv-tizen`, which becomes "TV web" with one codebase and two packages
  (`.wgt` + `.ipk`). The Tizen-only APIs (keys, app control, network, model name, codec caps) move behind a
  `platform/` interface.
- **Apple TV:** a tvOS target in `apps/ios/project.yml`, with `MixaiCore` gaining `.tvOS`. SwiftUI focus engine, AVKit
  player, Top Shelf extension.
- **Fire TV:** the same `ro.mixai.tv` APK without Google Play Services dependencies, uploaded to the Amazon Appstore.
  Vega OS devices are out of scope (no APK support).
- **MixAI Music:** a web PWA first (`music.mixai.ro`) that reuses the WP16 web music module. The Android and iOS apps
  share the cores (`:core`, `MixaiCore`), and Desktop is Tauri.

### Store order

Every package is built. Submissions go first to the low-risk stores: Microsoft Store, Apple (tvOS + Mac), Flathub,
Google Play TV and Amazon. Samsung (EU sales need approved Partner status) and LG (UX scenario + checklist, IPTV
scrutiny) are applied for in parallel, and the apps stay sideloadable meanwhile. Live TV is always described as
"streams from your own MMO Server or your own M3U source". No channel lists ship, and every review note points to
`demo.mixai.ro`.

## Consequences

- Positive: a clear story for each product and store listing; one web deploy and one sign-in; no published ID changes.
- Negative: more store listings to maintain (about 12 for TV + Music); host routing adds a redirect layer; the phone app
  rename has to wait until iOS 1.1.0 is approved.
- Out of scope: Roku (BrightScript, no shared code); AI Romanian dubbing for kids (owner: later, kept in the idea
  backlog).
