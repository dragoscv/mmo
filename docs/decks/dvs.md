# MixAI Decks — DVS decoder (`decks-dvs`)

Tracker WP19-13 · ADR-0014 decision D65 · provenance: [dvs-clean-room.md](dvs-clean-room.md).

Crate `apps/mixai/src-tauri/crates/decks-dvs` (MIT OR Apache-2.0, no runtime dependencies).
Pure DSP; `DvsDecoder::process` performs no heap allocation (enforced by `tests/no_alloc.rs`
with a counting global allocator).

## Support matrix

| Format | Carrier | Relative (speed/direction) | Absolute (needle position) |
|---|---|---|---|
| **MixAI timecode** (ours) | 1 kHz | Supported | Supported |
| Serato CV02.5 / Control CD | 1 kHz | Experimental (synthetic-signal verified only) | **Pending** — polynomial/seed not derivable from public non-GPL sources |
| Traktor MK2 | 2.5 kHz, offset-modulated | Experimental (derivative front-end) | **Pending** — 110-bit code not publicly characterised |
| Phase (audio mode) | unknown | **Pending vendor docs** | **Pending vendor docs** |
| Custom | any | Experimental | via a user `PositionCode` |

`TimecodeFormat::{relative,absolute}_support()` returns exactly this, with the reason string;
`DvsDecoder::new` refuses pending combinations with `DvsError::Unsupported(reason)`.

## API

```rust
let cfg = DvsConfig::new(TimecodeFormat::MixAi, 48_000);       // absolute by default for MixAI
let code = Arc::new(MixAiCode::new());                          // 4 MiB table, build once, share
let mut deck_a = DvsDecoder::with_code(cfg, code.clone())?;
let st: DvsState = deck_a.process(&interleaved_lr, frames);     // audio callback
// st.speed (signed, 1.0 = nominal), st.direction, st.position_sec: Option<f64>,
// st.valid, st.stopped, st.locked, st.quality (0..1)
let rep: SignalReport = deck_a.report();                        // calibration panel
let n = deck_a.scope(&mut xy_points);                           // Lissajous, ≤ SCOPE_POINTS
```

Config knobs: `mode`, `speed_window_ms` (default 8 → 4 ms group delay), `stop_speed` (0.03),
`dc_cutoff_hz` (20), `min_level` (−54 dBFS floor), `dropout_hold_ms` (5), `swap_channels`,
`max_phase_residual` (0.3 cycles RMS).

## How it works

1. **Front end**: optional first difference (offset-modulated carriers), one-pole DC blocker
   (identical on both channels → no L/R phase error), instantaneous quadrature envelope
   √(L²+R²), 1 ms smoothed envelope, peak-hold reference with 2 s decay = AGC.
2. **Presence / auto-threshold**: on = max(min_level, 4 × noise envelope, 0.2 × reference), off
   at 60 % of that (hysteresis). Dropouts ≤ 5 ms bridge phase with the last speed.
3. **Phase tracking**: θ = atan2(L, R) per sample, unwrapped to a continuous record position φ
   in carrier cycles. Jumps > 0.25 cycle/sample against the running slope = needle drop →
   estimators and lock restart.
4. **Speed**: least-squares slope of φ over the last 8 ms (group delay 4 ms < 5 ms target),
   × sample-rate / carrier. RMS residual of the fit > 0.3 cycles = incoherent (noise, music,
   run-out) → invalid. |speed| < 0.03 → stopped.
5. **Bits (absolute)**: the envelope is averaged over the flat middle (35–65 %) of every carrier
   cycle; a bit-level AGC tracks the "1" amplitude; threshold halfway between 1 and z. Bits are
   placed at their cycle index, so a window fills correctly in both directions.
6. **Lock**: a full 20-bit window is looked up; 4 consecutive consistent offsets lock. While
   locked, every bit is checked against the code; 6 errors in 24 bits unlock and keep only the
   post-burst bits so relock is immediate. Position = (φ + offset) mod len / carrier.

## MixAI timecode definition (v1)

| Property | Value |
|---|---|
| Carrier | 1000 Hz at nominal speed |
| Channels | L = A·sin 2πφ, R = A·cos 2πφ (L lags R by 90° forwards) |
| Bits | one per carrier cycle, AM: 1 → A = 1, 0 → A = 0.6 (40 % depth) |
| Transitions | raised cosine over ±0.15 cycle around each cycle boundary |
| Code | 20-bit Fibonacci LFSR s[k+20] = s[k+17] ⊕ s[k] (x^20 + x^17 + 1), seed 0x9E3B5 |
| Length | 2^20 − 1 = 1 048 575 cycles = 17 min 28.6 s unique at 33⅓ reference |
| Level | −1.9 dBFS peak (`DEFAULT_LEVEL` 0.8) |
| Window convention | window value bit i = bit of cycle k + i |

