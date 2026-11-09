# ADR-0014 — MixAI Decks: one Rust audio core, native UIs on every OS

- Status: Accepted · 2026-11-08 (owner decisions, two question rounds)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §13 (D60–D68, WP19)
- Supersedes the product name "MixAI DJ" in [ADR-0013](0013-product-family-and-domains.md); related:
  [ADR-0007](0007-licensing-agpl-core-mit-sdk.md) (licensing), WP18 / D58 (`mixai-listen`)

## Context

`apps/mixai` ("MixAI DJ", `ro.mixai.dj`, 1.0.0) is a Tauri 2 desktop app: a Rust engine (`crates/mixai-core`:
cpal 0.15, symphonia 0.5, 4 decks, EQ/filter, WSOLA key-lock, hot cues, loops, beat FX, sampler, WAV recorder,
tempo-only sync), ~60 IPC commands, MIDI (midir, 11 presets) and raw HID, plus a React UI that never touches WebAudio.
The 1.0.0 MSIX is in Microsoft Store certification; there is no macOS/Linux build, no CI and no mobile target.
The web DJ (`apps/web` `/mixer`, `mixer-engine.ts`) is WebAudio/DOM-bound; only pure-TS modules are portable
(Camelot, MIDI presets, controller drivers, rekordbox XML, Serato crate, FX parameter tables).

Research (2026-11-08, verified versions in the tracker §13) compared Tauri everywhere, Rust core + native UIs,
JUCE 9, KMP/Compose Multiplatform, Flutter and React Native. Every incumbent (rekordbox, Serato, Traktor, djay,
VirtualDJ, Mixxx) runs a native C/C++ engine with native UI; none draws decks in a webview.

## Decision

1. **Name: MixAI Decks** everywhere (store listings, site `decks.mixai.ro`, docs). The application id stays
   `ro.mixai.dj` and the existing Microsoft Store record (9P5P2WN26RMS) is renamed, so reviews and installs carry
   over. `dj.mixai.ro` redirects to `decks.mixai.ro`.
2. **One Rust core, `decks-core`** (evolved from `mixai-core`, MIT/Apache): audio I/O (cpal 0.18), decode
   (symphonia 0.6), resample (rubato), time-stretch (Signalsmith Stretch default, Bungee for scrub/reverse; no
   Rubber Band — GPL), beat/phase sync + quantize + master clock, routing matrix with headphone cue, FX, sampler,
   recorder, stems (ort 2 + HTDemucs ONNX with CoreML/DirectML/NNAPI/QNN, server fallback), DVS decoder, MIDI/HID
   mapping runtime, local library (SQLite) + interop. Analysis (key, downbeats, tuning, LUFS) lives in the shared
   **`mixai-listen`** crate (WP18-01) used by both Decks and Key & BPM.
3. **Native UIs over UniFFI 0.31**:
   - Apple (macOS, iPadOS, iOS): **SwiftUI**, one multiplatform target in `apps/ios` (XcodeGen), Swift bindings.
   - Android (phone, tablet, ChromeOS): **Jetpack Compose** in the existing Gradle build (`apps/tv-android`).
   - Windows + Linux: **Compose Multiplatform Desktop**, sharing view models and most composables with Android
     through Kotlin UniFFI bindings (JNA).
   - The heavy GPU views (scrolling waveforms, overview, spectral, jog platters) are drawn **once in Rust with
     wgpu** into a native surface handle (Metal / Vulkan / DX12) on every OS; only the chrome is native.
   Rejected: WinUI 3 + GTK4 (two more codebases, C#), Slint (attribution or paid licence, non-native look),
   JUCE (C++ rewrite + licence), Tauri on phones (webview audio/MIDI lifecycle risk).
4. **Transition:** the Tauri app ships now as **MixAI Decks 1.x** on Windows, macOS and Linux (same core), and is
   replaced in place by the native **2.0** in the same store listings.
5. **All platforms in parallel**, each with its own CI job and store pipeline (MS Store MSIX, Mac App Store +
   notarised DMG, Flathub/AppImage/deb, Google Play, App Store for iPhone/iPad).
6. **DVS v1:** clean-room MIT Rust decoder for Serato CV02.5 (relative + absolute), Phase in audio mode, an own
   MixAI timecode signal; no xwax/Mixxx code; patent freedom-to-operate check before launch; Phase HID partnership
   requested.
7. **Streaming v1:** local files + OneLibrary (CDJ USB export); Apple Music catalogue with our affiliate token on
   the subscription sheet and an application for Apple's DJ entitlement; Beatport partner application asking for a
   per-trial bounty; SoundCloud and TIDAL behind feature flags pending B2B approval; Spotify/Deezer/Amazon after
   traction. We do not pay for catalogue access.
8. **Controllers:** own mapping format (JSON + sandboxed script), MIDI learn on any control, FLX4 profiles for
   rekordbox and Serato modes with auto-detect, Circuit Tracks (clock master/slave, drum pads → samples/hot cues,
   macros → FX, groove lane), MIDI keyboard as a scale-locked instrument, BLE MIDI on every OS (Windows MIDI
   Services). No Mixxx mappings (GPL).
9. **Licence gate:** `cargo-deny` + a JS licence check in CI from day one; GPL/AGPL (Essentia, Rubber Band, aubio,
   xwax, Mixxx mappings, Ableton Link) are blocked.
10. **Business model:** free at launch; Pro infrastructure (feature flags + Stripe entitlement via the MixAI
    account) is built but not enabled.

## Consequences

- Three UI codebases (SwiftUI, Compose shared Android+desktop) and one renderer; the React UI of `apps/mixai`
  remains only for 1.x.
- Android latency is hardware-bound (10–20 ms typical, < 10 ms on `android.hardware.audio.pro`); the UI shows a
  device latency class instead of promising numbers.
- Store accounts that do not exist (Amazon, Samsung, LG, Flathub, Chrome, AMO) are out of this phase; Decks ships to
  Microsoft Store, Mac App Store, App Store, Google Play, plus GitHub releases (DMG/AppImage/deb/MSIX).
