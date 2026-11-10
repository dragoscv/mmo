# Flexible beatgrid and encoder-drift correction (WP19-37)

Status 2026-11-10. Background: [ideas-2026-11.md](ideas-2026-11.md) part 1 (§2 rows 1 and 3, §3 recommendation 1,
§4 licensing). Everything here is hand-written from public descriptions; no Mixxx, libKeyFinder or other GPL code
is used or ported (crates stay MIT OR Apache-2.0, see [architecture.md](architecture.md)).

## Model

A beatgrid is

- a **first beat** (`first_beat_sec`, seconds of decoded audio),
- the **starting tempo** (`bpm`, valid from the first beat up to the first marker),
- a list of **tempo-change markers** `(sec, bpm)`: "from `sec` on, the tempo is `bpm`",
- the **fixed-grid toggle** `fixed`.

| Layer | Type | Where |
|-------|------|-------|
| Library (SQLite, interop) | `BeatGrid { bpm, first_beat_sec, downbeat_offset, anchors: [GridAnchor { sec, bpm }], fixed }` | `crates/decks-library/src/model.rs`, column `beatgrids.fixed` (schema v3) |
| Engine | `BeatGrid { bpm, first_beat, downbeat, beats_per_bar, anchors: [GridAnchor { time, beat }], fixed }` — piecewise linear time → beat | `crates/mixai-core/src/beatgrid.rs` |
| Analysis | `BeatGrid { bpm, first_beat_sec, is_variable, anchors: [TempoAnchor { beat_index, time_sec, bpm }] }` — first anchor = section 0, later anchors = markers | `crates/decks-analysis/src/tempo.rs` |
| FFI (Swift / Kotlin) | `GridState { track_id, bpm, first_beat_sec, downbeat_offset, fixed, markers: [GridMarker { sec, bpm, beat }] }` | `crates/decks-ffi/src/grid.rs` |
| Desktop UI | `GridModel { bpm, firstBeat, markers: [{ sec, bpm }], fixed }` | `apps/mixai/src/grid/markers.ts` |

Conversion: `mixai_core::BeatGrid::from_markers(bpm, first_beat, markers, fixed)` builds the engine anchors (one per
marker, beat numbers integrated from the tempos, plus one trailing anchor one beat after the last marker so the last
tempo keeps going); `BeatGrid::markers()` / `start_bpm()` go back. The same maths is mirrored in TypeScript
(`toBeatGrid` / `fromBeatGrid`), Kotlin (`GridStateUi.beatAt/timeAt`) and Swift (`GridMath`).

**Analysed grids are pinned, not integrated** (review P1-8). An analysed grid's anchors carry the beat number the
tracker *counted* (`TempoAnchor.beat_index`, an integer); `BeatGridInfo::to_core` turns them into anchors with
`BeatGrid::from_sections`, which puts each section start on that beat. `from_markers` instead integrates the previous
section's fitted tempo, and because the per-section line fits do not meet at the boundaries, the error grew at
every marker. Inside a section the grid follows that section's own fitted tempo up to its last beat; the one beat
before the next measured start absorbs the difference. Edited grids (empty `beats`) keep `from_markers`, so a marker
between two beats stays exact.

Measured 2026-11-10 on a synthetic 4-section click track (120 → 127 → 117 → 129 BPM, 72 s, 22.05 kHz, analysed end
to end, test `analysed_sections_do_not_accumulate_phase_error` in decks-ffi), worst |true beat − nearest grid beat|:

| | last 16 beats | whole track |
|---|---|---|
| before (integrated, `from_markers`) | 144.4 ms | 187.0 ms |
| after (pinned, `from_sections`) | 0.64 ms | 0.73 ms |

The drift was far larger than the reviewer's ~15 ms-per-marker estimate because the integrated beat of each section
start also inherits the previous fit's tempo error over the whole section. Asserted bound: < 5 ms everywhere.

**The library stores the first section's tempo** (review P1-7). For a variable grid, `BeatGridInfo.bpm` is the
*average* tempo; `to_library()` writes `anchors[0].bpm` (the starting tempo, same rule as `to_core`) and the later
anchors as markers, so a deck grid read back with `deck_grid` and persisted keeps every marker's beat number.

