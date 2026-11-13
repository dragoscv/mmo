# MixAI TV — Android TV / Google TV app

Native Android TV client for MMO Server (the MixAI companion). Kotlin, Jetpack Compose for TV
(`androidx.tv:tv-material`), Media3/ExoPlayer, DataStore. Sibling of `apps/tv-tizen` (Samsung)
— same server API, same Romanian/English wording.

## Layout

```
apps/tv-android/
  build.gradle.kts              root: plugins via the version catalog (AGP 9 built-in Kotlin)
  gradle/libs.versions.toml     EVERY version lives here (deps, plugins, compile/target/minSdk)
  gradle/wrapper/               Gradle 9.7.1
  app/build.gradle.kts          android {} + dependencies via libs.* aliases
  core/                         Android library `:core` (namespace ro.mixai.core, packages ro.mixai.tv.*):
                                data/ (MmoApi, repositories, generated/Models.kt, Settings, HubClient,
                                DeviceAuth, Discovery, ClientIdentity) + player/MusicService — shared with
                                the phone app; no resources, identity set by MixaiApp
  app/src/main/java/ro/mixai/tv/
    MainActivity.kt             back-stack navigation (Screen sealed interface) + locale override
    MixaiApp.kt                 Application → ClientIdentity + Settings (DataStore)
    BrandSound.kt               brand signature at cold start (res/raw/brand_signature.wav), once per process
    data/                       TV-only: WatchNext (launcher channel), ProviderLauncher
    player/PlayerScreen.kt      ExoPlayer + PlayerView + MediaSession, resume, D-pad keys
    ui/                         Welcome, SignIn, Discover, Pair, Connect, Home, Movie, Show, Album,
                                Settings, SpriteStill, Skeleton, EmptyState
    ui/theme/Tokens.kt          GENERATED design tokens — never edit
    ui/theme/Brand.kt           GENERATED mark + product glyphs (`BrandMark`) — never edit
    ui/theme/MixaiTheme.kt      MaterialTheme colour scheme + focus helpers built from Tokens
  app/src/main/res/values/      strings.xml (EN), themes.xml; colors.xml + brand.xml are GENERATED
  app/src/main/res/values-ro/   strings.xml (RO)
```

## Build

```powershell
cd apps/tv-android
.\gradlew.bat assembleDebug                                        # debug APK
.\gradlew.bat assembleDebug -PmixaiOrigin=http://192.168.100.61:13789   # point sign-in at a dev web app
.\gradlew.bat assembleRelease                                      # signed when TV_KEYSTORE_B64 etc. are set
```

Requirements: JDK 17 (Android Studio JBR works), Android SDK with platform 37 (compileSdk) —
`compose-bom 2026.09` / `coil 3.6` AARs refuse anything lower. targetSdk 36, minSdk 26.
Output: `app/build/outputs/apk/debug/app-debug.apk`.

Release signing reads `TV_KEYSTORE_B64`, `TV_KEYSTORE_PASSWORD`, `TV_KEY_ALIAS`, `TV_KEY_PASSWORD`
from the environment (CI); unset → unsigned release.

## Sideload onto a Google TV / Chromecast

```powershell
adb connect 192.168.100.31
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n ro.mixai.tv/.MainActivity
```

## Features

## Fire TV (Amazon Appstore, WP17-21)

The same `ro.mixai.tv` APK runs on Fire TV — no `amazon` flavor is needed:

- `:app` and `:core` have **no Google Play Services** dependency (Firebase / Credential Manager are phone-only).
  Checked 2026-11-06: 0 `Lcom/google/android/gms/` references in the dex of the benchmark APK.
- `minSdk 26` covers Fire OS 7 (API 28) and Fire OS 8 (API 30); Fire OS 6 (API 25) devices are filtered out.
- `android.software.leanback` is required, which is what the Appstore uses to offer the app to Fire TV only.
- Fire OS has no Android TV home rows: `WatchNext.publish` already no-ops when the TvProvider is missing.
- Upload the **release** APK signed with the TV key (`TV_KEYSTORE_*`, same key as Google Play builds so updates keep
  working across stores), target devices "Fire TV" only, reviewer path = `docs/store/review-notes.md` (demo server).


