# On-device stems (WP19-09)

Crate: `apps/mixai/src-tauri/crates/decks-stems` (MIT OR Apache-2.0).

## Pipeline

1. **Plan** — `plan_source(SourcePlan)` picks: cache → server copy → accelerated device → server
   separation → CPU device (only when not on low battery / throttled) → unavailable. The
   `device_only` privacy setting never contacts the server.
2. **Separate** — `separate(model, left, right, rate, cancel, progress)`: resample to 44.1 kHz
   (rubato FFT), cut into 7.8 s segments with a 25 % linear cross-fade (weights sum to 1),
   run the model per segment, overlap-add, resample back to the track rate. Cancellable between
   segments; progress after each segment.
3. **Cache** — `StemCache` writes `<root>/<key>/{vocals,drums,bass,other}.wav` (32-bit float,
   atomic temp-dir rename). Same file names as the MMO Server analyzer
   (`GET /stems/:trackId/<name>.wav`, 16-bit PCM is read too), so downloads and local results
   share one cache. `cache_key` = sha256(version, model id, first 4 MiB, file length).
   `prune(max_bytes)` drops the oldest sets.
4. **Play** — `Stems.layers` is in mixai-core order (vocals, drums, bass, melody/other) and maps
   1:1 onto `Command::LoadStems`; per-stem gain via `SetStemGain`.

## Model and runtime

| Item | Value |
|---|---|
| Model | HT-Demucs v4 single-file ONNX (StemSplit export, MIT), `mix (1,2,343980)` → `stems (1,4,2,343980)`, order drums/bass/other/vocals |
| Size | 316 MB fp32, 166 MB fp16-weights (same runtime cost) — downloaded on first use, never in the app bundle |
| Runtime | `ort` 2.0.0-rc.15 (ONNX Runtime 1.31) with `load-dynamic`: the app ships the platform library |
| Windows | `onnxruntime.dll` DirectML build → `ExecutionTarget::DirectMl` |
| macOS / iOS | CoreML EP → `ExecutionTarget::CoreMl` |
| Android | NNAPI + XNNPACK EPs from the onnxruntime-android AAR `.so` |
| Fallback | CPU EP everywhere; ONNX Runtime places unsupported nodes on CPU |

Reference speed (StemSplit, M4 Pro CPU): 1.6 s per 7.8 s segment (RTF 0.20); GPU EPs are
typically ≥ 5× faster. Measure a device with the example:

```powershell
cargo run -p decks-stems --example separate --features onnx --release -- <onnxruntime lib> <htdemucs.onnx> <in.wav> <out dir>
```

It prints load time, wall time and RTF and writes the cache set.

## Tests

`cargo test -p decks-stems --all-features` (no model or runtime needed): exact overlap-add
reconstruction with a linear stand-in model, stem order, padding of short tracks, 48 kHz round
trip, cancel, shape errors, cross-fade sum, cache round trip + server 16-bit WAVs + traversal
rejection + pruning, cache keys, source planning, server route paths, missing runtime library.

## Open

- Bundle the onnxruntime library per platform (Gradle AAR, Apple xcframework, MSIX) and the
  model downloader UI in the native apps; on-device RTF numbers per target.
- `decks-ffi` surface (`DecksStems`) once the native apps show the stem mixer.

# Playing with stems (WP19-41)

What the STEMS tab and the hot-cue pads of the desktop app do, in user words. Engine:
`crates/mixai-core/src/deck.rs`; shell commands: `src-tauri/src/stems.rs`; UI:
`src/components/StemControls.tsx`, `PerformancePads.tsx`.

## The STEMS tab

A track that has stems plays as four layers: vocals, drums, bass and melody. Each layer has:

