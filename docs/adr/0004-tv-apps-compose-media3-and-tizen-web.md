# ADR-0004 — TV apps: Kotlin Compose for TV + Media3 on Android/Google TV; web .wgt on Tizen

- Status: Accepted · 2026-09-17

## Context
The user wants native MixAI TV apps for Android TV / Google TV and Samsung Tizen (the
Odyssey G8 runs Tizen Smart Hub), optimised for long-term performance. Options:
Capacitor over the existing web, `react-native-tvos` + Expo, Kotlin + Compose for TV.

## Decision
- **Android TV / Google TV**: Kotlin, **Compose for TV**, **Media3/ExoPlayer**,
  Leanback launcher. This is what Plex and Jellyfin ship; it gives passthrough audio,
  HDR/Dolby Vision, hardware codec queries for the DeviceProfile, native D-pad focus,
  and Play Store TV compliance for free. Code lives in `apps/tv-android`.
- **Samsung Tizen**: a web application (`.wgt`) is the only option. `apps/tv-tizen`
  is a **standalone** Vite + React 19 app (no imports from `apps/web`; hand-rolled
  D-pad focus in `src/lib/focus.ts`, generated `tokens.css` from
  `packages/design-tokens`), targeting Tizen's Chromium via `@vitejs/plugin-legacy`;
  sideloaded with `sdb` (Apps2Samsung path) and later submitted to the store.
  *(Corrected 2026-09-18 — the original text claimed it reused `apps/web` components.)*
- **Mobile (later)**: Kotlin Multiplatform + Compose Multiplatform, sharing the
  networking/model layer with the TV app; iOS from the same code when the Apple
  account exists.

## Rejected
- Capacitor: no Leanback, hand-rolled D-pad, webview playback limits (no passthrough,
  weak 4K/HDR). Fine for a demo, not for "best on the planet".
- react-native-tvos: single TS codebase is attractive, but the player is JS over
  ExoPlayer with limited codec control; Jellyfin moved away from it for TV.

## Consequences
- New toolchain in CI (JDK 17, Gradle 9.7, AGP 9.4, Android SDK 37). The Kotlin API
  client (`data/MmoApi.kt`) is **hand-written** over `HttpURLConnection` +
  kotlinx.serialization; generating it from an OpenAPI document is tracked as WP9-06
  in `docs/mixai-design-tracker.md`. *(Corrected 2026-09-18.)*
- Login on TV uses Quick Connect (6-digit code approved from a logged-in device).
