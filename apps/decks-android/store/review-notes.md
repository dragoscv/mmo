# MixAI Decks — store review notes (ro.mixai.dj)

Paste into **App access** (Google Play), **Notes** (App Store Connect) and **Notes for certification** (Partner Center).

```
MixAI Decks is a DJ app for music files the user owns. No account and no login are needed.
To review: open the app, tap "Scan folder" (Android: grant music access) and pick any folder with MP3/FLAC/WAV
files (the device needs at least two music files). Load a track on deck A and deck B
(tap a row, then "Load to A/B"), press Play, move the crossfader.
AI mix: tap "AI mix" > "Suggest next" > "Load", then "Auto mix" - the transition runs by itself.
Connect: tap "Connect" > On. The QR codes open a phone remote / party request page in any browser on the same
Wi-Fi (local network only, nothing goes to the internet).
REC: tap "REC", play for 30 s, stop; the tracklist and exports (CUE, CSV, Mixcloud) appear.
All processing (analysis, stems, AI suggestions) runs on the device. No ads, no tracking, no data collection.
Microphone / audio input is used only if the user enables timecode vinyl (DVS).
Support: support@mixai.ro
```

## Facts behind the notes

| Claim | Where it is implemented |
|---|---|
| No account / login | `apps/decks-android` has no sign-in screen |
| Local network only | `decks-remote` binds the LAN, no relay ([remote.md](../../../docs/decks/remote.md)) |
| On-device AI | `decks-transition` is pure Rust, no network ([transitions.md](../../../docs/decks/transitions.md)) |
| On-device stems | `decks-stems` ONNX Runtime ([stems.md](../../../docs/decks/stems.md)) |
| Tracklist exports | `decks-setlog` ([set-recording.md](../../../docs/decks/set-recording.md)) |

## Store records

| Store | Record | State (2026-11-09) |
|---|---|---|
| Google Play | `ro.mixai.dj` | to create in Play Console (owner); upload `:decks:bundleRelease` AAB to internal testing |
| Microsoft Store | 9P5P2WN26RMS (ex "MixAI DJ") | listing rename to "MixAI Decks" waits on the owner in Partner Center |
| App Store / Mac App Store | `ro.mixai.dj` | App ID + ASC records wait on the owner (no create-app API) |

Listing copy: [`listing.json`](listing.json) (EN + RO). Data safety / privacy labels: [`data-safety.json`](data-safety.json).
Privacy policy: https://mixai.ro/privacy (section "MixAI Decks"). Check: `node scripts/decks-store-check.mjs`.