| Control | What it does |
|---|---|
| Mute (the button with the stem's name) | Silences the stem. Pressing it again brings the stem back **at the level it had before the mute** (a stem at 60 % returns to 60 %, not to full). |
| S (solo) | Only that stem plays, at full level. Pressing S again brings the others back, each at the level it had. |
| Level | The stem's volume, 0 to 120 %. Pulling a level to zero is not a mute: it leaves no echo tail. |
| Stem crossfader (A … B) | A small crossfader for that stem alone, see below. |

At the side: **STEMS ON / OFF** switches between the four layers and the normal full mix, and
**MUTE FX** with its echo time (1/4, 1/2, 1 or 2 beats).

A small tab shows fewer controls; the rest is behind the "more stem controls" button next to
STEMS ON / OFF. Nothing is removed.

## Stem crossfader

Every stem has its own crossfader. At the **centre** (the default) the stem simply follows its
deck. Moved towards the crossfader side the deck is **not** on, the stem fades out; moved towards
the deck's own side, nothing changes. Example: deck A (side A) and deck B (side B) play together.
Move the drums of deck A to B and the drums of deck B to A: both decks now play without their own
drums … swap one of them back and that deck's drums return, while everything else stays as it is.

- The fade follows the mixer's crossfader curve (linear, smooth or sharp).
- Double-click (double-tap) a stem crossfader to return it to the centre; a drag that ends near
   the centre snaps to it; arrow keys move it in steps of 5 %.
- A deck set to **THRU** has no crossfader side, so its stem crossfaders do nothing. Each of them
   then shows a **THRU** tag instead of the A / B ends and a dashed track, and a screen reader
   reads the reason. The position can still be set; it takes effect when the deck gets a side.

## MUTE FX: an echo tail instead of a hard cut

With MUTE FX on, muting a stem while the deck plays does not cut it dead: what the stem played
just before the mute repeats as an echo, each repeat quieter, at the chosen echo time. The tail
ends by itself after 12 repeats (at the 1/2-beat setting: 6 beats after the mute).

- Unmuting the stem, switching MUTE FX off or switching STEMS off ends the tail; it fades out
   over a few hundredths of a second, never with a click.
- The tail follows the stem's crossfader: a stem faded out there takes its tail with it.
- The tail keeps sounding if the deck is paused right after the mute, like an echo unit would.

When MUTE FX leaves **no** tail (the mute is then a plain mute):

| Situation | Why |
|---|---|
| The track has no tempo (no BPM, no beatgrid) | The echo time is counted in beats. The MUTE FX button is then dimmed and not lit, and its description says why. Analyse the track or set its grid to use it. |
| The deck is paused when the stem is muted | Nothing was sounding, so there is nothing to echo. |
| Reverse playback | The echo is read from the track; in reverse that would be audio you have not heard yet. |
| A stem silenced with its level instead of its mute button | Only the mute button is a mute. |

## Cue loops: a loop stored on a hot cue

A hot cue can remember a loop. Jumping to such a cue starts that loop again, at the same place
and with the same length.

- **Save**: while a loop is running, press the loop button next to the pads (it lights up and the
   pads show a loop sign: "armed"), then the pad. The cue moves to the start of the loop. In one
   step: **Alt+click** the pad, or **Alt+Enter** with the pad focused.
- **Play**: press the pad. A cue-loop pad shows a loop sign and its length in beats.
- **Remove the loop, keep the cue**: with no loop running the same button shows a crossed loop
   sign. Press it, then the cue-loop pad.
- **Clear the cue** (and its loop): Shift+click, Delete on the focused pad, or the eraser button
   and then the pad. Setting a cue again on that pad gives a plain cue.

An armed button acts on the **next pad only**, and only for what it showed when you pressed it.
It switches itself off when that no longer applies: the loop you wanted to save has ended, a
loop started while you were about to remove one, the last cue is gone, or another track was
loaded. Pressing the button again cancels it. So a pad pressed later always does what it says:
it never stores a newer loop on a cue you only wanted to jump to, and it never deletes a stored
loop by surprise.

With quantize on and the deck playing, a jump keeps the deck's position inside the beat. For a
cue loop shorter than that offset the deck lands at the matching point **inside** the loop.

Keyboard only: Tab to the loop button, Space or Enter to arm it, Shift+Tab back to the pad,
Space or Enter. Every pad describes its shortcuts to a screen reader; the armed state is
announced when it starts and when it is dropped.

## Limits

- Cue loops need a tempo too (the length is stored in beats): on a track without BPM or
   beatgrid the loop button stores nothing.
- With key lock on and the tempo away from ±0 %, a mute FX repeat covers slightly more or less
   of the track than a hardware echo would hold; its timing and level are exact.
- Stem crossfader, MUTE FX and cue loops are in the desktop app only: `decks-ffi` (the binding the
   native apps use) exposes stems on/off and the stem level, not these three.
