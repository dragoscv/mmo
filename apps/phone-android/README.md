# MixAI for Android phones (`ro.mixai.app`)

Native Kotlin / Jetpack Compose phone + tablet app (WP16-46, tracker decisions D34, D36–D38). It replaces the
Capacitor shell in the stores under the same application id.

## Layout

- Gradle module `:phone` = `apps/phone-android/app`, **built by the `apps/tv-android` Gradle build**
  (`settings.gradle.kts`: `include(":phone")` + `projectDir`). It shares `:core` (`apps/tv-android/core`: MMO Server
  API client, repositories, generated OpenAPI models, MusicService) and the version catalog
  `apps/tv-android/gradle/libs.versions.toml`.
- `ro.mixai.app`: `MixaiPhoneApp` (ClientIdentity `android-phone`, Coil, Settings), `MainActivity` (edge-to-edge,
  SplashScreen, predictive back, PiP, deep links `mixai://title/<kind>/<id>` and `https://mixai.ro/media/<kind>/<id>`),
  `AppRoot` (connection graph, splash checks, Navigation 3 `NavDisplay` inside `SharedTransitionLayout`,
  `NavigationSuiteScaffold`: bottom bar on phones, rail on tablets/foldables).
- `ui/onboarding` (Welcome, device-code sign-in with Custom Tabs + QR, LAN discovery, Quick Connect pairing, manual
  URL), `ui/profiles` (picker + PIN pad), `ui/home`, `ui/title`, `ui/player`, `ui/search`, `ui/library`, `ui/music`,
  `ui/live`, `ui/settings`, shared `ui/components` and `ui/media`.
- Theme: `ui/theme/Tokens.kt` is **generated** by `packages/design-tokens` (`pnpm tokens:build`, dark `Tokens` +
  `TokensLight`); never hand-edit it. Fonts: Space Grotesk + Inter variable TTF (SIL OFL 1.1, licences in
  `src/main/assets/licenses`). Dynamic colour is off (brand).
- Strings: `res/values/strings*.xml` + `res/values-ro/strings*.xml`, identical key sets.

## Build (Windows)

Run Gradle as a hidden Java process from `apps/tv-android` (the shared terminal kills `gradlew.bat`):

```powershell
$env:JAVA_HOME = "$env:ProgramFiles\Android\Android Studio\jbr"
Start-Process "$env:JAVA_HOME\bin\java.exe" -ArgumentList '-classpath','gradle\wrapper\gradle-wrapper.jar','org.gradle.wrapper.GradleWrapperMain',':phone:assembleDebug',':phone:testDebugUnitTest' -WorkingDirectory E:\gh\mmo\apps\tv-android -WindowStyle Hidden -RedirectStandardOutput E:\gh\mmo\.copilot-tmp\phone\build.log -PassThru
```

- `-PmixaiOrigin=http://<host>:13789` points account sign-in at another web origin (default `https://mixai.ro`).
- `-PmixaiWebOrigin=https://mixai.ro` = origin for push registration and native Google sign-in. Default is the Cloud
  Run URL `https://mixai-web-622082681070.europe-west1.run.app` while mixai.ro DNS is pending.
- `-PmixaiGoogleWebClientId=...` = Google OAuth "web" client the ID token is requested for (default = apps/web
  `AUTH_GOOGLE_ID`, a public client id). The web must list it in `AUTH_GOOGLE_ID` / `GOOGLE_NATIVE_CLIENT_IDS`.
- `-PMIXAI_SENTRY_DSN_PHONE=https://...` (or env `MIXAI_SENTRY_DSN_PHONE`) turns on Sentry. Without it Sentry is
  never initialised (logcat `MixaiSentry: Sentry disabled (no DSN)`).
- `assembleBenchmark` = release code (R8, not debuggable) signed with the debug key — measure performance only there.
- Release signing: `PHONE_KEYSTORE_B64`, `PHONE_KEYSTORE_PASSWORD`, `PHONE_KEY_ALIAS`, `PHONE_KEY_PASSWORD`.

## Slice 2 features and where they live

| Feature | Code | Server / web contract |
|---|---|---|
| Downloads, offline playback | `downloads/DownloadCenter.kt`, `MixaiDownloadService.kt`, `ui/downloads` | `GET /video/file/{id}` (Range, `?t=&profile=&pt=`) |
| Smart downloads | `downloads/SmartDownloads.kt` (pure), `SmartDownloadWorker.kt` | `/media/title`, `/media/season` progress |
| Offline progress queue | `data/ProgressQueue.kt` (core `ProgressSync` queues, flusher sends on reconnect) | `PUT /media/progress` |
| Play on TV, handoff, Cast | `ui/playon/PlayOn.kt`, player OSD, `cast/CastSupport.kt` | hub `cmd play/stop/pause`, `devices[].playbackTarget` |
| Remote | `ui/remote` | hub `navigate`, `text`, `pause/resume`, `seek`, `next/previous`, `stop` |
| Watch Together | `ui/together` (`RoomSync.kt` = drift loop used by the player) | hub `room:*`, `report`, `block`, `kick` |
| Push | `push/PushService.kt`, `push/Channels.kt` | `POST/DELETE /api/push/register` (Bearer account session) |
| Google sign-in | `auth/GoogleSignIn.kt`, `data/SessionVault.kt` | `POST /api/auth/native/google {idToken, nonce}` |
| Player extras | `ui/player/{DialogueBoost,DualSubtitles,PlayerExtras,Network,SleepTimer}.kt` | `/media/bookmarks`, `/media/subtitles/search|index`, `/video/subs` |
| Kids caps, family | `ui/kids/KidsCap.kt`, `ui/family` | `/media/profiles/{id}/usage`, 403 `daily_cap`, `/media/stats/family` |
| Plex import | `ui/settings/PlexImportScreen.kt` | `POST /media/import/plex` |

Push needs a MixAI account session (Google or device-code sign-in). A phone paired only to a local MMO Server has
no account, so it fetches an FCM token but skips registration (logcat `MixaiPush: push register skipped: not signed
in`).

## Data safety (Play)

- Crash reports (Sentry) only in builds with a DSN: crash stack traces, device model, OS and app version. No user
  id, e-mail, IP (`sendDefaultPii=false`), screenshots, view hierarchy or performance traces.
- Push: the FCM token, device name and active profile id are sent to the MixAI web for the signed-in account and
  deleted on sign-out (`DELETE /api/push/register`).
- The Plex token typed in the importer goes only to the user's own MMO Server for that one import; the app does
  not store it.
- Account session token: encrypted at rest with an Android Keystore key; backups are off (`allowBackup=false`).

## Install on a phone

```powershell
D:\platform-tools\adb.exe -s <serial> install -r app\build\outputs\apk\debug\phone-debug.apk
```

Without a mixai.ro session, pair with a local MMO Server: Welcome, Connect to a server on this network, pick the
server, then approve the 6-digit code in MixAI or the MMO Server app (`POST /pair/approve`).