- **Quick Connect** — mDNS discovery of `_mmo-companion._tcp`, 6-digit code + QR, polls `/pair/poll`.
- **MixAI account sign-in** — device-code flow on `BuildConfig.MIXAI_ORIGIN` (`/api/device/code|token`),
  then probes the returned companions and connects to the first reachable one.
- **Manual connect** — host + device token fallback.
- **Home** — Continue watching · Movies · TV shows (episodes grouped by title) · Albums (OpenSubsonic).
- **Movies / episodes** — direct play (mp4/mkv/webm with h264/hevc/vp9/av1) or HLS transcode, subtitles as VTT.
- **Resume** — per-device positions (saved every 5 s, on pause and on exit; dropped under 10 s or past 95 %).
- **MediaSession** — remote transport keys and system now-playing via `media3-session`.
- **Settings** — server info (`/health`), language System / RO / EN, clear resume data, change server, sign out.
- **Startup sound** — the brand signature plays once per cold start after the first frame, on the media stream at
  the TV's volume; silent when something else is playing. Settings › Playback › Sound turns it off (per device,
  DataStore key `startup_sound`, default on). Phones have no startup sound.
- **RO / EN** — all UI strings in `values/` + `values-ro/`; the override is applied through a
  `createConfigurationContext` wrapper (no AppCompat needed).

## Server API used

| Purpose | Endpoint | Auth |
| --- | --- | --- |
| Health / version | `GET /health` | none |
| Pair info | `GET /pair/info` | none |
| Pair request / poll | `POST /pair/request`, `GET /pair/poll?code&secret` | none |
| Token check | `GET /video/flags` | `x-device-token` |
| Library | `POST /video/scan {}` → `files[]` (movies + episodes, ffprobe metadata) | `x-device-token` |
| Direct play | `GET /video/direct/:fileId?t=` | `t` query |
| HLS transcode | `GET /video/stream/:fileId?q=720p&t=` | `t` query |
| Subtitles (VTT) | `GET /video/subs/:fileId/:ordinal?t=` | `t` query |
| Card stills | `GET /video/thumbs/:fileId/sprite.jpg?t=` — 12×12 grid of 160×90 tiles; 503 until ffmpeg finishes | `t` query |
| Albums / tracks | `GET /rest/getAlbumList2.view`, `getAlbum.view`, `search3.view`, `stream.view`, `getCoverArt.view` | `apiKey` query |
| Account sign-in | `POST {MIXAI_ORIGIN}/api/device/code`, `/api/device/token` | none |

## Design tokens

`ui/theme/Tokens.kt` is **generated** by `pnpm -C packages/design-tokens build` — never edit it by
hand. `MixaiTheme.kt` maps it onto `darkColorScheme` and exposes `mixaiCardBorder()` (4 dp ring),
`mixaiCardScale()` (1.06 focused), `mixaiCardColors()`. `res/values/colors.xml` (window background) is
generated by the same build.
No screen may use a literal `Color(0x…)` — only `Tokens.*` (QR black-on-white and the player's black
backdrop are the exceptions).

## Brand

Launcher icon (`mipmap-anydpi-v26/ic_launcher.xml`, `drawable/ic_launcher_foreground.xml`,
`drawable/ic_launcher_monochrome.xml`), TV banner (`drawable/banner.xml`), `values/brand.xml`,
`raw/brand_signature.wav` and `ui/theme/Brand.kt` are **generated** by `brand/scripts/build.mjs` (ADR-0016) —
never edit them by hand. In-app, draw the mark with `BrandMark(product = BrandProduct.Tv, …)`; pass
`decorative = true` when the app name is written next to it. Android TV has no system splash animation.

## Version catalog

All versions are in `gradle/libs.versions.toml`. AGP 9 provides Kotlin itself (no
`org.jetbrains.kotlin.android` plugin); the Kotlin version is pinned by putting
`kotlin-gradle-plugin` on the root `buildscript` classpath and reused by the compose /
serialization plugins.

## Known limitations

- No TMDB posters: `/video/scan` exposes no artwork, so cards use one tile of the scrubber sprite
  (tile 14 ≈ 10 % into the film). A film whose sprite has not been generated shows its title.
- Resume positions are per device (DataStore), not synced through the account.
- Episode grouping relies on `parsed.season`/`parsed.episode` from the file name (S01E02 style).
- `tv-foundation` is not used; the app relies on `tv-material` + standard Compose foundation.
