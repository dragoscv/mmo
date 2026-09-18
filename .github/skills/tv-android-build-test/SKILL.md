---
name: tv-android-build-test
description: Build the MixAI TV Android APK with Gradle in a hidden Java process (the shared terminal kills gradlew.bat), install and drive it on the Google TV over adb, and prove state via uiautomator dump and logcat instead of black screenshots. Use for any apps/tv-android change, after Models.kt/Tokens.kt regeneration, or for device verification of pairing/sign-in/playback. Trigger words: tv-android, gradle, assembleDebug, adb, Google TV, Chromecast, uiautomator, mixaiOrigin.
---

# Build + test apps/tv-android

Stack: Compose TV, Media3 1.11, AGP 9.4 (built-in Kotlin 2.4.20), compileSdk 37 / targetSdk 36 / minSdk 26.
Device: Google TV "Bedroom TV" (Chromecast `sabrina`) at `192.168.100.31` (adb port varies, e.g. `:38017`).

## Build (never `gradlew.bat` in the shared terminal — it dies at `Terminate batch job (Y/N)?`)
1. Write `.copilot-tmp/tv-build.ps1`:
   ```powershell
   $ErrorActionPreference = 'Continue'
   $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"   # JDK 17 — adjust if Studio lives elsewhere
   Set-Location E:\gh\mmo\apps\tv-android
   java -cp gradle\wrapper\gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleDebug -PmixaiOrigin=https://mixai.ro --console=plain
   "GRADLE_EXIT=$LASTEXITCODE"
   ```
   `-PmixaiOrigin` sets `BuildConfig.MIXAI_ORIGIN` (sign-in origin); point it at a dev web app
   (`http://192.168.100.61:13789`) or a local stub via `adb reverse tcp:13797 tcp:13797` + `http://127.0.0.1:13797`.
2. Run hidden and wait:
   ```powershell
   Start-Process pwsh -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','E:\gh\mmo\.copilot-tmp\tv-build.ps1' -WindowStyle Hidden -Wait -RedirectStandardOutput E:\gh\mmo\.copilot-tmp\tv-build.log
   Select-String -Path E:\gh\mmo\.copilot-tmp\tv-build.log -Pattern 'BUILD |GRADLE_EXIT|e: |error:' | Select-Object -Last 15
   ```
   Warm ≈ 7 s; after a `gradle.properties` change expect one slow run (`1 incompatible Daemon could not be reused`).
   APK: `app/build/outputs/apk/debug/app-debug.apk` (~14.5 MB).

## Install + drive
3. ```powershell
   $adb = "D:\platform-tools\adb.exe"       # or the SDK platform-tools
   & $adb connect 192.168.100.31; & $adb devices
   & $adb install -r E:\gh\mmo\apps\tv-android\app\build\outputs\apk\debug\app-debug.apk
   & $adb shell am start -n ro.mixai.tv/.MainActivity
   ```
   Wait ~10 s before sending keys (`input keyevent KEYCODE_DPAD_RIGHT/CENTER`); earlier keys are lost and
   `KEYCODE_BACK` exits the app (then a Plex "credentials expired" dialog may steal focus).
4. Keep the TV awake when the monitor is off (HDMI-CEC puts it to sleep within seconds):
   `settings put global hdmi_control_enabled 0`, `cmd hdmi_control cec_setting set hdmi_cec_enabled 0`,
   `settings put global stay_on_while_plugged_in 7` — restore `hdmi_control_enabled 1` afterwards.
5. Read state, don't screenshot:
   ```powershell
   & $adb shell rm -f /sdcard/ui.xml; & $adb shell uiautomator dump /sdcard/ui.xml; & $adb shell cat /sdcard/ui.xml
   ```
   Compose does not mark focused text nodes — find the focused `android.view.View` bounds and compare with the
   target text bounds. LazyRow DOM order ≠ visual order. Text input: `input text …` + `KEYCODE_TAB` + `KEYCODE_ENTER`.
6. Prove playback (SurfaceView screencaps are black/10 KB): `adb logcat -d | Select-String 'ExoPlayerImpl|MediaCodec'`
   shows `Init` + `setting surface`; server side, an established TCP connection from the TV to `:17899`.
7. Pairing/sign-in flows: server-side approve for tests `POST /pair/approve {code}` with `x-device-token`;
   device-code login needs the web origin reachable from the TV (mixai.ro DNS may not resolve on the LAN →
   "(network)" error; use the reverse-tunnel stub).

## Verify (report)
- `BUILD SUCCESSFUL` + `GRADLE_EXIT=0` quoted; APK size; `adb shell dumpsys activity activities | Select-String mixai`
  shows `ro.mixai.tv/.MainActivity` resumed; the uiautomator text you asserted on.
- `rg -n 'Color\(0x' apps/tv-android/app/src --glob '!**/Tokens.kt'` unchanged; `Models.kt`/`Tokens.kt` not hand-edited.

## Common failures
- `checkDebugAarMetadata` → compileSdk < 37 (compose-bom 2026.09, coil 3.6.2). Keep 37.
- `Unclosed comment` + whole file unresolved → `/video/*` glob inside `/** */`; use `//`.
- `Serializer has not been found for type … .Companion` → rename the `Companion` data class.
- `IllegalStateException` from `FocusRequester.requestFocus()` before layout → `delay(50)` + `runCatching`.
- `null root node` from uiautomator / 10 KB screencap → TV asleep (step 4) or app crashed (`logcat -d | Select-String FATAL`).
- Log file locked → a stuck `cmd.exe` from an earlier gradlew.bat; kill it, then use the java wrapper.
- `Plugin [id: 'org.jetbrains.kotlin.android'] was not found` → AGP 9 has built-in Kotlin; remove the plugin/`kotlinOptions`.
