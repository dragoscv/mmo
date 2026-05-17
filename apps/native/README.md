# @mmo/native — desktop + mobile shell

Native wrappers around https://muzicai.ro. Built with **Tauri 2** for desktop
(Windows / macOS / Linux) and **Capacitor** for mobile (iOS / Android).

## Why a shell, not a static export?

The web app already ships a PWA service worker, so a tiny shell that loads
the live origin gives us:

- Instant updates (no app-store re-review for content changes)
- Single source of truth for routing, auth, and data
- Native window chrome, dock/launcher icons, deep-linking, file pickers
- Offline support via the existing service worker cache

### Why no `@capacitor/live-updates` plugin?

The Capacitor `server.url` already points at `https://muzicai.ro`, so every
app launch fetches the latest Vercel deploy. There is no bundled web payload
to OTA-update — `dist/index.html` only exists as a fallback that immediately
redirects to the live origin. Adding `@capacitor/live-updates` (Capgo /
Appflow) would target the local `dist/` bundle that the app never actually
uses, so it is intentionally **not** wired up. The only reason to ship a new
store build is a change to native plugins, native config, or the WebView
shell itself.

## Local development

```sh
cd apps/native
pnpm install

# Desktop (Tauri)
pnpm tauri:icon            # one-off: generates icons from app/public/icon-512.png
pnpm tauri:dev             # opens the desktop shell against muzicai.ro

# Mobile (Capacitor)
pnpm cap:add:android       # one-off: scaffolds android/
pnpm cap:add:ios           # one-off: scaffolds ios/ (macOS only)
pnpm cap:open:android      # opens Android Studio
pnpm cap:open:ios          # opens Xcode
```

The generated `android/`, `ios/`, and `src-tauri/icons/` directories are
**gitignored**. CI regenerates them on each build so the repo stays clean.

## Production build

Triggered automatically on `native-v*` tag push, or manually via the
`native-release` workflow. Produces:

- **Windows**: `.msi` + `.exe` (NSIS, per-user install)
- **macOS**: `.dmg` + `.app.tar.gz` (unsigned by default; signed when Apple
    cert secrets are present)
- **Linux**: `.AppImage` + `.deb` + `.rpm`
- **Android**: `.apk` (debug + release-unsigned, or signed if a keystore
    secret is present) and `.aab` (Play-Store-ready)
- **iOS**: `.ipa` (unsigned by default; signed for App Store / TestFlight
    when Apple cert secrets are present)

All artifacts are attached to a GitHub Release. Store publishing (Apple App
Store, Google Play, Microsoft Store) runs as optional steps that **skip
gracefully** when the relevant secrets are not configured.

## Release flow

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml`, and
     `src-tauri/tauri.conf.json` (use the helper script when added).
2. Update `CHANGELOG.md` at repo root.
3. Tag: `git tag native-v0.1.0 && git push --tags`.
4. The `native-release` workflow builds, packages, and publishes.

## Required secrets (optional — workflow skips when missing)

| Secret                          | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `APPLE_CERTIFICATE`             | macOS / iOS code-signing certificate (base64 .p12)   |
| `APPLE_CERTIFICATE_PASSWORD`    | Password for the .p12                                |
| `APPLE_ID`                      | App Store Connect login                              |
| `APPLE_PASSWORD`                | App-specific password                                |
| `APPLE_TEAM_ID`                 | Apple Developer team ID                              |
| `APPLE_APP_STORE_API_KEY`       | App Store Connect API key (base64)                   |
| `APPLE_APP_STORE_API_KEY_ID`    | Key ID                                               |
| `APPLE_APP_STORE_API_ISSUER_ID` | Issuer ID                                            |
| `ANDROID_KEYSTORE`              | Android keystore (base64 .jks)                       |
| `ANDROID_KEYSTORE_PASSWORD`     | Keystore password                                    |
| `ANDROID_KEY_ALIAS`             | Key alias                                            |
| `ANDROID_KEY_PASSWORD`          | Key password                                         |
| `GOOGLE_PLAY_SERVICE_ACCOUNT`   | Google Play service account JSON                     |
| `WINDOWS_CERTIFICATE`           | Authenticode cert (base64 .pfx) for MS Store         |
| `WINDOWS_CERTIFICATE_PASSWORD`  | .pfx password                                        |
| `MS_STORE_TENANT_ID`            | Microsoft Partner Center tenant                      |
| `MS_STORE_CLIENT_ID`            | Microsoft Partner Center client                      |
| `MS_STORE_CLIENT_SECRET`        | Microsoft Partner Center secret                      |
| `MS_STORE_APP_ID`               | Microsoft Store app ID                               |
