# MixAI app inventory (2026-11-06, versions and names refreshed 2026-11-12)

Canonical list of every app and surface, today and target. Decisions: [ADR-0013](../adr/0013-product-family-and-domains.md),
[ADR-0016](../adr/0016-mixai-tv-name-brand-and-experience.md) (MixAI TV name on phones, one Play listing, rebrand).
Work: tracker §12 WP17 and §15 WP22. Update this table in the same commit as any release, rename or new store listing.

Icons, splash screens, logo motion and store graphics of every surface below are generated from `brand/`
(WP22-03..10): rules in [`brand/BRAND.md`](../../brand/BRAND.md), full output list with
`node brand/scripts/build.mjs --list`.

## Today

| Surface | Path | Name today | ID | Version | Purpose | Distribution today |
|---|---|---|---|---|---|---|
| Web | `apps/web` | MixAI | — | 3.6.0 | Watching (`/media`) + organizer + DJ live + AI | Cloud Run, `mixai.ro` |
| Android TV | `apps/tv-android` | MixAI TV | `ro.mixai.tv` (moves to `ro.mixai.app`, D72) | 2.4.0 in source (last release 2.3.1) | Watching | Sideload / GitHub release `tv-v2.3.1` (unsigned) |
| Phone Android | `apps/phone-android` | MixAI TV (was MixAI up to 1.3.1) | `ro.mixai.app` | 1.3.2 | Watching, remote, downloads | **Google Play production** (1.3.1 live 2026-11-11 as "MixAI"; 1.3.2 carries the rename, WP22-01) |
| Music Android | `apps/music-android/app` (`:music`) | MixAI Music | `ro.mixai.music` | 0.1.0 | Music: library, search, now playing, lyrics, queue | Debug builds; Play record pending (WP17-41i) |
| Android shared libs | `apps/mobile-android-common` (`:mobile-common`), `apps/music-android/music-ui` (`:music-ui`) | — | `ro.mixai.mobile`, `ro.mixai.music.ui` | — | Theme/tokens, connect + sign-in, profiles; shared music screens (D50/D52) | Built into `:phone` and `:music` |
| iPhone | `apps/ios` | MixAI TV in source from 1.1.2 (store record still "MixAI") | `ro.mixai.app` | 1.1.2 | Watching, remote, downloads, widgets | App Store: 1.1.1 approved 2026-11-11 (not sold in the 27 EU storefronts, WP16-48); 1.1.2 not submitted (WP22-02) |
| Apple TV | `apps/ios/MixAITV` | MixAI TV (same store record as iPhone) | `ro.mixai.app` | 1.1.0 | Watching | App Store: 1.1.0 build 516 waiting for review |
| Apple Watch | `apps/ios/MixAIWatch` | MixAI TV in source from 1.1.2 | `ro.mixai.app.watchkitapp` | 1.1.2 | Remote, now playing | Not embedded in 1.1.x |
| Samsung TV | `apps/tv-tizen` | MixAI TV | `mXa1TvApp0` | 2.5.0 | Watching | Sideload (signed `.wgt`) |
| Web shell | `apps/native` | MixAI Studio | `ro.mixai.studio` | 1.1.1 | Tauri/Capacitor wrapper that loads `mixai.ro` | GH Release |
| Decks | `apps/mixai` | MixAI Decks (was MixAI DJ, D60) | `ro.mixai.dj` | 1.1.0 | DJ / creation. Rust crates in `apps/mixai/src-tauri/crates`: `mixai-core` (engine), `decks-analysis`, `decks-library`, `decks-mapping`, `decks-dvs`, `decks-render` + shared `crates/mixai-listen` — built and unit-tested; UniFFI facade + native UIs (2.0) todo. Docs: [`docs/decks/`](../decks/README.md) | 1.0.0 MSIX in MS Store certification (as MixAI DJ); 1.x Tauri on `decks-release.yml` |
| Live (browser) | `apps/web` route `/live` | MixAI Live (web) | — | web | Browser vocal processor (Web Audio FX engine `lib/audio-fx-engine.ts`); host `live.mixai.ro` mounts it at `/` once host routing is on (ADR-0015) | Cloud Run (inside Studio today) |
| Live (native) | `apps/live` | MixAI Live | `ro.mixai.live` | — | Realtime vocal processor: Rust engine (`apps/live/engine`), Tauri desktop, remote controllers (ADR-0015, WP21) | In development; no store records yet; tags `live-v*` |
| Extension | `apps/extension` | MixAI Connector (was MixAI downloader up to 3.0.1) | `mixai-downloader@mixai.ro` | 3.1.0 | Connects the browser to MixAI Server (download helper) | Release workflow exists, not published |
| Server | `server` | MixAI Server (was MixAI Companion up to 3.15; technical name MMO Server) | `ro.mixai.companion` | 3.16.0 in source (last release 3.15.0) | Server | GH Release, Docker, Pi |
| Gateway | `apps/gateway` | — | — | 0.1.0 | Infra | Cloud Run |

## Target

