# MixAI Decks FFI (`decks-ffi`)

Tracker WP19-04 · ADR [0014](../adr/0014-mixai-decks-native-dj.md) decision D61.

One stable command / snapshot API over the Rust Decks core, exposed with
[UniFFI](https://mozilla.github.io/uniffi-rs/) 0.32 to:

| Host | Language | Loads the library as |
|---|---|---|
| macOS / iPadOS / iOS (SwiftUI) | Swift (`DecksFFI` module) | `libdecks_ffi.a` (staticlib) in an XCFramework |
| Android (Compose) | Kotlin (`ro.mixai.decks.ffi`) | `libdecks_ffi.so` per ABI, JNA |
| Compose Multiplatform Desktop | Kotlin (same package) | `decks_ffi.dll` / `libdecks_ffi.so` / `.dylib`, JNA |

Crate: `apps/mixai/src-tauri/crates/decks-ffi` (MIT OR Apache-2.0, `cdylib + staticlib + rlib`,
lib name `decks_ffi`). It links `mixai-core`, `decks-analysis` (feature `decode`),
`decks-library`, `decks-mapping`, `decks-dvs` and `decks-render`.

## Conventions

Same as `crates/mixai-listen-ffi` (WP18):

* **Proc-macro UniFFI** (`uniffi::setup_scaffolding!`, `#[uniffi::export]`); no UDL.
* **Polling, not callbacks.** Every foreign call happens on a thread the app owns. Long work
  (track load + analysis, library scan) runs on a Rust background thread and returns a ticket /
  id; the UI polls `load_status` / `scan_status`.
* **Thread safety.** Every object is `Send + Sync` behind one `Mutex` (poison-tolerant). The
  audio callback stays on `mixai-core`'s cpal thread and is driven by lock-free commands; no FFI
  call ever runs on the audio thread.
* **One error type**, `DecksError` (Kotlin: `DecksException`), variants `InvalidArgument`,
  `NotRunning`, `Audio`, `Decode`, `Library`, `Mapping`, `Dvs`, `Render`, `NotFound`,
  `Unsupported`, each with a `reason` field (never `message`: it clashes with
  `Throwable.message` in Kotlin).
* Decks, channels, hot-cue slots are **0-based** (`deck` 0..3, `slot` 0..7).
* Colours are `0xRRGGBB` `u32`.

## Generating bindings

```powershell
pwsh -NoProfile -File apps/mixai/scripts/gen-decks-bindings.ps1            # swift + kotlin
pwsh -NoProfile -File apps/mixai/scripts/gen-decks-bindings.ps1 -Language kotlin
```

The script builds the host cdylib (debug) and runs
`cargo run -p decks-ffi --features cli --bin uniffi-bindgen -- generate --library <host lib> --language <lang> --out-dir <dir>`.
Output (gitignored, regenerate in the app build):

* `apps/mixai/bindings/swift/DecksFFI.swift`, `decks_ffiFFI.h`, `decks_ffiFFI.modulemap`
* `apps/mixai/bindings/kotlin/ro/mixai/decks/ffi/decks_ffi.kt`

Package / module names come from `crates/decks-ffi/uniffi.toml`. Cross builds: Android via
`cargo ndk -t arm64-v8a -t x86_64 build -p decks-ffi --release`, Apple via
`cargo build -p decks-ffi --release --target aarch64-apple-ios[-sim] / aarch64-apple-darwin`
then `xcodebuild -create-xcframework`.

## API

### Free functions

| Function | Returns |
|---|---|
| `decks_ffi_version()` | crate version of this surface |
| `list_output_devices()` | `[AudioOutputDevice]` |
| `mapping_builtin_profiles()` | `[MappingProfileInfo]` |
| `mapping_json_schema()` | JSON Schema of mapping format v1 |
| `dvs_generate_mixai(sample_rate, start_sec, speed, frames)` | interleaved stereo MixAI timecode |

### `DecksEngine`

Constructor `DecksEngine(config: DecksEngineConfig{sample_rate?, buffer_frames?, output_device_id?})`.

| Group | Methods |
|---|---|
| Device | `list_output_devices()`, `set_output_device(id?) -> Bool` (switches the running stream at once, keeping decks / routing / FX; stored for the next `start()` while stopped; `true` on success, `NotFound` / `Audio` errors otherwise), `start() -> EngineStartInfo` (honours `sample_rate`, `buffer_frames`, `output_device_id`), `stop()`, `is_running()` |
| Load | `load(deck, path) -> ticket`, `load_status(ticket) -> LoadStatus?`, `track_info(deck)`, `peaks(deck) -> WaveformPeaks?`, `beatgrid(deck) -> BeatGridInfo?`, `set_beatgrid(deck, grid)` |
| Transport | `play`, `pause`, `seek(deck, sec)`, `cue(deck, pressed)` (CDJ behaviour), `set_cue_point(deck, sec)`, `hot_cue_set/jump/delete(deck, slot)` |
| Loops | `loop_in`, `loop_out`, `loop_auto(deck, beats)`, `loop_halve`, `loop_double`, `loop_toggle`, `loop_exit`, `beat_jump(deck, beats)` |
| Tempo / key / sync | `set_tempo(deck, ratio)`, `set_key_lock`, `set_key_shift(deck, semitones)`, `key_match(deck) -> shift`, `set_slip`, `set_quantize`, `phase_sync(deck, lock)`, `set_sync_lock`, `set_reverse` |
| Mixer | `set_eq(deck, EqBand, dB)`, `set_filter(deck, -1..1)`, `set_gain(deck, dB)` (trim −∞..+12 dB, pre-EQ, independent of the fader), `set_volume(deck, 0..1)`, `set_crossfader(-1..1)`, `set_master_volume`, `set_pfl(deck, on)` |
| Routing / clock / FX | `routing_set(Routing)`, `routing_get()`, `set_master_clock(MasterClockSource, bpm?)`, `set_color_fx(deck, ColorFx, param)`, `set_beat_fx(deck, BeatFx, wet, beats, feedback)` |
| Recording | `record_start(path)`, `record_stop()` |
| Poll | `snapshot() -> EngineSnapshot` |

Loads work while the engine is stopped: decoded audio is parked and handed to the engine on
`start()`. `stop()` unloads the decks. A newer `load` on the same deck turns the older ticket into
`Cancelled`.

`EngineSnapshot` = `{running, sample_rate, latency_ms, master_vu, master_volume, crossfader,
recording, clock: ClockSnapshot, decks: [DeckSnapshot; 4], channels, buffer_frames?,
output_device_id?}` (the last three were added with defaults, so older generated bindings keep
compiling).

* `DeckSnapshot`: `deck, loaded, loading, title, playhead_sec, duration_sec, playing, bpm,
  effective_bpm, tempo, key_lock, key_shift_semitones, key_camelot, effective_key_camelot, beat,
  bar_phase, loop_active, loop_start_sec, loop_end_sec, slip, slip_shadow_sec, quantize,
  sync_lock, pfl, cue_point_sec, hot_cues[8], volume, gain_db, vu`. `slip_shadow_sec` is the
  shadow playhead published by the audio thread while slip holds one (slip on + loop or
  reverse running), `None` otherwise. `gain_db` is the trim (−96 = −∞).
* `ClockSnapshot`: `configured, source_deck?, bpm, beat, beat_phase, bar_phase?,
  beats_per_bar, frame` (extrapolate between polls with `bpm` and `sample_rate`).

`snapshot()` reads atomics written by the audio thread plus a small UI mirror: measured well under
1 ms per call in the test (1000 calls), fine for 60–120 Hz polling.

Records / enums: `DecksEngineConfig`, `AudioOutputDevice`, `EngineStartInfo{sample_rate, channels,
latency_ms, device_id?, notes[], buffer_frames?, device_name?}`, `LoadState{Queued, Decoding, Analysing, Ready, Failed,
Cancelled}`, `LoadStatus`, `TrackInfo` (path, title, duration, rate, channels, bpm, first beat,
key Camelot / Open Key / name / confidence, LUFS, true peak, gain to −14), `WaveformPeaks` (9 u8
lanes low/mid/high × min/max/rms, `points_per_second` = 150), `BeatGridInfo` + `TempoAnchorInfo`,
`EqBand`, `MasterClockSource{Auto, InternalClock, Deck(deck)}`, `Routing` (mirror of
`mixai_core::RoutingConfig`) + `OutputModeKind`, `ColorFx{Off, Filter, Phaser, Flanger, Noise,
DubEcho}`, `BeatFx{Off, Echo, Reverb, Roll, Gate}`.

### `DecksLibrary`

Constructors `DecksLibrary.open(path)`, `DecksLibrary.open_in_memory()`.

| Group | Methods |
|---|---|
| Tracks | `schema_version`, `track_count`, `track(id)`, `track_by_path(path)`, `upsert_track(LibraryTrack) -> id`, `delete_track(id)`, `all_tracks()`, `search(query, limit)`, `set_cues(id, cues)`, `set_grid(id, grid)` |
| Scan | `scan_folder(folder) -> scan_id` (background, own SQLite connection), `scan_status(scan_id) -> ScanStatus?` |
| Crates | `create_crate(name, parent_id?, is_folder)`, `crates()`, `rename_crate`, `delete_crate`, `crate_tracks`, `set_crate_tracks`, `add_to_crate` |
| Smart crates | `create_smart_crate(name, rule_json)`, `smart_crates()`, `delete_smart_crate`, `evaluate_smart_crate(id)`, `evaluate_rule(rule_json)` |
| Interop | `import_file(LibraryFormat, path) -> tracks`, `export_file(LibraryFormat, path)`, `read_collection(LibraryFormat, path)` (preview), `migrate_from(LibraryFormat, path) -> MigrationSummary` |
| History | `start_session(name?)`, `end_session`, `record_play(session, track_id, deck?)`, `sessions()`, `session_entries(session)`, `tracklist(session)` |

`LibraryFormat`: `RekordboxXml`, `TraktorNml`, `SeratoCrates{volume_root}`, `EngineDj` (read),
`RekordboxPdb{volume_root}` (read), `NeutralJson`, `OneLibrary` (always `Unsupported` until a
public spec exists). Records: `LibraryTrack` (key as Camelot; input also accepts Open Key /
musical text), `LibraryCue` + `CueType`, `LibraryGrid` + `LibraryGridAnchor`, `CrateRow`,
`SmartCrateRow{rule_json}`, `HistorySessionRow`, `HistoryEntryRow`, `ScanStatus` + `ScanState` +
`ScanFailure`, `MigrationSummary`. Smart-crate rules are the JSON tree of `decks_library::smart`,
e.g. `{"all":[{"field":"bpm","op":"between","value":[120,128]}]}`.

### `DecksMapping` and `MidiClock`

Constructors `DecksMapping.from_builtin(id)`, `DecksMapping.from_json(json)`,
`DecksMapping.detect(port_name, usb_vendor?, usb_product?, identity_reply?)`.

| Methods | |
|---|---|
| `profile()`, `to_json()` | current mapping (incl. learned bindings) |
| `on_midi(port, bytes, ts_us) -> [MappedAction]` | raw MIDI in |
| `on_ble_midi(port, packet, ts_us)`, `ble_decode(packet) -> [BleMidiMessage]` | BLE-MIDI |
| `feedback(items)`, `feedback_all(items)`, `feedback_from_snapshot(EngineSnapshot)` | LED / meter MIDI out (`[MidiOutMessage]`) |
| `sync_value(action_json)`, `set_modifier(id, on)`, `set_side_deck(side, deck)`, `set_beat_position(beats)` | engine state for soft takeover, shift, deck layers, groove |
| `clock_out(now_us)`, `followed_bpm()` | clock send / follow from the mapping |
| `start_learn(target_action_json?)`, `poll_learn(now_us) -> LearnedControl?`, `accept_learned()`, `cancel_learn()`, `is_learning()` | MIDI learn |
| `take_script_errors()` | sandboxed rhai script errors |

`MappedAction` is flat: `group` (`deck`/`mixer`/`fx`/`library`/`sampler`/`clock`), `kind`
(snake_case action type), `deck?`, `value?`, `delta?`, `pressed?`, `slot?` (slot / index / note),
`params_json` (inner object), `action_json` (full action, accepted back by `sync_value` and
`start_learn`), `timestamp_us`. The full vocabulary (~90 actions) stays in
[mapping-format.md](mapping-format.md); a flat record keeps the FFI stable when actions are
added. `FeedbackItem{key_json, value: FeedbackLevel{On, Level, Colour}}`, where `key_json` is a
`FeedbackKey` such as `{"type":"hot_cue_set","deck":1,"slot":3}`.

`MidiClock(bpm)`: `set_bpm`, `bpm`, `is_running`, `start(now_us, phase)`, `stop`, `resume`,
`set_song_position`, `tick(now_us) -> [MidiOutMessage]` (exact `at_us`), `next_due_us()`.

### `DvsInput`

Constructor `DvsInput(DvsSettings{format, sample_rate, mode?, swap_channels, speed_window_ms?,
stop_speed?})`; `DvsFormat{MixAi, SeratoCv25, TraktorMk2, Phase, Custom{carrier_hz,
differentiate}}`, `DvsMode{Relative, Absolute}`.

`process(interleaved) -> DvsReading{speed, direction, position_sec?, valid, stopped, locked,
quality}`, `reading()`, `report() -> DvsCalibration`, `scope_points() -> [ScopePoint]`, `reset()`.
All MixAI inputs share one 4 MiB code table. `Phase` fails with `Dvs` (no public signal
description).

### `DecksRenderer`

| Constructor | Handle |
|---|---|
| `new_headless(w, h)` | offscreen RGBA8 |
| `from_metal_layer(view_ptr, uikit, w, h, scale)` | `NSView*` / `UIView*` whose layer is a `CAMetalLayer` |
| `from_android_surface(native_window, w, h, scale)` | `ANativeWindow*` (`ANativeWindow_fromSurface`) |
| `from_win32(hwnd, hinstance, w, h, scale)` | HWND (+ HINSTANCE or 0) |
| `from_xlib(display, window, screen, w, h, scale)` | `Display*` + XID |
| `from_wayland(display, surface, w, h, scale)` | `wl_display*` + `wl_surface*` |

Methods: `info() -> RendererInfo`, `resize(w, h, scale)`, `set_views([RenderView])`,
`set_peaks(deck, WaveformPeaks)` (on load, not per frame), `update(RenderFrameState)`,
`render()`, `read_pixels() -> bytes?` (headless only). Records: `RenderView{kind:
RenderViewKind{Waveform, Overview, Stacked, Platter, DvsScope}, x, y, w, h}` (logical pixels),
`RenderFrameState{decks: [DeckFrameState], zoom_seconds, style: RenderWaveStyle, theme:
RenderTheme, reduced_motion}`, `DeckFrameState{loaded, playhead_sec, slip_playhead_sec?,
duration_sec, grid: RenderGrid?, markers: [RenderMarker], platter_rpm, dvs_scope}`.

**Unsafe pointer passing.** Native handles cross the FFI as `u64`. UniFFI cannot mark a
constructor `unsafe`, so the contract is documented here and on each constructor: the handle must
be valid when passed and stay valid until the renderer is destroyed (`close()` / `destroy()` in
Kotlin, deinit in Swift). Android: create in `surfaceCreated`, destroy in `surfaceDestroyed`, then
`ANativeWindow_release`. Apple: pass `Unmanaged.passUnretained(view).toOpaque()` and keep the view
alive. Null / zero handles are rejected with `InvalidArgument`; anything else is trusted.

### `DecksRemote`

Connected mode (phone remote, second screen, Party DJ — [remote.md](remote.md)).
`start(port, party_open)` (port 0 = any) → `port()`, `pairing(RemoteRole) -> RemotePairing{role, url,
qr_width, qr_modules}`, `rotate(role)`, `set_track_labels(deck, title?, artist?)`,
`pump(engine: DecksEngine) -> RemotePumpReport{applied, errors, mixer_changes: [RemoteMixerChange]}`
(call from the UI tick; applies phone commands and publishes the engine state), `requests() ->
[SongRequest]`, `set_request_state(id, SongRequestState)`, `set_party_open`, `clear_done_requests`,
`clients() -> [RemoteClient]`, `stop()`, `is_running()`. A stopped server returns `NotRunning`; a port
that cannot open fails `start` with `Unsupported`.

### Transition Designer

Free functions ([transitions.md](transitions.md)): `transition_rank_next(playing, [NextCandidate], EnergyTrend,
limit) -> [NextSuggestion]`, `transition_plan(from, to, from_deck, to_deck, from_pos_sec, bars?, style?,
not_before_bars) -> TransitionPlanInfo{style, bars, start_sec, beats_until_start, to_cue_sec, to_tempo_ratio,
automation_json, reasons}`, `transition_check_safety(playing, position_sec, tempo_ratio, next?, planned_bars?) ->
[SafetyWarning{code, severity, detail_json}]`, `transition_parse_intent(text) -> DjIntent?`,
`transition_validate_intent(json) -> DjIntent?`, `transition_intent_schema() -> String`,
`transition_render_riser(key, bpm, bars, sample_rate, seed) -> [f32]`. Object `TransitionRunner(automation_json,
start_beat)`: `tick(engine, master_beat) -> TransitionTick{applied, errors, done, progress}`, `is_done()`.
`DecksEngine` gained `set_stems_active(deck, on)` and `set_stem_gain(deck, stem, gain)`.

## Limits (2026-11-09)

* Device / config: `mixai_core::Engine::start_with(device, sample_rate, buffer_frames)` applies
  the request; anything the device does not support falls back to its default and is listed in
  `EngineStartInfo.notes` (unsupported rate, rate only available with another channel count,
  buffer clamped into the device range or rejected by the backend, unknown device at `start()`
  → system default). `notes` is empty when everything was honoured. Only f32 stream formats are
  opened. When the backend reports no buffer range and the default buffer is used,
  `buffer_frames` is the size observed in the first audio callback (`None` until then).
* `set_output_device` while running rebuilds the cpal stream around the same mixer (a short
  dropout, ~one buffer plus device open time). If the new device fails the previous one is
  reopened and `Audio` is returned. A switch that changes the sample rate stops an active
  recording (WAV files have one rate).
* The engine opens one output stream; headphones / booth are channel pairs of that device
  (`Routing`). A separate cue device is not supported.
* Hot cues are positions only; colours / labels live in `DecksLibrary` cues.
* Analysis runs on the whole decoded file in memory (≈ 0.9 s for 3 min stereo in release).
* No callbacks: hosts poll. MIDI / BLE / audio-input transport stays in the host (CoreMIDI,
  `android.media.midi`, JNA midir); bytes are fed to `DecksMapping.on_midi` / `DvsInput.process`.
