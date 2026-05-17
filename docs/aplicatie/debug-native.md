# Debug the native shells

The Tauri (desktop) and Capacitor (iOS / Android) shells both wrap the
live https://muzicai.ro web app, so most bug reports look like web bugs.
This page covers the pieces that are specific to the native packaging.

## Quick triage

| Symptom                                              | First thing to check                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Native app opens to a blank/black window             | Network. The shell loads `https://muzicai.ro/` — confirm the URL works in a browser.                       |
| Deep-link tap opens Safari/Chrome instead of the app | Universal Links / App Links not verified — see [Deep links](#deep-links).                                  |
| OAuth (Google) fails inside the app                  | Capacitor `server.url` must be `https://muzicai.ro` so cookies / redirect URIs match what Google expects.  |
| Microphone / audio permission denied silently        | Native permission strings missing in Info.plist (iOS) or AndroidManifest.xml — see [Permissions](#permissions). |
| Auto-update never fires                              | The native shells do not auto-update; only the companion (electron) does. Native updates ship via stores.  |
| White flash on launch before the web app renders     | Splash screen — adjust `apps/native/index.html` (Capacitor) or the Tauri window `backgroundColor`.         |

## Tauri (desktop)

### Open the devtools

Release builds intentionally have devtools disabled. To open them, run
the dev shell:

```sh
cd apps/native
pnpm tauri:dev
```

Right-click → Inspect, or `Ctrl+Shift+I`. Console logs include both the
Rust side (`println!` in `src-tauri/`) and the JS side (everything from
muzicai.ro).

### Logs

- **Windows**: `%APPDATA%\ro.muzicai.app\logs`
- **macOS**: `~/Library/Logs/ro.muzicai.app`
- **Linux**: `~/.local/share/ro.muzicai.app/logs`

### Common Cargo / build failures

| Error                                                       | Fix                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `failed to find tool. Is webkit2gtk-4.1 installed?`         | `sudo apt install libwebkit2gtk-4.1-dev` (Tauri 2 needs 4.1, not 4.0). |
| `linker 'cc' not found`                                     | Install Rust's build tools: `xcode-select --install` / `apt install build-essential`. |
| `Bundle identifier ro.muzicai.app already taken`            | Increment `version` in `apps/native/src-tauri/tauri.conf.json`.      |

## Capacitor (iOS / Android)

### Android: open Chrome DevTools attached to the WebView

1. Plug the device in with USB debugging enabled.
2. In desktop Chrome navigate to `chrome://inspect#devices`.
3. The MMO WebView appears under the device. Click **Inspect**.
4. You get a full DevTools session against the live muzicai.ro page.

### iOS: open Safari Web Inspector

1. Enable Safari → Settings → Advanced → "Show Develop menu".
2. Enable Develop menu on the device: Settings → Safari → Advanced → "Web Inspector".
3. Plug the device in, open the app, then in desktop Safari:
   **Develop → \[iPhone Name\] → MMO**.

### Logs

```sh
# Android
adb logcat | grep -E "Capacitor|MMO"

# iOS (via Xcode)
# Window → Devices and Simulators → select device → "Open Console"
```

### Permissions

The Capacitor shell inherits whatever permissions the web app's
`Permissions-Policy` header allows. For OS-level prompts (microphone,
camera, files), make sure the platform manifest declares them:

- **iOS** (`ios/App/App/Info.plist`):
    - `NSMicrophoneUsageDescription`
    - `NSCameraUsageDescription`
    - `NSAppleMusicUsageDescription` (for the music library)
- **Android** (`android/app/src/main/AndroidManifest.xml`):
    - `android.permission.RECORD_AUDIO`
    - `android.permission.READ_MEDIA_AUDIO` (API 33+)

Capacitor regenerates these from `capacitor.config.ts` plugins on each
`pnpm cap:sync`.

## Deep links

The web app exposes two well-known files for app-link verification:

- `https://muzicai.ro/.well-known/apple-app-site-association` —
    universal links for iOS. Apple fetches this on install and refreshes
    it weekly via the CDN.
- `https://muzicai.ro/.well-known/assetlinks.json` — Android App Links.

Both are served by Next.js route handlers under
`app/src/app/.well-known/*/route.ts`. To enable real verification:

1. Set the deployment env:
    - `NEXT_PUBLIC_APPLE_TEAM_ID=<your 10-char team id>`
    - `NEXT_PUBLIC_ANDROID_CERT_FINGERPRINTS=<SHA256:colon-separated>,...`
2. Trigger a redeploy on Vercel.
3. On iOS: delete + reinstall the app for Apple's `swcd` daemon to
    re-fetch the AASA file.
4. On Android: `adb shell pm verify-app-links --re-verify ro.muzicai.app`.
5. Verify with:
    - iOS: `xcrun simctl openurl booted https://muzicai.ro/library`
    - Android: `adb shell am start -a android.intent.action.VIEW -d https://muzicai.ro/library`

If either tap opens the system browser instead of the app, run the
[Apple App Search API validator](https://search.developer.apple.com/appsearch-validation-tool/)
or
[Google's statement list test](https://developers.google.com/digital-asset-links/tools/generator)
to confirm the file is reachable and well-formed.

## Reporting bugs

When filing native-specific issues, please include:

- Platform + OS version
- App version (Settings → About in the app, or the binary filename)
- Whether the same flow works at https://muzicai.ro in a regular browser
    on the same device (helps separate web bugs from native bugs)
- Screenshot or screen recording
- Console / logcat output if the device is plugged in