**Every tempo and time is range-checked on every entry path** (review P1-9): tempos must be finite and in
20..400 BPM (`mixai_core::valid_bpm`), times finite and ≥ 0 (`valid_sec`). Checked for the base tempo, every
marker and every anchor in `DecksEngine.set_beatgrid`, `grid_apply_to_deck`, every `grid_*` library edit and the
Tauri commands `deck_set_beatgrid` (including each anchor segment's slope) and `deck_set_grid_markers`; a bad value
returns `InvalidArgument` / an error string instead of being dropped. `merge_markers` applies the same range as a
last line of defence: a 1e-300 or 1e308 BPM marker used to make `beat_at` / `time_at` return `NaN` on the audio
thread.

### Marker rules

- A marker list is **normalised** after every edit: sorted by time; markers within 1 ms keep the last one; a marker at
  (or before) the first beat replaces the starting tempo; a marker whose tempo equals the running tempo (within
  0.05 %, `MARKER_BPM_TOLERANCE`) is dropped. So the list only holds real changes and stays short.
- "Add a marker at the playhead" snaps to the nearest beat and starts **0.1 BPM above** the running tempo (a marker at
  the same tempo would be merged away at once); the user then retunes it.
- A marker between two beats is honoured exactly (fractional beat), so a tempo change can sit off-grid.

### Fixed-grid toggle

`fixed = true` makes the engine use the constant grid (`bpm` + first beat) and **ignore the anchors, which are kept**:
`BeatGrid::is_variable()` is false, `beat_at` / `time_at` / `bpm_at` use the constant tempo. Turning it off brings the
markers back unchanged. The flag is stored in the library, carried by `BeatGridInfo.fixed` / `GridState.fixed` over
FFI and by `BeatGrid.fixed` in the Tauri command. Gate: `fixed_grid_ignores_the_anchors_but_keeps_them`
(mixai-core), mutation-checked.

## Tempo-change detection

`decks-analysis` tracks every beat (Ellis 2007 dynamic programming), then:

1. **Binary segmentation**: fit a straight line (beat index → time) to the beats; while a section's RMS residual is
   above 8 ms or any beat is more than 30 ms off the line, split it where two lines fit best (O(1) fits from prefix
   sums; sections are at least 8 beats).
2. **Merge**: adjacent sections whose tempos agree within 0.25 % are joined (closest pair first).
3. The section starts are the anchors. The grid is flagged variable only when a section deviates more than 0.5 % from
   the average tempo.

Result on synthetic click tracks (tests in `tempo.rs` and `tests.rs`): a constant track (with ±2 ms jitter) gives no
markers; a 120 → 128 BPM step gives exactly one marker on the step beat; a 120 → 128 BPM ramp over 160 beats gives
3–10 monotonically rising sections, the full 60 s audio ramp at most 12.

## Editing surfaces

| Surface | Where | Controls |
|---------|-------|----------|
| FFI | `track_grid`, `track_grid_markers`, `grid_set_fixed`, `grid_set_base`, `grid_add_marker`, `grid_move_marker`, `grid_remove_marker` (all write back to the library), `grid_apply_to_deck`, `deck_grid`, `drift_check` | — |
| Tauri desktop | `components/GridEditor.tsx`, waveform in `components/Waveform.tsx`, command `deck_set_grid_markers` | Fixed switch (`role="switch"`), add at playhead, per-marker BPM field, nudge ±5 ms (Shift ±50 ms), ↑/↓ ±0.1 BPM, Delete |
| Android / Desktop (Compose) | `screens/GridEditor.kt` (`GridEditorState`), `components/Waveforms.kt` | Fixed toggle, add, nudge, retune, delete — all `PadButton`s (focusable, Enter/Space, content descriptions) |
| iOS / macOS | `UI/GridEditorView.swift`, overlay in `Waveform/WaveformView.swift` | Toggle, add, nudge, retune, delete / swipe to delete (unverified build, see below) |

Waveforms draw beat lines that follow the markers, markers in the warning colour (dimmed while fixed) with the BPM
label (Tauri, iOS), and a fixed-grid indicator ("FIXED" badge on desktop, warning bar on the lane top elsewhere).

## Encoder drift on import

MP3 decoders disagree about where a file starts, so cues and grids from another app can land 20–30 ms off. The
first MPEG frame tells us why (`crates/decks-library/src/drift.rs`):

- **Xing / Info header frame** — a silent frame LAME-style encoders put first. A decoder that recognises it skips it;
  one that does not decodes 1152 samples (26.1 ms at 44.1 kHz, 24 ms at 48 kHz).
- **LAME encoder delay / padding** — samples the encoder pushed in front of the music; gapless decoders trim them.

Published four-case classification (Estrela, dj-data-converter), parsed by `probe_mp3` (ID3v2 skip, MPEG frame header,
Xing flags, LAME extension, CRC-16/ARC over the first 190 bytes):

| Case | First frame | Typical producer |
|------|-------------|------------------|
| A | no Xing / Info tag | CBR rips, hardware encoders |
| B | Xing / Info, no LAME tag or a `Lavc` / `Lavf` reduced tag | ffmpeg |
| C | LAME tag with zero or wrong CRC | older LAME, re-tagged files |
| D | LAME tag with a valid CRC | normal LAME output |

**Our reference** is `decks-analysis::decode_file` — symphonia 0.6, gapless on. Read from its source
(`symphonia-bundle-mp3` `demuxer.rs`): it never decodes the Xing / Info frame (cases B, C, D), and trims the encoder
delay whenever it accepts the LAME extension (encoder `LAME` / `Lavf` / `Lavc`, CRC matching or zero).

### Per-application shift (what `correct_record` adds to the imported times)

| Source app | Shift applied | Status | Basis |
|------------|---------------|--------|-------|
| Traktor | **−1 frame** (−26.1 ms at 44.1 kHz, −24 ms at 48 kHz) in cases **B and C**; 0 in A and D | **Confirmed against rekordbox converters, NOT measured against our decoder (symphonia)** — see the open question below | Traktor does not accept a `Lavc`/`Lavf` tag or a bad-CRC LAME tag and decodes the header frame as audio; the −1 frame is the Traktor→**rekordbox** offset reproduced by dj-data-converter, Rekord Cloud, Mixxx and Rekord Buddy. The only test (`traktor_loses_the_header_frame_only_in_cases_b_and_c`) checks the code against itself, not against decoded audio |
| Traktor, case D encoder delay | 0 (documented term −delay, not applied) | Unconfirmed | No measurement of Traktor against a gapless decoder |
| rekordbox | 0 (documented term −encoder delay ≈ −25 ms for LAME files, not applied) | Unconfirmed | rekordbox 1.5.4 release note: gapless disabled for LAME MP3s, "24 ms (48 kHz) / 26 ms (44.1 kHz)" shift of older grids; not measured against symphonia here |
| Serato DJ | 0 | Unconfirmed | No published measurement against a gapless decoder |
| Engine DJ | 0 | Unconfirmed | No published measurement |
| MixAI | 0 | Confirmed by construction | Exports come from this decoder |
| Unknown | 0 | — | — |

Only confirmed terms move cues; unconfirmed terms are listed in `SourceApp::drift_terms` (with `confirmed: false`)
and in the fix reason so they can be switched on after a measurement with real files. Non-MP3 or unreadable files
are left alone. Gate: `traktor_loses_the_header_frame_only_in_cases_b_and_c` (decks-library), mutation-checked.

**Open question (review P1-10, 2026-11-10, undecided):** our reference decoder is symphonia, not rekordbox.
symphonia accepts a `Lavf` / `Lavc` LAME extension and a **zero** CRC (see above) and then trims the encoder delay
(~25 ms for typical ffmpeg output), while `drift::is_lame_tag` treats `Lavc` / `Lavf` as case B and a zero CRC as
case C. So in **case B** and in **case C with CRC 0**, the real Traktor → our-decoder offset is probably
**−(1 frame + encoder delay)**, not −1 frame; only case C with a *wrong, non-zero* CRC (which symphonia also
rejects) matches the −1 frame exactly. Nothing is changed until it is measured: decode real ffmpeg / zero-CRC LAME
files with Traktor and with `decks-analysis::decode_file`, compare the first transient, and then either model the
delay term for those cases or keep −1 frame.

Import: `migrate::MigrateOptions.correct_drift` (WP19-38) calls `drift::correct_record(&mut TrackRecord, SourceApp)`
per track; it shifts every cue start / end, the grid's first beat and every tempo marker, clamped at 0, and reports a
`DriftFix { path, shift_sec, reason }`. Over FFI, `drift_check(path, source)` returns a `DriftReport` (shift, case,
encoder, encoder delay, reason, analysed).

### Sources

- dj-data-converter issue #3, "MP3 cues shifted in time going from Traktor to Rekordbox (AKA 26ms problem)", with the
  four-case algorithm and the rekordbox 1.5.4 / 1.6.2 / 2.0.2 release-note quotes:
  https://github.com/digital-dj-tools/dj-data-converter/issues/3
- DJ Knowledge Base, "26ms shift algorithm" and implementations (dj-data-converter, Rekord Cloud, Mixxx, DJCU,
  Rekord Buddy): https://pestrela.github.io/dj_kb/dj_collection_converters/
- Mixxx PR #2119 discussion of per-decoder offsets (read only for the facts, no code used):
  https://github.com/mixxxdj/mixxx/pull/2119
- LAME tag layout: http://gabriel.mp3-tech.org/mp3infotag.html
- symphonia 0.6.1 `symphonia-bundle-mp3/src/demuxer.rs` (Xing / LAME parsing, delay trim) — our own decoder.

## Verification

| Gate | Command |
|------|---------|
| Rust | `q.ps1 -Cmd test -Pkgs decks-analysis,mixai-core,decks-library` and `-Pkgs mixai-core,decks-ffi` (`tests/grid.rs`) |
| Desktop logic | `cd apps/mixai; node --test "src/**/*.test.ts"` (`src/grid/markers.test.ts`), `pnpm typecheck` |
| Compose | `:decks-ui:desktopTest` (`commonTest/GridTest.kt`) |
| Swift | **Not built**: no macOS toolchain on the Windows workstation. `GridEditorView.swift` and the `WaveformView` overlay follow the UniFFI Swift naming and must be compiled on the Mac before release. |
