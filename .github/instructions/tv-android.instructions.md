---
applyTo: "apps/tv-android/**"
description: "MixAI TV for Android/Google TV (Compose TV, Media3, AGP 9.4, Kotlin 2.4): build via hidden Gradle, generated Models.kt and Tokens.kt, device testing"
---

# apps/tv-android — Compose TV app (package `ro.mixai.tv`)

## Rules
- Versions live in `gradle/libs.versions.toml`: AGP 9.4.0, Kotlin 2.4.20, Media3 1.11.1, compileSdk 37,
  targetSdk 36, minSdk 26. AGP 9 has BUILT-IN Kotlin: no `org.jetbrains.kotlin.android` plugin, no
  `kotlinOptions {}`; KGP pinned via root `buildscript { dependencies { classpath(libs.kotlin.gradle.plugin) } }`.
- **Generated files — never edit by hand**: `app/src/main/java/ro/mixai/tv/ui/theme/Tokens.kt` (from
  `pnpm tokens:build`) and `app/src/main/java/ro/mixai/tv/data/generated/Models.kt` (from
  `pnpm -C server openapi:gen`). A literal `Color(0xFF…)` outside `Tokens.kt` is a bug — use `Tokens.*`.
- Web origin for sign-in is a build property: `-PmixaiOrigin=https://…` → `BuildConfig.MIXAI_ORIGIN`
  (`buildFeatures.buildConfig = true`). Device-code login (`data/DeviceAuth.kt`), Quick Connect pairing
  (`data/Discovery.kt` NsdManager `_mmo-companion._tcp`, `ui/PairScreen.kt`).
- Media Home (WP12-01): `MediaRepository` on `/media/*`, `ProviderLauncher` needs `<queries>` in the manifest
  for `setPackage` intents + fallback to the web URL; progress via server with local fallback queue.
- RO/EN strings in `res/values` + `values-ro`; locale override via `createConfigurationContext`
  (`MainActivity.LocalizedContent`).
- Release: tag `tv-v*` → `tv-android-release.yml`. Bump `versionCode`/`versionName` in `app/build.gradle.kts`.

## Build — never in the shared terminal
`gradlew.bat` in the shared pwsh dies at `Terminate batch job (Y/N)?` (a foreign Ctrl+C) and the stuck
cmd.exe keeps the log locked. Use the Java wrapper in a hidden process:

```powershell
# .copilot-tmp/tv-build.ps1
$env:JAVA_HOME = "<Android Studio>\jbr"          # JDK 17
Set-Location E:\gh\mmo\apps\tv-android
java -cp gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleDebug -PmixaiOrigin=https://mixai.ro
```
`Start-Process pwsh -ArgumentList '-NoProfile','-File','.copilot-tmp/tv-build.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput .copilot-tmp/tv-build.log`.
Warm build ≈ 7 s, APK `app/build/outputs/apk/debug/app-debug.apk` (~14.5 MB). Skill `tv-android-build-test`.

## Device testing (Google TV "Bedroom TV", adb over LAN)
- `adb connect 192.168.100.31` (port varies, e.g. `:38017`); `adb install -r <apk>`;
  `adb shell am start -n ro.mixai.tv/.MainActivity`; wait ~10 s before D-pad input (earlier keys are lost).
- Read UI via `adb shell uiautomator dump` + `cat /sdcard/window_dump.xml` — screenshots of SurfaceView
  playback are BLACK (protected layer); prove playback with logcat `ExoPlayerImpl` / `MediaCodec … setting surface`
  + an established TCP connection to `:17899`.
- `rm -f /sdcard/ui.xml` before a dump (a stale one survives crashes). Compose text fields swallow D-pad →
  `input text` + `KEYCODE_TAB` + `KEYCODE_ENTER`; don't spam `KEYCODE_BACK` (exits app).
- TV sleeps via HDMI-CEC when the monitor is off: `settings put global hdmi_control_enabled 0` +
  `stay_on_while_plugged_in 7` for the session; restore afterwards.

## Gotchas (exact strings)
- `checkDebugAarMetadata` fails: compose-bom 2026.09 / coil 3.6.2 require compileSdk ≥ 37 — do not lower it.
- `Unclosed comment` + every symbol unresolved → a `/video/*` glob inside a `/** */` KDoc opened a nested
  comment; use `//` for URL globs.
- `Serializer has not been found for type X.Companion` → a `@Serializable data class Companion` collides with
  the generated companion object; name it `CompanionServer`.
- `IllegalStateException` on `FocusRequester.requestFocus()` in a `LaunchedEffect` before first layout →
  `delay(50)` + `runCatching`.
- `1 incompatible Daemon could not be reused` after editing `gradle.properties` → one slow build, then normal.
- PowerShell: `-not (rg -q …)` is ALWAYS true → use `@(rg -n …).Count`.

## Verify
- Build log ends with `BUILD SUCCESSFUL`; `git --no-pager status --short apps/tv-android` shows no generated-file drift.
- `rg -n 'Color\(0x' apps/tv-android/app/src --glob '!**/Tokens.kt'` returns nothing new.
- On device: `adb shell dumpsys activity activities | Select-String mixai` shows the activity resumed.
