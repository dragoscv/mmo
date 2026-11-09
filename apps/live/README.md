# MixAI Live

Realtime vocal processor and live-performance engine for Windows, Linux and macOS, with remote
controllers on Android, Wear OS, iOS and watchOS. Decision record: [ADR-0015](../../docs/adr/0015-mixai-live-performance.md);
plan and status: tracker §14 / WP21 in [`docs/mixai-design-tracker.md`](../../docs/mixai-design-tracker.md).

## Layout

| Path | What |
|---|---|
| `engine/` | Rust workspace (own `Cargo.lock`, edition 2024, MSRV 1.90) |
| `engine/crates/live-dsp` | Allocation-free stereo vocal DSP, MIT OR Apache-2.0, zero runtime dependencies |

## live-dsp effects

All effects share one interface (`Processor`): static parameter table (`ParamSpec`: id, range, unit, curve),
in-place stereo processing on blocks of any length, per-sample parameter smoothing, click-free bypass
crossfade (`Insert`), reported latency and tail length.

| Id | Effect | Notes |
|---|---|---|
| `gate` | Downward expander / gate | hold, hysteresis, range |
| `eq` | HPF + low shelf + 2 peaks + high shelf | smoothed sweeps, `response_db` for UI curves |
| `deesser` | Split-band de-esser | low band always kept; listen mode |
| `compressor` | Soft-knee feed-forward | sidechain HPF, auto makeup, parallel mix |
| `autotune` | Pitch correction | YIN + granular/WSOLA + LPC formant, key/scale, retune speed, humanize, sticky, transpose; 256-sample latency |
| `harmonizer` | 4 voices | diatonic / chromatic / MIDI note, level + pan per voice, phase-aligned lead |
| `saturator` | Tape / tube / soft clip | tone, DC blocker, parallel mix |
| `doubler` | ADT | two drifting voices, width |
| `chorus` | Stereo chorus | spread, feedback |
| `delay` | Stereo delay | free / tempo sync, ping-pong, filtered feedback, ducking |
| `reverb` | 8-line FDN | pre-delay, size, damping, modulation, low cut, width |
| `limiter` | Zero-latency safety limiter | ceiling clamp |
| `tuner` | Analyser | reference A4 415–466 Hz |

## Verify

```powershell
# from the repo root, queued through the shared build lock
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'cargo test --workspace --manifest-path apps/live/engine/Cargo.toml'
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'cargo clippy --workspace --all-targets --manifest-path apps/live/engine/Cargo.toml -- -D warnings'
```

`chain::tests::processing_does_not_allocate` runs every effect under `assert_no_alloc` (mutation-tested:
an allocation in `Chain::process` aborts the test binary).
