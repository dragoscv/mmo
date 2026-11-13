# MixAI Live — effects reference

Every built-in effect lives in the `live-dsp` crate (`apps/live/engine/crates/live-dsp`, MIT OR Apache-2.0,
zero runtime dependencies). This page lists every effect id with its parameters.

The parameter tables below are **generated from the Rust `ParamSpec` tables** by
`.copilot-tmp/live-docs/gen-effects.mjs` (scratch generator, kept out of the repo); do not edit them by hand —
change the Rust table and regenerate. Ids are stable: presets, the remote protocol and OSC addresses use them.

## Common behaviour

All effects implement one trait, `Processor` (`live-dsp/src/processor.rs`):

- **Stereo, in place, any block length.** Mono inputs arrive as the same signal on both channels.
- **No allocation after construction.** Buffers are sized in `new(sample_rate)`; `set_param` and `process`
  never allocate. `chain::tests::processing_does_not_allocate` runs every effect under `assert_no_alloc`.
- **Parameter smoothing.** `set_param` stores a clamped target; audible parameters ramp per sample
  (`Smoothed`), so knob moves from a phone never zipper.
- **Clamping.** Values outside the range are clamped; `NaN`/infinite values fall back to the default; `choice`
  and `on/off` parameters are rounded to the nearest integer.
- **Normalised control.** Remote clients may send `set_param_norm` with `0..1`; `log` parameters map the travel
  logarithmically (`ParamSpec::from_normalized`).
- **Click-free bypass.** Each chain slot (`Insert`) crossfades wet ↔ dry over 10 ms when enabled/disabled; a
  fully bypassed insert costs nothing. Re-enabling clears the effect state first.
