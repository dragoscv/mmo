# MixAI Live

Realtime vocal processor and live-performance engine for Windows, Linux and macOS, with remote controllers on
phones, tablets and watches. Product id `live` (`live.mixai.ro`, application id `ro.mixai.live`, tags `live-v*`).

- Decision record: [ADR-0015](../adr/0015-mixai-live-performance.md)
- Plan and status: tracker [§14 / WP21](../mixai-design-tracker.md#14-mixai-live--realtime-vocal-processor--controllers-adr-0015-2026-11-09)
- Code: [`apps/live`](../../apps/live/README.md) (engine workspace `apps/live/engine`)

## What it does today

A singer plugs a microphone into an audio interface, runs `mixai-live-engine`, and hears a processed voice in
the in-ear monitor while the same voice (optionally with a different dry/wet balance) goes to the PA, stream
or recording:

- 13 built-in effects — gate, EQ, de-esser, compressor, pitch correction, harmonizer, saturator, doubler,
  chorus, delay, reverb, limiter, tuner — allocation-free on the audio thread ([effects](effects.md)).
- 7 factory presets, user presets, songs with parts and setlists in a JSON format ([presets](presets.md)).
- Two output buses: **main** (FOH / stream) and **monitor** (in-ear) with a dry blend for the singer.
- Click-free scene/preset changes: the previous chain's reverb/delay tail rings out.
- Measured round-trip latency with a click-train loopback probe ([latency guide](latency.md)).
- LAN control: HTTP + WebSocket protocol v1, OSC/UDP, mDNS discovery, QR pairing with three token roles, and a
  web remote page served by the engine ([remote protocol](remote-protocol.md)).
- Headless binary for stage PCs and scripts, plus offline WAV rendering ([CLI](cli.md)).
- MIDI control: every input port (incl. paired BLE MIDI pedals), MIDI learn on parameters, mix faders, insert
  toggles and actions (next/prev/tap/panic/bypass/mute), program change recalls song parts ([MIDI](midi.md)).
- User presets, the last setlist and the MIDI map persist in a per-user data directory.

## Surfaces

| Surface | Path | Status |
|---|---|---|
| Engine (`live-dsp`, `live-engine`, `live-remote`, `live-cli`) | `apps/live/engine` | built — WP21-02/04/05; native WASAPI exclusive / low-latency hosts + MMCSS built, loopback figure on real hardware open (WP21-03) |
| Web remote page (any browser on the LAN) | served by `mixai-live-engine serve` | built — WP21-05 |
| Browser `/live` FX page (Web Audio, separate engine) | `apps/web` | fixes shipped — WP21-14 |
| Phone engine: UniFFI bindings for Kotlin + Swift (`live-ffi`), "This phone as the engine" | `apps/live/engine`, `apps/live-android/ffi`, `apps/ios/LiveFFI` | built — WP21-06 ([ffi](ffi.md)) |
| Desktop app (Tauri 2 + React + `@mmo/ui`) | `apps/live/desktop` | built — WP21-07 |
| Android phone/tablet + Wear OS controller | `apps/live-android` | built — WP21-08 |
| iOS + watchOS controller | `apps/ios` | built — WP21-09 |
| Plugin host (CLAP, VST3, AU, LV2) | `live-host` | planned (WP21-10) — [design](plugins.md) |
| Voice conversion | `live-vc` | planned (WP21-11) — [design](voice-conversion.md) |
| Virtual audio devices, Voicemeeter Remote API | — | planned (WP21-12) |
| Stores, `live_pro` entitlement wiring, release workflow | — | planned (WP21-15) |

## Documents

| Page | Contents |
|---|---|
| [architecture.md](architecture.md) | Process model, audio-thread rules, buses, scene swap, meters, control flow |
| [effects.md](effects.md) | Every effect id with its parameter table (generated from the Rust spec tables) |
| [presets.md](presets.md) | JSON format v1: preset, insert, song, song part, setlist; factory presets |
| [latency.md](latency.md) | Lowest latency on Windows/macOS/Linux, buffer sizes, loopback measurement, Voicemeeter/OBS setups |
| [cli.md](cli.md) | `mixai-live-engine` subcommands, flags, output formats |
| [midi.md](midi.md) | MIDI ports, bindings (`midi.json`), MIDI learn, program change |
| [remote-protocol.md](remote-protocol.md) | Control protocol v1 (HTTP, WebSocket, OSC, mDNS, roles) |
| [ffi.md](ffi.md) | Phone engine (`live-ffi`): API, Android/iOS integration, Null test host, measured latency |
| [voice-conversion.md](voice-conversion.md) | Design: realtime voice conversion, consent, watermark — planned |
| [plugins.md](plugins.md) | Design: sandboxed plugin host — planned |

## Licensing

Engine crates are MIT OR Apache-2.0; the desktop app crate will be AGPL-3.0 (ADR-0007). The ASIO backend is an
opt-in build feature because the Steinberg ASIO SDK is GPLv3/proprietary ([latency guide](latency.md#windows)).