| Product | Platform | Store | Path (planned) | ID | Tracker |
|---|---|---|---|---|---|
| MixAI TV | Android TV / Google TV | Google Play, same listing as the phone app (D72) | `apps/tv-android` | `ro.mixai.app` | WP22-11, WP17-20 |
| MixAI TV | Fire TV | Amazon Appstore | `apps/tv-android` (same build) | `ro.mixai.app` | WP17-21 |
| MixAI TV | Samsung Tizen | Samsung Seller Office (Partner) | `apps/tv-web` (ex tv-tizen) | `mXa1TvApp0` | WP17-22 |
| MixAI TV | LG webOS | LG Content Store | `apps/tv-web` platform `webos` | `ro.mixai.tv` | WP17-23 |
| MixAI TV | Apple TV | App Store (universal with iOS) | `apps/ios` tvOS target | `ro.mixai.app` | WP17-24 |
| MixAI TV | Windows | Microsoft Store (MSIX) | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-25 |
| MixAI TV | macOS | Mac App Store + DMG | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-26 |
| MixAI TV | Linux | Flathub | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-27 |
| MixAI TV | Web | `tv.mixai.ro` (PWA) | `apps/web` host routing | — | WP17-10 |
| MixAI TV | Android phone/tablet | Google Play | `apps/phone-android` (tablet layout) | `ro.mixai.app` | WP22-01, WP17-28 |
| MixAI TV | iPhone/iPad | App Store | `apps/ios` (iPad) | `ro.mixai.app` | WP22-02, WP17-29 |
| MixAI Music | Web | `music.mixai.ro` (PWA) | `apps/web` host routing | — | WP17-40 |
| MixAI Music | Android phone + Wear + Auto | Google Play | `apps/music-android` | `ro.mixai.music` | WP17-41 |
| MixAI Music | iPhone + CarPlay | App Store | `apps/ios` target `MixAIMusic` | `ro.mixai.music` | WP17-42 |
| MixAI Music | Windows | Microsoft Store (MSIX) | `apps/music-desktop` (Tauri shell → music.mixai.ro) | `ro.mixai.music.desktop` | WP17-43 |
| MixAI Music | macOS | Mac App Store + DMG | `apps/music-desktop` | `ro.mixai.music.desktop` | WP17-43 |
| MixAI Music | Linux | Flathub | `apps/music-desktop` | `ro.mixai.music.desktop` | WP17-43 |
| MixAI Studio | Web + desktop shell | `app.mixai.ro`, MS Store | `apps/web`, `apps/native` | `ro.mixai.studio` | WP17-11, WP17-50 |
| MixAI Decks | Windows/macOS/Linux, then iOS/iPadOS/Android (native 2.0, ADR-0014) | MS Store, Mac App Store, App Store, Google Play, Flathub, GH; site `decks.mixai.ro` (`dj.mixai.ro` → 308) | `apps/mixai` | `ro.mixai.dj` | WP17-51, WP19 |
| MixAI Live | Windows/macOS/Linux desktop (Tauri 2 + Rust engine) | MS Store, Mac App Store, Flathub, GH (`live-v*`); site `live.mixai.ro`. Store records not created yet | `apps/live` | `ro.mixai.live` | WP21 |
| MixAI Live | Android phone/tablet controller | Google Play (record not created yet) | `apps/live` Compose controller (shared Gradle build) | `ro.mixai.live` | WP21 |
| MixAI Live | Wear OS controller | Google Play (Wear, same listing) | Wear module of the Android controller | `ro.mixai.live` | WP21 |
| MixAI Live | iPhone + Apple Watch controller | App Store (record not created yet) | `apps/ios` targets | `ro.mixai.live`, `ro.mixai.live.watchkitapp` | WP21 |
| MixAI Live | Web | `live.mixai.ro` (browser `/live`) | `apps/web` host routing | — | WP21-01, WP21-14 |
| MixAI Server | Windows/macOS/Linux, Docker, Pi | GH Release, Docker Hub/GHCR, winget | `server` | `ro.mixai.companion` | WP17-52 |
| MixAI Connector | Chrome/Firefox/Edge | CWS, AMO, Edge Add-ons | `apps/extension` | `mixai-downloader@mixai.ro` | WP17-53 |
| Suite homepage | Web | `mixai.ro` | `apps/web` | — | WP17-12 |

## Store accounts

| Store | Account | Notes |
|---|---|---|
| Google Play | yes (personal) | Production live for `ro.mixai.app` |
| Apple (iOS/tvOS/macOS) | yes, team S6D533QSV2 | iOS 1.1.0 in review |
| Microsoft Partner Center | yes | No fee; MSIX signed by the Store |
| Amazon Appstore | needed (free) | Tax interview |
| Samsung TV Seller Office | needed (free) | EU sales need approved Partner status |
| LG Seller Lounge | needed (free, Individual seller) | UX scenario + self-checklist mandatory |
| Flathub | needed (free, GitHub) | Domain verification for the verified badge |

### Microsoft Store reservations (2026-11-06, Partner Center, publisher "Dragos Catalin")

| Product | Store ID | Package identity |
|---|---|---|
| MixAI TV | `9P3WGV62ZRN5` | Name `DragosCatalin.MixAITV`, Publisher `CN=FE8B5839-E0F9-495F-854C-53165710EB07`, PFN `DragosCatalin.MixAITV_2n7wyqrzmk6fw` |
| MixAI Music | `9PC31TGKW4FP` | Name `DragosCatalin.MixAIMusic`, Publisher `CN=FE8B5839-E0F9-495F-854C-53165710EB07`, PFN `DragosCatalin.MixAIMusic_2n7wyqrzmk6fw` |
| MixAI Studio | `9NKKC4WGMX67` | idem |
| MixAI Decks (reserved as MixAI DJ; rename in Partner Center, D60) | `9P5P2WN26RMS` | idem |

Reservations expire if nothing is submitted within 3 months (by 2027-02-06).
`apps/tv-desktop/scripts/package-msix.ps1 -IdentityName DragosCatalin.MixAITV -Publisher 'CN=FE8B5839-E0F9-495F-854C-53165710EB07' -PublisherDisplay 'Dragos Catalin'`.