- **Latency + tail reporting.** `latency()` (samples) is summed over enabled inserts and published in the meters
  as `chain_latency_samples`; `tail_seconds()` (max over enabled inserts, capped at 6 s) decides how long the
  previous chain rings out after a scene change (see [architecture](architecture.md#scene-swap-with-tail-spill)).
- A chain holds at most **32 inserts** (`MAX_INSERTS`), preallocated so add/remove/move never reallocate.

Units: `0–1` = fraction shown as a percentage in the UI; `:1` = compression ratio; `choice` = integer index.

| Id | Effect | Latency | Tail |
|---|---|---|---|
| [`gate`](#gate) | Downward expander / gate | 0 | 0 |
| [`eq`](#eq) | HPF + low shelf + 2 peaks + high shelf | 0 | 0 |
| [`deesser`](#deesser) | Split-band / wide de-esser | 0 | 0 |
| [`compressor`](#compressor) | Soft-knee feed-forward compressor | 0 | 0 |
| [`autotune`](#autotune) | Pitch correction | 256 samples (5.3 ms @ 48 kHz) | 0 |
| [`harmonizer`](#harmonizer) | 4-voice harmonizer | 256 samples | 0 |
| [`saturator`](#saturator) | Tape / tube / soft clip | 0 | 0 |
| [`doubler`](#doubler) | ADT doubler | 0 | 0.06 s |
| [`chorus`](#chorus) | Stereo chorus | 0 | 0.05 s |
| [`delay`](#delay) | Stereo / ping-pong delay | 0 | time × echoes to −60 dB (≤ 30 repeats) |
| [`reverb`](#reverb) | 8-line FDN reverb | 0 | `decay` + `pre_delay` |
| [`limiter`](#limiter) | Zero-latency chain limiter (the non-removable bus safety stage is separate: [architecture](architecture.md#core-and-buses)) | 0 | 0 |
| [`tuner`](#tuner) | Pitch analyser (passes audio through) | 0 | 0 |

"Latency" is algorithmic latency added inside the chain; device buffers are separate
(see [latency guide](latency.md)). For in-ear monitoring keep the pitch effects to one per chain: two
`autotune`/`harmonizer` inserts add 512 samples (10.7 ms at 48 kHz).

## gate

Downward expander / gate with hold and hysteresis (opens at `threshold`, closes at `threshold − hysteresis`).
`range` limits how far the signal is pulled down, so a gentle setting works as an expander; `ratio` is the
expansion slope below the threshold. Reports gain reduction to the meters.

<!-- params:gate:start (generated from live-dsp/src/dynamics.rs GATE_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `threshold` | -90 … 0 | -50 | dB | linear |
| 1 | `range` | -90 … 0 | -40 | dB | linear |
| 2 | `ratio` | 1 … 20 | 4 | :1 | linear |
| 3 | `attack` | 0.05 … 50 | 0.5 | ms | log |
| 4 | `hold` | 1 … 500 | 40 | ms | log |
| 5 | `release` | 5 … 2000 | 120 | ms | log |
| 6 | `hysteresis` | 0 … 12 | 4 | dB | linear |

<!-- params:gate:end -->

## eq

High-pass filter + low shelf + two fully parametric peaks + high shelf + output trim. Coefficients are updated
at control rate (every 32 samples) from smoothed values, so sweeps are click-free. `response_db` exposes the
magnitude response for UI curves.

<!-- params:eq:start (generated from live-dsp/src/eq.rs SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `hpf_freq` | 20 … 400 | 80 | Hz | log |
| 1 | `hpf_on` | 0 / 1 | on | on/off | — |
| 2 | `low_freq` | 40 … 800 | 200 | Hz | log |
| 3 | `low_gain` | -18 … 18 | 0 | dB | linear |
| 4 | `mid1_freq` | 100 … 4000 | 400 | Hz | log |
| 5 | `mid1_gain` | -18 … 18 | 0 | dB | linear |
| 6 | `mid1_q` | 0.2 … 10 | 1 | — | log |
| 7 | `mid2_freq` | 500 … 12000 | 3000 | Hz | log |
| 8 | `mid2_gain` | -18 … 18 | 0 | dB | linear |
| 9 | `mid2_q` | 0.2 … 10 | 1 | — | log |
| 10 | `high_freq` | 2000 … 18000 | 10000 | Hz | log |
| 11 | `high_gain` | -18 … 18 | 0 | dB | linear |
| 12 | `output` | -18 … 18 | 0 | dB | linear |

<!-- params:eq:end -->

## deesser

Sibilance detector (band-pass at `frequency`). In `split` mode a 4th-order Linkwitz-Riley crossover at
0.8 × `frequency` splits the signal and only the high band is attenuated — the low band always passes dry (the
browser version lost it; fixed in web 3.4.5 too). Below the threshold the two bands sum flat: a test sweeps
300 Hz–12 kHz and allows ±0.5 dB (the first version used a 2nd-order pair that cancelled at the crossover).
`wide` attenuates the whole signal. `listen` solos the detector band for tuning. Gain reduction is capped at
`range`.

<!-- params:deesser:start (generated from live-dsp/src/dynamics.rs DEESS_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `frequency` | 2000 … 12000 | 6500 | Hz | log |
| 1 | `threshold` | -60 … 0 | -30 | dB | linear |
| 2 | `range` | 0 … 24 | 10 | dB | linear |
| 3 | `mode` | 0 `split`, 1 `wide` | 0 (`split`) | choice | — |
| 4 | `listen` | 0 / 1 | off | on/off | — |

<!-- params:deesser:end -->

## compressor

Feed-forward compressor with a soft knee, a high-pass filter on the detector (`sidechain_hpf`, stops plosives
from pumping), optional auto make-up gain and a parallel (`mix`) blend. Reports gain reduction.

<!-- params:compressor:start (generated from live-dsp/src/dynamics.rs COMP_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `threshold` | -60 … 0 | -18 | dB | linear |
| 1 | `ratio` | 1 … 20 | 3 | :1 | linear |
| 2 | `knee` | 0 … 24 | 6 | dB | linear |
| 3 | `attack` | 0.05 … 200 | 5 | ms | log |
| 4 | `release` | 5 … 3000 | 120 | ms | log |
| 5 | `makeup` | -12 … 24 | 0 | dB | linear |
| 6 | `auto_makeup` | 0 / 1 | off | on/off | — |
| 7 | `mix` | 0 … 1 | 1 | 0–1 | linear |
| 8 | `sidechain_hpf` | 20 … 500 | 80 | Hz | log |

<!-- params:compressor:end -->

## autotune

Pitch correction (the id `autotune` is a wire name only; user interfaces call the effect "Pitch correction").
Ported from the Companion's `pitch-dsp.ts`: YIN pitch detection, a granular/WSOLA shifter (256-sample grains,
two heads) and optional LPC formant preservation (`formant`). Detection and the correction ratio are updated
every 128 samples (2.7 ms at 48 kHz).

- `key` + `scale` select the target notes (13 scales). The default is `chromatic` (nearest semitone), so a
  singer in any key is pulled to a real note; a song's key or the user narrows it to a scale.
- `formant` is **off by default**. Correction moves the pitch by less than a semitone, where formants barely
  shift, and without the formant filter the output is a mix of input samples and cannot exceed the input peak.
  With `formant` on, the shifted signal is whitened and re-coloured by an order-12 LPC model; a guard compares it
  with the plain (formant-off) output and plays the plain output whenever the coloured one is implausibly loud
  (more than 6 dB of energy over it), and a ceiling holds every sample within 6 dB of the recent plain peak.
  Tests on a continuous voice-like signal (220–523 Hz, vibrato, ratios 0.94–1.06) require zero guard trips and
  less than 6 dB over the input in every 100 ms window. Known limit: at the attack of a phrase that follows
  silence the coloured output can overshoot, and the guard then plays the plain output for 50 ms (measured on
  1 of 3 attacks in the phrase test). So with `formant` on, the start of some phrases is not formant-preserved.
  The planned period-synchronous shifter replaces this path.
- The detector analyses the newest samples of its 1024-sample history (a test on a glide of one octave per
  second allows 9 cents of lag; the first version read the oldest part and was 20 cents behind).
- Shifter accuracy, measured on pure tones on 2026-11-12 (output pitch against input × ratio, ratios 0.8–1.25):
  with nothing to correct (ratio 1) the pitch is kept exactly (the first version was 6.8 cents flat, measured
  at 220 Hz); at 220, 330, 440 and 880 Hz the output is within 5.1 cents (tests allow 6).
  **Known defect: at 110 Hz small corrections are lost.** A correction of ±17 cents (ratio 0.99 / 1.01) comes
  out at the input pitch; at ±35 cents (0.98 / 1.02) the two estimators disagree (zero crossings: the whole
  correction lost; spectral peak: 8–16 cents off), so the output is not a clean tone; larger corrections are
  off too (0.94: +107 cents by zero crossings, +6 by spectral peak; 1.06: +10). Probable cause, not isolated: the
  period is longer than a 256-sample grain, which is the case below 187.5 Hz — the range of a male voice. Not
  measured between 110 and 220 Hz, nor on a real voice. The planned period-synchronous shifter has to fix it
  (an ignored test records the case).
- `retune` is the glide time to the target: ~0.5 ms is the hard "robot" effect, 40–100 ms sounds natural.
- `humanize` leaves small deviations alone: deviations under `30 × humanize` cents are not corrected and
  correction fades in smoothly over the next 30 cents (vibrato and scoops survive). `sticky` (cents) keeps the
  previous target note unless the new nearest note is closer by more than this, so vibrato does not flip notes.
- `amount` scales the correction, `mix` blends with the dry signal, `transpose` shifts the target.
- After 200 ms of unvoiced input the target resets (no stuck notes between phrases).
- A song's `key` (setlist) is applied to `key`/`scale` on recall ([presets](presets.md#key-strings)).
- Publishes `TuneStatus` (input pitch, target MIDI note, correction in cents) for the tuner display.

<!-- params:autotune:start (generated from live-dsp/src/tune.rs TUNE_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `key` | 0 `C`, 1 `C#`, 2 `D`, 3 `D#`, 4 `E`, 5 `F`, 6 `F#`, 7 `G`, 8 `G#`, 9 `A`, 10 `A#`, 11 `B` | 0 (`C`) | choice | — |
| 1 | `scale` | 0 `chromatic`, 1 `major`, 2 `minor`, 3 `harmonic_minor`, 4 `melodic_minor`, 5 `pentatonic_major`, 6 `pentatonic_minor`, 7 `blues`, 8 `dorian`, 9 `phrygian`, 10 `lydian`, 11 `mixolydian`, 12 `phrygian_dominant` | 0 (`chromatic`) | choice | — |
| 2 | `amount` | 0 … 1 | 1 | 0–1 | linear |
| 3 | `retune` | 0.5 … 400 | 40 | ms | log |
| 4 | `humanize` | 0 … 1 | 0.3 | 0–1 | linear |
| 5 | `formant` | 0 / 1 | off | on/off | — |
| 6 | `mix` | 0 … 1 | 1 | 0–1 | linear |
| 7 | `transpose` | -12 … 12 | 0 | st | linear |
| 8 | `sticky` | 0 … 100 | 60 | cents | linear |
| 9 | `fast` | 0 / 1 | off | on/off | — |

<!-- params:autotune:end -->

## harmonizer

Up to four pitch-shifted voices around the (latency-aligned) lead.

- `mode` `diatonic`: `vN_interval` is a scale-degree offset in `key`/`scale` (2 = a third above in a 7-note
  scale); the singer's own detune and vibrato are kept on the harmony line. `chromatic`: interval in semitones.
  `midi`: each voice sings the fixed MIDI note `vN_note` (0 = voice off). A voice with interval 0 is silent in
  the first two modes.
- `dry` is the lead level (the lead is delayed by the shifter latency so it stays phase-aligned with the voices).
- `vN_level` and `vN_pan` place each voice; levels are smoothed over 30 ms.

<!-- params:harmonizer:start (generated from live-dsp/src/tune.rs HARM_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `key` | 0 `C`, 1 `C#`, 2 `D`, 3 `D#`, 4 `E`, 5 `F`, 6 `F#`, 7 `G`, 8 `G#`, 9 `A`, 10 `A#`, 11 `B` | 0 (`C`) | choice | — |
| 1 | `scale` | 0 `chromatic`, 1 `major`, 2 `minor`, 3 `harmonic_minor`, 4 `melodic_minor`, 5 `pentatonic_major`, 6 `pentatonic_minor`, 7 `blues`, 8 `dorian`, 9 `phrygian`, 10 `lydian`, 11 `mixolydian`, 12 `phrygian_dominant` | 1 (`major`) | choice | — |
| 2 | `mode` | 0 `diatonic`, 1 `chromatic`, 2 `midi` | 0 (`diatonic`) | choice | — |
| 3 | `dry` | 0 … 1 | 1 | 0–1 | linear |
| 4 | `formant` | 0 / 1 | off | on/off | — |
| 5 | `v1_interval` | -12 … 12 | 2 | — | linear |
| 6 | `v1_level` | 0 … 1 | 0.5 | 0–1 | linear |
| 7 | `v1_pan` | -1 … 1 | -0.6 | −1 L … +1 R | linear |
| 8 | `v1_note` | 0 … 127 | 0 | — | linear |
| 9 | `v2_interval` | -12 … 12 | -3 | — | linear |
| 10 | `v2_level` | 0 … 1 | 0.5 | 0–1 | linear |
| 11 | `v2_pan` | -1 … 1 | 0.6 | −1 L … +1 R | linear |
| 12 | `v2_note` | 0 … 127 | 0 | — | linear |
| 13 | `v3_interval` | -12 … 12 | 4 | — | linear |
| 14 | `v3_level` | 0 … 1 | 0 | 0–1 | linear |
| 15 | `v3_pan` | -1 … 1 | -0.3 | −1 L … +1 R | linear |
| 16 | `v3_note` | 0 … 127 | 0 | — | linear |
| 17 | `v4_interval` | -12 … 12 | -5 | — | linear |
| 18 | `v4_level` | 0 … 1 | 0 | 0–1 | linear |
| 19 | `v4_pan` | -1 … 1 | 0.3 | −1 L … +1 R | linear |
| 20 | `v4_note` | 0 … 127 | 0 | — | linear |

<!-- params:harmonizer:end -->

## saturator

Waveshaper with three characters (`tape`, `tube`, `soft_clip`), a post low-pass `tone`, a DC blocker, parallel
`mix` and output trim.

<!-- params:saturator:start (generated from live-dsp/src/color.rs SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `drive` | 0 … 36 | 6 | dB | linear |
| 1 | `character` | 0 `tape`, 1 `tube`, 2 `soft_clip` | 0 (`tape`) | choice | — |
| 2 | `tone` | 1000 … 20000 | 12000 | Hz | log |
| 3 | `mix` | 0 … 1 | 0.5 | 0–1 | linear |
| 4 | `output` | -24 … 12 | 0 | dB | linear |

<!-- params:saturator:end -->

## doubler

Automatic double tracking: two short delayed voices with slowly drifting delay and detune, spread by `width`.

<!-- params:doubler:start (generated from live-dsp/src/modulation.rs DOUBLER_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `delay` | 5 … 40 | 18 | ms | linear |
| 1 | `detune` | 0 … 30 | 8 | cents | linear |
| 2 | `width` | 0 … 1 | 0.8 | 0–1 | linear |
| 3 | `mix` | 0 … 1 | 0.35 | 0–1 | linear |
| 4 | `drift` | 0 … 1 | 0.5 | 0–1 | linear |

<!-- params:doubler:end -->

## chorus

Stereo chorus; `spread` is the LFO phase offset between channels in degrees, `feedback` may be negative.

<!-- params:chorus:start (generated from live-dsp/src/modulation.rs CHORUS_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `rate` | 0.05 … 8 | 0.8 | Hz | log |
| 1 | `depth` | 0 … 10 | 3 | ms | linear |
| 2 | `delay` | 2 … 30 | 12 | ms | linear |
| 3 | `feedback` | -0.9 … 0.9 | 0 | 0–1 | linear |
| 4 | `mix` | 0 … 1 | 0.4 | 0–1 | linear |
| 5 | `spread` | 0 … 180 | 90 | — | linear |

<!-- params:chorus:end -->

## delay

Stereo delay with free time or tempo sync, filtered feedback, ping-pong and ducking.

- `sync` `off` uses `time`; any other value derives the time from `bpm` (1/2, 1/4, dotted, triplet… notes).
  Tap tempo and a song's `bpm` set `bpm` on every delay insert.
- `ping_pong` feeds a mono sum into the left line and cross-feeds the repeats.
- `low_cut`/`high_cut` filter the feedback path, so repeats get darker and thinner.
- `duck` attenuates the echoes by up to this many dB while the singer is singing; they bloom in the gaps.

<!-- params:delay:start (generated from live-dsp/src/delay.rs SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `time` | 20 … 2000 | 375 | ms | log |
| 1 | `sync` | 0 `off`, 1 `1/2`, 2 `1/4`, 3 `1/4d`, 4 `1/4t`, 5 `1/8`, 6 `1/8d`, 7 `1/8t`, 8 `1/16` | 0 (`off`) | choice | — |
| 2 | `bpm` | 40 … 240 | 120 | BPM | linear |
| 3 | `feedback` | 0 … 0.95 | 0.35 | 0–1 | linear |
| 4 | `mix` | 0 … 1 | 0.25 | 0–1 | linear |
| 5 | `ping_pong` | 0 / 1 | on | on/off | — |
| 6 | `low_cut` | 20 … 2000 | 250 | Hz | log |
| 7 | `high_cut` | 1000 … 20000 | 6000 | Hz | log |
| 8 | `duck` | 0 … 24 | 6 | dB | linear |

<!-- params:delay:end -->

## reverb

8-line feedback delay network with pre-delay, `size` (line length scale), high-frequency `damping`, `low_cut`
on the reverb input, stereo `width` and slow line `modulation` against metallic ringing. The tail length used
for scene switching is `decay + pre_delay`.

<!-- params:reverb:start (generated from live-dsp/src/reverb.rs SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `decay` | 0.2 … 12 | 2.2 | s | log |
| 1 | `size` | 0.3 … 1.5 | 1 | — | linear |
| 2 | `pre_delay` | 0 … 150 | 20 | ms | linear |
| 3 | `damping` | 1000 … 18000 | 6500 | Hz | log |
| 4 | `low_cut` | 20 … 1000 | 200 | Hz | log |
| 5 | `width` | 0 … 1 | 1 | 0–1 | linear |
| 6 | `mix` | 0 … 1 | 0.2 | 0–1 | linear |
| 7 | `modulation` | 0 … 1 | 0.3 | 0–1 | linear |

<!-- params:reverb:end -->

## limiter

Brick-wall safety limiter built on the compressor core without lookahead — **zero latency**, so it is safe on
the in-ear path. `input` drives into it; the engine also hard-clamps every bus to ±1.0 after the gain stage.

<!-- params:limiter:start (generated from live-dsp/src/dynamics.rs LIM_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `ceiling` | -24 … 0 | -1 | dB | linear |
| 1 | `attack` | 0.01 … 10 | 0.1 | ms | log |
| 2 | `release` | 5 … 1000 | 60 | ms | log |
| 3 | `input` | -12 … 24 | 0 | dB | linear |

<!-- params:limiter:end -->

## tuner

Analysis only (audio passes unchanged): YIN pitch, nearest note and cents for the tuner display, with an
adjustable concert pitch.

<!-- params:tuner:start (generated from live-dsp/src/tune.rs TUNER_SPECS; do not edit by hand) -->

| # | Param id | Range | Default | Unit | Curve |
|---|---|---|---|---|---|
| 0 | `reference` | 415 … 466 | 440 | Hz | linear |

<!-- params:tuner:end -->

## Planned

- Third-party plugins (CLAP, VST3, AU, LV2) as chain inserts — planned (WP21-10), see [plugins](plugins.md).
- Voice conversion as a FOH-side stage — planned (WP21-11), see [voice conversion](voice-conversion.md).
- Feedback (howl) suppressor, looper, LUFS stream master — planned (WP21-13).
