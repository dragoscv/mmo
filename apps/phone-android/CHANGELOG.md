# Changelog — MixAI for Android phones

## 1.3.1 — 2026-11-10

WP17-102. versionCode 5.

- Search and the Library are requested for the active profile (`/media/search?profile=`, `/media/library?profile=`),
  so a profile with an age limit no longer sees titles above it in results or restricted files in the Library
  (needs MMO Server 3.15.0 for the Library part).

## 1.3.0 — 2026-11-08

WP17-101 (D59). versionCode 4.

- Approve a browser or TV from the phone: scanning the Quick Connect QR of music.mixai.ro/connect (or a TV) opens
  MixAI with "Connect this device?" and the code; Approve calls the paired server's `/pair/approve`. Links:
  `https://mixai.ro/pair?...`, `https://music.mixai.ro/pair?...`, `mixai://pair?...`. Warns when the code names
  another server. `https://mixai.ro/media/...` links now auto-verify (assetlinks lists the Play signing key).

## 1.2.0 — 2026-11-07

WP17-41h. versionCode 3.

- Music Now Playing has a "Play on" picker: MixAI TVs (hub, server 3.12 + TV Android 2.2 / Tizen 2.4), DLNA/UPnP
  renderers on the Wi-Fi and Home Assistant players. Queue and position move both ways; notification, lock screen and
  volume keys control the remote output; lost output falls back to the phone. Google Cast stays on the video player.

## 1.1.0 — 2026-11-05

Slice 2 (WP16-46, D38). versionCode 2.

- Downloads: original files (`GET /video/file/{id}`, Range) through a Media3 `DownloadManager` +
  `DownloadService` (foreground type dataSync, user-initiated) resumed by `WorkManagerScheduler`; per-profile list
  grouped by show and season, storage gauge, delete, Wi-Fi only; offline playback from the download cache (works in
  airplane mode, also when the server is unreachable).
- Smart downloads (D38): follow a show on its page; every 6 h on Wi-Fi while charging the next 3 unwatched episodes
  are kept downloaded and smart copies watched more than 24 h ago are deleted (WorkManager constraints).
- Offline-first progress: the queued `PUT /media/progress` entries flush as soon as the network returns.
- Play on TV + handoff (D38): device sheet lists hub `playbackTarget` devices; "Continue on TV" sends the current
  position and pauses the phone; "Pull back from <TV>" when a TV plays the same file. Google Cast button
  (Media3 `CastPlayer`, default receiver).
- Phone as TV remote: touchpad (tap play/pause, swipe seek ±10 s / next / previous), stop, home, shortcuts
  (movies, shows, music, Live TV, search) and text input to the TV search, with hub acks.
- Watch Together: create / join (deep link `mixai://together/<roomId>`), invite share sheet (web guest link),
  members, synced playback (core SyncMath drift correction), chat, reactions, report message, block member,
  host kick.
- Push: FCM (`firebase-messaging`, google-services), token registered at `/api/push/register` with the account
  session (skipped when not signed in), channels Recordings / Downloads / New episodes (RO+EN), deep links from the
  payload, notification permission asked in context.
- Native Google sign-in: Credential Manager `GetGoogleIdOption` → `/api/auth/native/google`; device code stays as
  fallback. Account session token stored with an Android Keystore AES-GCM key (decrypted once per process).
- Player extras (D38): night mode / dialogue boost (Media3 `AudioProcessor`: centre boost on 5.1, mid boost on
  stereo, compressor), second subtitles overlay, search inside subtitles (index on demand) with jump, scene
  bookmarks (add from the player, list on the title page, shareable with the household), sleep timer that fades to
  silence over 30 s (timed and end of episode), data saver prompt on mobile data with a per-title override.
- Kids: remaining minutes today for kid profiles, friendly "That is all for today" screen on the daily cap
  (`/media/profiles/{id}/usage`, 403 `daily_cap`); Family stats screen (`/media/stats/family`).
- Plex importer in Settings (`/media/import/plex`; the token is used once by the server and never stored).
- Karaoke word highlight in synced lyrics (enhanced LRC `<mm:ss.xx>` word tags). Lyrics translation is not built:
  the server has no translation endpoint.
- Sentry (`sentry-android`), env-gated by `MIXAI_SENTRY_DSN_PHONE`: off without a DSN; no PII, no screenshots or
  view hierarchy, no tracing, release = versionName.
- Unit tests: 104 (smart download selection, progress queue merge, room sync / drift, sleep fade curve, daily-cap
  UI state, night mode DSP, WebVTT, data saver, Play-on targets, remote gestures, karaoke).
- Play on a TV that is already playing sends `stop`, waits for the TV to report idle, then `play`: TV app 2.1.0
  crashes ("Session ID must be unique") when `play` replaces a running player. The phone player uses a unique
  MediaSession id per instance for the same reason.
- Verified on the Galaxy S25 (SM-S938B): Downloads (35.1 MB Blender film, played in airplane mode), music in the
  background with the screen off, Live TV channel, Play on TV / continue / pull back with the Chromecast, remote
  command acked by the TV, Watch Together room + chat, FCM token (registration skipped without account), Sentry off.

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
