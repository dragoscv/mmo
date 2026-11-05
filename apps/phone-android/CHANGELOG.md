# Changelog — MixAI for Android phones

## 1.0.0 — 2026-11-05

First native phone build (WP16-46 slice 1).

- Gradle module `:phone` inside the tv-android build, sharing `:core` (API client, repositories, generated models,
  MusicService). minSdk 31, targetSdk 36, compileSdk 37, application id `ro.mixai.app`.
- Shell: edge-to-edge, SplashScreen API, predictive back, Navigation 3 back stack with shared-element poster to title
  morph, adaptive navigation (bottom bar on phones, rail on tablets), mini-player above the bar.
- Onboarding: MixAI account device-code sign-in (Custom Tab + QR), LAN discovery, Quick Connect pairing, manual URL,
  profile picker with PIN pad.
- Home (cached first frame, hero, rows, pull to refresh), Title (parallax header, play/resume, versions, trailer,
  watchlist, watched, seasons and episodes, cast, where to watch, more like this).
- Player: Media3 with server HLS remux and direct play, touch controls, double-tap seek, scrub preview, brightness and
  volume swipes, long-press 2x, audio/subtitle picker, subtitle size, speed, fit/zoom, skip intro/recap, up next,
  still watching, sleep timer, picture-in-picture, progress sync.
- Search (library, TMDB, music, channels, voice, recent), Library grid (filters, A-Z rail), Music (home, artists,
  albums, playlists, album/artist pages, now playing with synced lyrics and queue), Live TV (channels with now/next,
  guide, player with zapping, first-use notice), Settings (profile, account, server, language, device name).
- Design tokens mirrored into the app (dark + light), Space Grotesk + Inter bundled, English + Romanian strings.