Generator: `write_timecode_wav(path, minutes, sample_rate)` /
`cargo run -p decks-dvs --example gen_timecode -- out.wav 15 44100` (16-bit stereo PCM). For a
12" side at 33⅓ use ≤ 15 min; a CD can hold the full 17.4 min.

## Verified results (2026-11-08, 48 kHz, 256-frame blocks, SNR 30 dB)

| Test | Lock | Position error | Speed error |
|---|---|---|---|
| speed 1.00 | 26.6 ms | 0.013 ms | 0.032 % |
| speed 1.08 | 21.3 ms | 0.009 ms | 0.020 % |
| speed −1.00 | 26.6 ms | 0.013 ms | 0.031 % |
| speed 0.33 | 69.3 ms | 0.017 ms | 0.076 % |
| needle drop, 30 ms lift | relock 27.3 ms | 0.010 ms | 0.027 % |
| instant jump (edit point) | relock 78.6 ms | 0.009 ms | 0.023 % |

Targets: speed < 0.2 %, position < 10 ms, lock < 100 ms — all met. Also covered: relative-mode
stop detection (stopped within 20 ms of the platter halting, ramp tracking within 0.06),
2 Hz ±2× scratch (direction + speed within 2 % + 0.02), noise-only never valid/locked,
WAV round trip through `hound` (lock < 100 ms, position within 1 ms, SNR > 35 dB),
calibration (balance 3.02 dB / phase error 10.01° measured for injected 3 dB / 10°,
SNR 30.1 dB for a 30 dB signal, 100 % valid bits), zero heap use in `process`/`report`/`scope`.

## Limits

- Verified on **synthetic** signals only. Real vinyl adds rumble, wow/flutter, RIAA/phono
  colouration, crosstalk and groove wear; tune `max_phase_residual`, AM depth and thresholds on
  real cuts before launch (needs a test pressing + turntable session).
- 0.33× is the slowest speed with a full-precision check; below ~0.1× speed precision degrades
  (fixed 8 ms window, few cycles) — fine for stop/scratch, not for slow-motion position.
- Lock at slow speed takes longer (20 + 4 cycles must pass under the needle: ~70 ms at 0.33×).
- Instant jumps that land < 0.25 cycle/sample from the current slope are detected by the bit
  monitor instead (≤ 24 bits), hence the 78.6 ms relock.
- `MixAiCode::new()` allocates 4 MiB — construct once, off the audio thread.
- Vendor absolute modes are pending (see matrix); Phase needs vendor documentation or a
  partnership (ADR-0014: Phase HID partnership track).

## Patent freedom-to-operate (required before launch — D65)

A **freedom-to-operate (FTO) review by a patent attorney is required before shipping DVS**.
The list below is what a public search found on 2026-11-08; it is not a legal analysis and draws
no conclusions about validity, scope, infringement or expiry. Expiry dates are rough estimates
(20 years from the earliest non-provisional/PCT filing, ignoring term adjustments, terminal
disclaimers and national differences) and must be verified by counsel.

| Family / number | Title | Owner (public record) | Priority / filing | Expiry estimate |
|---|---|---|---|---|
| NL 1014526 → PCT/NL01/00055 → US 7,012,184; US 7,238,874; US 8,097,800; US 8,217,252; US 8,502,058; US 9,218,844 (+ EP/JP/DE/AU/ES members) | "Disc for use in an apparatus for signal processing…" / "System and method for controlling (a digital) audio source" (Final Scratch timecode record) | N2IT Holding B.V. → Native Instruments GmbH (assignment 2014) | priority 2000-02-29, PCT 2001-01-26 | Google Patents lists US 9,218,844 as "Expired – Lifetime", anticipated expiration 2021-01-26; verify all members |
| US 7,273,980 B2 | "Position and velocity transducer using a phonograph disc and turntable" | Scott A. Wardle | priority 2004-01-13 | ~2024–2025 (verify) |
| JP 6412660 B2 | "Record board, digital content playback system … on which a control signal for playback of digital content is recorded" | Pioneer DJ | priority 2015-09-28 | ~2035 |
| US 12,236,926 B2 | "System for selection and playback of song versions from vinyl type control interfaces" | Algoriddim GmbH | priority 2022-04-26 | ~2042 |
| WO 2025/030193 A1 | "Interactive digital vinyl system having touchscreen …" | not checked | not checked (published 2025) | application; status to check |

Also to search with counsel: Serato (Rane/inMusic) timecode and DVS patents, Native Instruments
Traktor MK2 timecode, Stanton Final Scratch-era filings, MWM/Phase wireless timecode patents,
and any claims on LFSR/maximal-sequence position records.
