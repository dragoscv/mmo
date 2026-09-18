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
  app/src/main/java/ro/mixai/tv/
    MainActivity.kt             back-stack navigation (Screen sealed interface) + locale override
    MixaiApp.kt                 Application → Settings (DataStore)
    data/                       MmoApi (HttpURLConnection + kotlinx.serialization), Models, Settings,
                                Discovery (NsdManager), DeviceAuth (mixai.ro device-code flow)
    player/PlayerScreen.kt      ExoPlayer + PlayerView + MediaSession, resume, D-pad keys
    ui/                         Welcome, SignIn, Discover, Pair, Connect, Home, Movie, Show, Album,
                                Settings, SpriteStill, Skeleton, EmptyState
    ui/theme/Tokens.kt          GENERATED design tokens — never edit
    ui/theme/MixaiTheme.kt      MaterialTheme colour scheme + focus helpers built from Tokens
  app/src/main/res/values/      strings.xml (EN), colors.xml, themes.xml
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

- **Quick Connect** — mDNS discovery of `_mmo-companion._tcp`, 6-digit code + QR, polls `/pair/poll`.
- **MixAI account sign-in** — device-code flow on `BuildConfig.MIXAI_ORIGIN` (`/api/device/code|token`),
  then probes the returned companions and connects to the first reachable one.
- **Manual connect** — host + device token fallback.
- **Home** — Continue watching · Movies · TV shows (episodes grouped by title) · Albums (OpenSubsonic).
- **Movies / episodes** — direct play (mp4/mkv/webm with h264/hevc/vp9/av1) or HLS transcode, subtitles as VTT.
- **Resume** — per-device positions (saved every 5 s, on pause and on exit; dropped under 10 s or past 95 %).
- **MediaSession** — remote transport keys and system now-playing via `media3-session`.
- **Settings** — server info (`/health`), language System / RO / EN, clear resume data, change server, sign out.
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
`mixaiCardScale()` (1.06 focused), `mixaiCardColors()`. `res/values/colors.xml` (banner, launcher,
window background) mirrors the same hex values by hand; keep them in sync when tokens change.
No screen may use a literal `Color(0x…)` — only `Tokens.*` (QR black-on-white and the player's black
backdrop are the exceptions).

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
