# @mmo/native — desktop + mobile shell

Native wrappers around https://mixai.ro. Built with **Tauri 2** (`@tauri-apps/*`
2.11) for desktop (Windows / macOS / Linux) and **Capacitor 8** for mobile
(iOS / Android, incl. Android TV compatibility — see `ANDROID_TV.md`).

## Bootstrap page & design tokens

`web/index.html` is the only bundled page: a MixAI-branded sign-in bootstrap
(RO/EN by `navigator.language`) that forwards to the live origin. It uses only
CSS variables from `web/tokens.css`, which is **generated** by
`packages/design-tokens` (`pnpm tokens:build` at root) — never edit it by hand.
Light/dark is resolved before paint from `localStorage["mixai:prefs:v1"]`
(the same prefs blob the web app writes) with a `prefers-color-scheme`
fallback, and the page pads for `env(safe-area-inset-*)` (`viewport-fit=cover`).

Tauri serves `web/` directly (`frontendDist`); Capacitor needs `dist/`, which
`pnpm build:web` (`scripts/build-web.mjs`, no deps) produces by copying `web/`.
Every `cap:*` script runs it first.

## Capacitor 8 notes

- Requires Node 22+, Android Studio Otter (2025.2.1)+, Xcode 26+.
- `android/` is **tracked** (AGP 8.13, Gradle 8.14.3, min/compile/target SDK
    24/36/36 per the [7→8 guide](https://capacitorjs.com/docs/updating/8-0)); only
    build output and the files `cap sync` regenerates are gitignored.
- `ios/` is still generated on demand (`pnpm cap:add:ios`, SPM template by
    default in Capacitor 8; add `--packagemanager CocoaPods` for Pods).
- Edge-to-edge margins are no longer adjusted natively; the web app uses the
    `--safe-*` tokens (`env(safe-area-inset-*)`).

## Why a shell, not a static export?

The web app already ships a PWA service worker, so a tiny shell that loads
the live origin gives us:

- Instant updates (no app-store re-review for content changes)
- Single source of truth for routing, auth, and data
- Native window chrome, dock/launcher icons, deep-linking, file pickers
- Offline support via the existing service worker cache

### Why no `@capacitor/live-updates` plugin?

The Capacitor `server.url` already points at `https://mixai.ro`, so every
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
pnpm tauri:icon            # one-off: generates icons from apps/web/public/icon-512.png
pnpm tauri:dev             # opens the desktop shell against mixai.ro

# Mobile (Capacitor)
pnpm build:web             # web/ → dist/ (also run by every cap:* script)
pnpm cap:sync android      # copies dist/ + config into the tracked android/ project
pnpm cap:add:ios           # one-off: scaffolds ios/ (macOS only)
pnpm cap:open:android      # opens Android Studio
pnpm cap:open:ios          # opens Xcode
```

`ios/`, `dist/` and `src-tauri/icons/` are **gitignored** and regenerated on
each build; `android/` is tracked because its manifest carries the TV/Leanback
declarations.

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

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml`,
    `src-tauri/tauri.conf.json` and `android/app/build.gradle`
    (`versionName` / `versionCode`). Current: **1.0.0**.
2. Update `CHANGELOG.md` at repo root.
3. Tag: `git tag native-v1.0.0 && git push --tags`.
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
