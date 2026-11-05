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
- `assembleBenchmark` = release code (R8, not debuggable) signed with the debug key — measure performance only there.
- Release signing: `PHONE_KEYSTORE_B64`, `PHONE_KEYSTORE_PASSWORD`, `PHONE_KEY_ALIAS`, `PHONE_KEY_PASSWORD`.

## Install on a phone

```powershell
D:\platform-tools\adb.exe -s <serial> install -r app\build\outputs\apk\debug\phone-debug.apk
```

Without a mixai.ro session, pair with a local MMO Server: Welcome, Connect to a server on this network, pick the
server, then approve the 6-digit code in MixAI or the MMO Server app (`POST /pair/approve`).
