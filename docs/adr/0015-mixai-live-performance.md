# ADR-0015 — MixAI Live: native realtime vocal processor + remote controllers

- Status: Accepted · 2026-11-09 (owner decisions, one question round)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) §14 (WP21)
- Related: [ADR-0007](0007-licensing-agpl-core-mit-sdk.md) (licensing), [ADR-0013](0013-product-family-and-domains.md)
  (product family), [ADR-0014](0014-mixai-decks-native-dj.md) (Rust core + UniFFI pattern)

## Context

Vocal processing exists twice today, both limited:

- **Browser** (`apps/web/src/lib/audio-fx-engine.ts`, `/live`): 24 Web Audio effects, 10–30 ms, with real bugs
  (de-esser loses the dry signal, `vocoderLite` and `stereoWidth` are placeholders, gate is a compressor).
- **Companion** (`server/src/audio/native-engine.ts`, `native-fx.ts`, `pitch-dsp.ts`, audify/RtAudio): ~5–9 ms
  autotune + 7 mono effects, but DSP runs in JavaScript on the audio callback (GC pauses), no parameter
  smoothing, drift flush clicks, `/audio/native/*` is loopback-only so phones cannot control it.

The owner wants a dedicated pro app for live vocals on Windows, Linux and macOS (with or without Voicemeeter),
controllers on Android, iOS, Wear OS (and watchOS), plugin hosting, presets, scenes, and realtime voice
conversion (own healthy voice when hoarse, or a consented third-party timbre) that does not sound robotic.

Research 2026-11-09 (versions in the tracker §14): cpal 0.18.2 (no WASAPI exclusive, issue #459), VST3 SDK MIT
since 2025-10-20, clack-host 0.2.0 (CLAP), Beatrice 2 (~50 ms singing VC on one CPU thread, MIT trainer),
RVC v2/Applio (GPU, ~80–150 ms), Seed-VC (GPL, archived — rejected), AudioSeal (MIT, weights included),
EU AI Act art. 50 synthetic-audio marking from 2026-08-02.

## Decision

1. **Product: MixAI Live** — `live.mixai.ro`, application id `ro.mixai.live`, tags `live-v*`.
2. **Engine: Rust, its own process** (`apps/live/engine`, own Cargo workspace so half-written Decks crates never
   break it). Crates:
   - `live-dsp` (MIT OR Apache-2.0, zero dependencies): allocation-free stereo DSP — gate, expander, compressor,
     limiter, de-esser, parametric EQ, saturation, doubler, chorus, delay, reverb, pitch correction (YIN +
     granular/WSOLA + LPC formant, ported from `pitch-dsp.ts`), harmonizer, all with per-sample parameter smoothing.
   - `live-engine`: device I/O (cpal: CoreAudio, ALSA, PipeWire/JACK, ASIO feature; own WASAPI exclusive backend),
     lock-free command/telemetry rings, scenes/setlists/presets, monitor vs FOH buses, metrics (xruns, DSP load,
     measured round-trip latency).
   - `live-remote`: LAN control (WebSocket JSON for state, OSC/UDP for faders, token + QR pairing as in
     `decks-remote`, mDNS discovery).
   - `live-ffi`: UniFFI 0.32 surface for Kotlin and Swift controllers (same pattern as `decks-ffi`).
   - `live-host`: plugin host (CLAP via clack-host, VST3 via the MIT SDK, AU on macOS, LV2 on Linux), each plugin
     group in a **sandbox worker process** with shared-memory audio and a watchdog that bypasses a crashed slot.
   - `live-vc`: voice conversion over ONNX Runtime (ort 2, DirectML / CUDA / CoreML / CPU): a Beatrice-2-style
     low-latency CPU model plus an RVC-format GPU tier; every converted output carries an AudioSeal watermark.
3. **Latency policy:** the performer's in-ear monitor always gets the low-latency processed voice (target
   ≤ 6 ms round trip at 64 frames); voice conversion feeds the FOH/stream/record buses, with a dry/converted
   blend for the monitor. Latency is reported from a loopback measurement, never from driver figures.
4. **Desktop UI: Tauri 2 + React 19 + `@mmo/ui`** (Base UI, Motion 13, design tokens); realtime meters and
   spectrum drawn from Rust. The UI talks to the engine over the same local control protocol as phones, so the
   engine runs headless on a stage PC.
5. **Controllers:** native Compose (Android phone/tablet + Wear OS) in the shared Gradle build, SwiftUI (iOS +
   watchOS) in `apps/ios`, plus a web remote page served by the engine for any other device.
6. **Virtual audio:** Windows reuses the bundled VirtualDrivers driver (MIT) now, an own attestation-signed driver
   later; macOS own AudioServerPlugIn (libASPL); Linux PipeWire nodes. Voicemeeter is optional (Remote API).
7. **Voices:** phase 1 = own voice models (local training on the user's healthy recordings) + an official library
   recorded with written consent; the open marketplace (KYC, consent phrase, speaker-similarity check, revenue
   share) follows as its own work package.
8. **Licensing:** engine crates MIT OR Apache-2.0 like `mixai-core`; the desktop app crate AGPL-3.0 (ADR-0007).
   ASIO SDK (GPLv3/proprietary) only behind a feature flag; Rubber Band / Seed-VC / Mixxx code banned.
9. **Business:** free core + **Pro** (voice conversion, plugin sandbox, multiple in-ear mixes) via
   `apps/web/src/lib/entitlements.ts` (`live_pro`).
10. **Delivery:** all surfaces in parallel (owner choice), each with CI and a store pipeline.

## Consequences

- One more Rust workspace and CI job; DSP is no longer duplicated in TypeScript on the Companion path (the
  Companion keeps its engine as a fallback until MixAI Live ships).
- Voice conversion needs model distribution, consent records and watermarking before any third-party voice ships.
- The Windows driver needs an EV certificate before it can be replaced.
