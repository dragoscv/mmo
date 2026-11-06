# MixAI app inventory (2026-11-06)

Canonical list of every app and surface, today and target. Decisions: [ADR-0013](../adr/0013-product-family-and-domains.md).
Work: tracker §12 WP17. Update this table in the same commit as any release, rename or new store listing.

## Today

| Surface | Path | Name today | ID | Version | Purpose | Distribution today |
|---|---|---|---|---|---|---|
| Web | `apps/web` | MixAI | — | 3.1.7 | Watching (`/media`) + organizer + DJ live + AI | Cloud Run, `mixai.ro` |
| Android TV | `apps/tv-android` | MixAI TV | `ro.mixai.tv` | 2.1.2 | Watching | Sideload / CI artifact |
| Phone Android | `apps/phone-android` | MixAI | `ro.mixai.app` | 1.1.0 | Watching, remote, downloads | **Google Play production, live 2026-11-06** |
| iPhone | `apps/ios` | MixAI | `ro.mixai.app` | 1.1.0 | Watching, remote, downloads, widgets | App Store, waiting for review |
| Apple Watch | `apps/ios/MixAIWatch` | MixAI | `ro.mixai.app.watchkitapp` | 1.1.0 | Remote, now playing | Not embedded in 1.1.x |
| Samsung TV | `apps/tv-tizen` | MixAI TV | `mXa1TvApp0` | 2.2.0 | Watching | Sideload (signed `.wgt`) |
| Web shell | `apps/native` | MixAI | `ro.mixai.app` (clash) | 1.0.0 | Tauri/Capacitor wrapper that loads `mixai.ro` | GH Release |
| DJ | `apps/mixai` | MixAI DJ | `ro.mixai.dj` | 1.0.0 | DJ / creation | Not released |
| Extension | `apps/extension` | MixAI downloader | `mixai-downloader@mixai.ro` | 3.0.1 | Download helper | Release workflow exists, not published |
| Server | `server` | MixAI Companion — MMO Server | `ro.mixai.companion` | 3.9.6 | Server | GH Release, Docker, Pi |
| Gateway | `apps/gateway` | — | — | 0.1.0 | Infra | Cloud Run |

## Target

| Product | Platform | Store | Path (planned) | ID | Tracker |
|---|---|---|---|---|---|
| MixAI TV | Android TV / Google TV | Google Play | `apps/tv-android` | `ro.mixai.tv` | WP17-20 |
| MixAI TV | Fire TV | Amazon Appstore | `apps/tv-android` (flavor `amazon`) | `ro.mixai.tv` | WP17-21 |
| MixAI TV | Samsung Tizen | Samsung Seller Office (Partner) | `apps/tv-web` (ex tv-tizen) | `mXa1TvApp0` | WP17-22 |
| MixAI TV | LG webOS | LG Content Store | `apps/tv-web` platform `webos` | `ro.mixai.tv` | WP17-23 |
| MixAI TV | Apple TV | App Store (universal with iOS) | `apps/ios` tvOS target | `ro.mixai.app` | WP17-24 |
| MixAI TV | Windows | Microsoft Store (MSIX) | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-25 |
| MixAI TV | macOS | Mac App Store + DMG | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-26 |
| MixAI TV | Linux | Flathub | `apps/tv-desktop` | `ro.mixai.tv.desktop` | WP17-27 |
| MixAI TV | Web | `tv.mixai.ro` (PWA) | `apps/web` host routing | — | WP17-10 |
| MixAI TV | Android phone/tablet | Google Play | `apps/phone-android` (rename) | `ro.mixai.app` | WP17-28 |
| MixAI TV | iPhone/iPad | App Store | `apps/ios` (rename, iPad) | `ro.mixai.app` | WP17-29 |
| MixAI Music | Web | `music.mixai.ro` (PWA) | `apps/web` host routing | — | WP17-40 |
| MixAI Music | Android, iOS, desktop, TV now-playing | Play, App Store, MS Store, Mac App Store, Flathub | `apps/music-android`, `apps/ios` target, `apps/tv-desktop` profile | `ro.mixai.music` | WP17-41..45 |
| MixAI Studio | Web + desktop shell | `app.mixai.ro`, MS Store | `apps/web`, `apps/native` | `ro.mixai.studio` | WP17-11, WP17-50 |
| MixAI DJ | Windows/macOS/Linux | MS Store, Mac App Store, Flathub, GH | `apps/mixai` | `ro.mixai.dj` | WP17-51 |
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
