//! MIXAI Tauri app: exposes the `mixai-core` audio engine to the webview via
//! commands, and pushes a throttled `mixer://state` event at ~30 Hz so the UI
//! meters/transport stay live without polling.

use std::sync::Mutex;
use std::time::Duration;

use mixai_core::{
    AudioDevice, BeatFxKind, BeatGrid, ClockSource, ClockState, ColorFxKind, Command, DeckId,
    Engine, MixerState, OutputInfo, RoutingConfig, TempoMarker, list_output_devices, valid_bpm,
    valid_sec,
};
use serde::Deserialize;
use tauri::{Emitter, Manager, State};

mod midi;
use midi::MidiState;

mod ble_midi;
mod ble_midi_packet;
use ble_midi::BleMidiState;

mod hid;
use hid::HidState;

mod companion;
use companion::CompanionState;

mod pack;
mod window_ctl;

// One module per feature area (each owns its commands and its managed state).
mod copilot;
mod link;
mod remote;
mod stems;

/// Tauri-managed engine handle. `Option` so a device failure doesn't crash the
/// whole app — the UI degrades to "UI preview" mode.
pub struct EngineState(pub Mutex<Option<Engine>>);

/// Points per second of the 3-band waveform the UI scrolls (one point = 6.7 ms).
const WAVE_POINTS_PER_SECOND: u32 = 150;

/// Three-band waveform of the track loaded on each deck, computed once at load time (the
/// engine takes the sample buffer) and fetched by the UI with `deck_waveform_bands`.
#[derive(Default)]
pub struct WaveState(pub Mutex<[Option<Vec<u8>>; 4]>);

/// Peak lanes of the separated stems loaded on each deck (see `stem_lanes_bytes`), fetched by
/// the UI with `deck_stem_lanes`. Cleared when the engine receives another track for the deck
/// (`publish_track_waves`), not when that load starts: a load can take two minutes over a
/// tunnel, and until it lands the deck still plays the previous track and its stems.
#[derive(Default)]
pub struct StemWaveState(pub Mutex<[Option<Vec<u8>>; 4]>);

/// A new track was handed to the engine for `slot`: publish its band waveform and drop the
/// stem lanes, which belonged to the previous track (the engine drops its stems on a load).
/// Called with the engine lock held, like the stem-lane store in `load_stems`, so the lanes
/// always describe what the engine was sent last.
fn publish_track_waves(slot: usize, bands: Vec<u8>, waves: &WaveState, stem_waves: &StemWaveState) {
    waves.0.lock().unwrap()[slot] = Some(bands);
    stem_waves.0.lock().unwrap()[slot] = None;
}

/// Wire form of the stem lanes: `[u32 LE points_per_second][u32 LE len][u32 LE mask]` then four
/// lanes of `len` bytes (vocals, drums, bass, melody; bit `i` of `mask` = stem `i` is loaded,
/// a missing stem is all zeros). Same point grid as the band waveform.
fn stem_lanes_bytes(pps: u32, lanes: &[Option<Vec<u8>>; 4]) -> Vec<u8> {
    let len = lanes.iter().flatten().map(Vec::len).max().unwrap_or(0);
    let mut mask = 0u32;
    let mut out = Vec::with_capacity(12 + 4 * len);
    out.extend_from_slice(&pps.to_le_bytes());
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    for (i, lane) in lanes.iter().enumerate() {
        let start = out.len();
        if let Some(l) = lane {
            mask |= 1 << i;
            out.extend_from_slice(l);
        }
        out.resize(start + len, 0);
    }
    out[8..12].copy_from_slice(&mask.to_le_bytes());
    out
}

fn deck_slot(deck: DeckId) -> usize {
    match deck {
        DeckId::A => 0,
        DeckId::B => 1,
        DeckId::C => 2,
        DeckId::D => 3,
    }
}

fn parse_deck(s: &str) -> Result<DeckId, String> {
    DeckId::from_str(s).ok_or_else(|| format!("invalid deck '{s}'"))
}

/// A tempo the grid maths can use (20..400). The grid is read by the audio thread, where a
/// `NaN` from a 1e-300 / 1e308 tempo would poison `beat_at` / `time_at` (WP19-37 P1-9).
fn check_bpm(what: &str, bpm: f64) -> Result<(), String> {
    if valid_bpm(bpm) {
        Ok(())
    } else {
        Err(format!("{what} {bpm} must be a tempo in 20..400"))
    }
}

/// A usable source time: finite and not before the start of the file.
fn check_sec(what: &str, sec: f64) -> Result<(), String> {
    if valid_sec(sec) {
        Ok(())
    } else {
        Err(format!("{what} {sec} must be finite and >= 0"))
    }
}

/// Every tempo and time of a seconds-based engine grid (base plus every anchor). Anchors are
/// `{time, beat}` pairs, so their tempo is the slope between neighbours: checked on the same
/// normalised list the engine will use (`Engine::set_grid` normalises too).
fn check_grid(grid: &BeatGrid) -> Result<(), String> {
    check_bpm("bpm", grid.bpm)?;
    check_sec("firstBeat", grid.first_beat)?;
    for (i, a) in grid.anchors.iter().enumerate() {
        check_sec(&format!("anchors[{i}].time"), a.time)?;
        if !a.beat.is_finite() {
            return Err(format!("anchors[{i}].beat must be finite"));
        }
    }
    let norm = grid.clone().normalized();
    for (i, w) in norm.anchors.windows(2).enumerate() {
        let bpm = (w[1].beat - w[0].beat) / (w[1].time - w[0].time) * 60.0;
        check_bpm(&format!("anchor segment {i} tempo"), bpm)?;
    }
    Ok(())
}

// ---- commands ----------------------------------------------------------------

#[tauri::command]
fn list_audio_devices() -> Vec<AudioDevice> {
    list_output_devices()
}

#[tauri::command]
fn get_mixer_state(state: State<'_, EngineState>) -> Option<MixerState> {
    state.0.lock().unwrap().as_ref().map(|e| e.snapshot_state())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadReq {
    deck: String,
    source: String,
    track_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    bpm: Option<f64>,
}

#[tauri::command]
fn load_track(
    req: LoadReq,
    state: State<'_, EngineState>,
    waves: State<'_, WaveState>,
    stem_waves: State<'_, StemWaveState>,
) -> Result<Vec<f32>, String> {
    let deck = parse_deck(&req.deck)?;
    // Decode off the audio thread, then send the buffer in.
    let buffer = mixai_core::decoder::decode_file(&req.source).map_err(|e| e.to_string())?;
    load_decoded(
        deck,
        buffer,
        req.track_id,
        req.title,
        req.artist,
        req.bpm,
        &state,
        &waves,
        &stem_waves,
    )
}

/// Shared loader: analyse a decoded buffer, mirror metadata, send it to the
/// engine, and return the precomputed waveform peaks. Used by both the local
/// (`load_track`) and remote-streaming (`load_track_stream`) paths.
#[allow(clippy::too_many_arguments)]
fn load_decoded(
    deck: DeckId,
    buffer: mixai_core::deck::TrackBuffer,
    track_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    req_bpm: Option<f64>,
    state: &State<'_, EngineState>,
    waves: &State<'_, WaveState>,
    stem_waves: &State<'_, StemWaveState>,
) -> Result<Vec<f32>, String> {
    let dur = buffer.duration_secs();
    // Precompute waveform peaks while we own the buffer (engine takes ownership).
    let peaks = buffer.compute_peaks(2000);
    let bands = buffer.compute_band_peaks(WAVE_POINTS_PER_SECOND).to_bytes();
    // Analyse tempo + beat phase. Use the supplied BPM when present (library
    // metadata is authoritative); otherwise fall back to local detection.
    let analysis = mixai_core::analyze(&buffer);
    let bpm = match req_bpm {
        Some(b) if b > 0.0 => b,
        _ => analysis.bpm,
    };
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    // Mirror metadata for immediate UI reflection.
    {
        let mut m = engine.mirror();
        if let Some(d) = m.decks.iter_mut().find(|d| d.id == deck) {
            d.track_id = track_id.clone();
            d.title = title.clone();
            d.artist = artist.clone();
            d.bpm = bpm;
            d.loaded = true;
            d.duration = dur;
            d.position = 0.0;
            d.playing = false;
            d.first_beat = analysis.first_beat_secs;
        }
    }
    engine.send(Command::Load {
        deck,
        buffer,
        track_id,
        title,
        artist,
        bpm,
    });
    // Constant beatgrid from the analysis (phase anchor) so sync/quantize work at once.
    if bpm > 0.0 {
        engine.set_grid(deck, BeatGrid::constant(bpm, analysis.first_beat_secs));
    }
    publish_track_waves(deck_slot(deck), bands, waves, stem_waves);
    Ok(peaks)
}

/// Three-band waveform of the track on `deck` as raw bytes (`BandWave::to_bytes`): a binary
/// IPC body, never a JSON number array (a 7-minute track is ~190 kB). Empty = nothing loaded.
#[tauri::command]
fn deck_waveform_bands(
    deck: String,
    waves: State<'_, WaveState>,
) -> Result<tauri::ipc::Response, String> {
    let deck = parse_deck(&deck)?;
    let bytes = waves.0.lock().unwrap()[deck_slot(deck)]
        .clone()
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(bytes))
}

/// Peak lanes of the stems loaded on `deck` as raw bytes (`stem_lanes_bytes`). Empty = the
/// deck has no stems.
#[tauri::command]
fn deck_stem_lanes(
    deck: String,
    stem_waves: State<'_, StemWaveState>,
) -> Result<tauri::ipc::Response, String> {
    let deck = parse_deck(&deck)?;
    let bytes = stem_waves.0.lock().unwrap()[deck_slot(deck)]
        .clone()
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamReq {
    deck: String,
    /// Companion track id to stream.
    track_id: i64,
    title: Option<String>,
    artist: Option<String>,
    bpm: Option<f64>,
}

/// Load a track by streaming its encoded bytes from a remote companion
/// (LAN / tunnel), decoding in-memory, then loading like a local file.
/// Returns the waveform peaks. Async because the HTTP fetch must not block.
#[tauri::command]
async fn load_track_stream(
    req: StreamReq,
    engine: State<'_, EngineState>,
    companion: State<'_, CompanionState>,
    waves: State<'_, WaveState>,
    stem_waves: State<'_, StemWaveState>,
) -> Result<Vec<f32>, String> {
    let deck = parse_deck(&req.deck)?;
    let audio = companion::fetch_track_audio(&companion, req.track_id).await?;
    let buffer = mixai_core::decoder::decode_bytes(audio.bytes, audio.ext.as_deref())
        .map_err(|e| e.to_string())?;
    load_decoded(
        deck,
        buffer,
        Some(req.track_id.to_string()),
        req.title,
        req.artist,
        req.bpm,
        &engine,
        &waves,
        &stem_waves,
    )
}

#[tauri::command]
fn deck_play(
    deck: String,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    // Before the engine lock: a phone's held CUE ends here (lock order: remote, then engine).
    let now = std::time::Instant::now();
    remote::note_local(&remote_ctl, deck, remote::LocalTransport::Play, now);
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.playing = true;
    }
    engine.send(Command::Play(deck));
    Ok(())
}

#[tauri::command]
fn deck_pause(
    deck: String,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let now = std::time::Instant::now();
    remote::note_local(&remote_ctl, deck, remote::LocalTransport::Pause, now);
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.playing = false;
    }
    engine.send(Command::Pause(deck));
    Ok(())
}

#[tauri::command]
fn deck_seek(
    deck: String,
    position: f64,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    if !position.is_finite() {
        return Err("position must be a finite number".into());
    }
    let what = remote::LocalTransport::Seek(position);
    remote::note_local(&remote_ctl, deck, what, std::time::Instant::now());
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    engine.send(Command::Seek(deck, position));
    Ok(())
}

#[tauri::command]
fn deck_set_volume(deck: String, value: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.volume = value;
    }
    engine.send(Command::Volume(deck, value));
    Ok(())
}

/// Channel trim in dB (−∞..+12, 0 = unity), pre-EQ and independent of the fader.
#[tauri::command]
fn deck_set_trim(deck: String, db: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    if db.is_nan() {
        return Err("trim must be a number".into());
    }
    with_engine(&state, |e| e.set_trim(deck, db))
}

#[tauri::command]
fn deck_set_tempo(deck: String, value: f64, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.tempo = value;
    }
    engine.send(Command::Tempo(deck, value));
    Ok(())
}

#[tauri::command]
fn deck_set_key_lock(
    deck: String,
    enabled: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.key_lock = enabled;
    }
    engine.send(Command::KeyLock(deck, enabled));
    Ok(())
}

#[tauri::command]
fn deck_set_filter(deck: String, value: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.filter = value;
    }
    engine.send(Command::Filter(deck, value));
    Ok(())
}

#[tauri::command]
fn deck_set_cue(deck: String, enabled: bool, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.cue = enabled;
    }
    engine.send(Command::Cue(deck, enabled));
    Ok(())
}

#[tauri::command]
fn deck_set_eq(
    deck: String,
    band: String,
    db: f32,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        match band.as_str() {
            "low" => d.eq_low = db,
            "mid" => d.eq_mid = db,
            "high" => d.eq_high = db,
            _ => {}
        }
    }
    engine.send(Command::Eq(deck, band, db));
    Ok(())
}

#[tauri::command]
fn set_crossfader(value: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    engine.mirror().crossfader = value;
    engine.send(Command::Crossfader(value));
    Ok(())
}

/// Crossfader gain law: `"linear"`, `"smooth"` (equal power) or `"sharp"` (cut).
#[tauri::command]
fn set_crossfader_curve(curve: String, state: State<'_, EngineState>) -> Result<(), String> {
    let curve = mixai_core::CrossfaderCurve::parse(&curve)
        .ok_or_else(|| format!("invalid crossfader curve '{curve}'"))?;
    with_engine(&state, |e| e.set_crossfader_curve(curve))
}

/// Crossfader side of a deck: `"a"`, `"b"` or `"thru"` (bypasses the crossfader).
#[tauri::command]
fn deck_set_crossfader_assign(
    deck: String,
    assign: String,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let assign = mixai_core::CrossfaderAssign::parse(&assign)
        .ok_or_else(|| format!("invalid crossfader assign '{assign}'"))?;
    with_engine(&state, |e| e.set_crossfader_assign(deck, assign))
}

#[tauri::command]
fn set_master_volume(value: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    engine.mirror().master_volume = value;
    engine.send(Command::MasterVolume(value));
    Ok(())
}

/// Move the master output to `device_id` (`host:id` from `list_audio_devices`; empty = system
/// default). Decks keep playing state, routing and FX. If no engine is running yet (startup
/// failed) this tries to start one on that device.
#[tauri::command]
fn set_output_device(
    device_id: String,
    state: State<'_, EngineState>,
) -> Result<OutputInfo, String> {
    let id = Some(device_id.as_str()).filter(|s| !s.is_empty());
    let mut guard = state.0.lock().unwrap();
    match guard.as_mut() {
        Some(engine) => engine.switch_output_device(id).map_err(|e| e.to_string()),
        None => {
            let engine = Engine::start_with(id, None, None).map_err(|e| e.to_string())?;
            let info = engine.output_info();
            *guard = Some(engine);
            Ok(info)
        }
    }
}

/// Device, sample rate, channels and buffer size actually in use (with fallback notes).
#[tauri::command]
fn audio_output_info(state: State<'_, EngineState>) -> Option<OutputInfo> {
    state.0.lock().unwrap().as_ref().map(|e| e.output_info())
}

#[tauri::command]
fn set_cue_device(_device_id: String) -> Result<(), String> {
    Ok(())
}

// ---- hot cues + loops --------------------------------------------------------

fn with_engine(state: &State<'_, EngineState>, f: impl FnOnce(&Engine)) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    f(engine);
    Ok(())
}

#[tauri::command]
fn deck_set_hot_cue(
    deck: String,
    slot: usize,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::SetHotCue(deck, slot)))
}

#[tauri::command]
fn deck_jump_hot_cue(
    deck: String,
    slot: usize,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let now = std::time::Instant::now();
    remote::note_local(&remote_ctl, deck, remote::LocalTransport::Jump, now);
    with_engine(&state, |e| e.send(Command::JumpHotCue(deck, slot)))
}

#[tauri::command]
fn deck_clear_hot_cue(
    deck: String,
    slot: usize,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::ClearHotCue(deck, slot)))
}

#[tauri::command]
fn deck_loop_in(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::LoopIn(deck)))
}

#[tauri::command]
fn deck_loop_out(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::LoopOut(deck)))
}

#[tauri::command]
fn deck_loop_toggle(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::LoopToggle(deck)))
}

#[tauri::command]
fn deck_loop_exit(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::LoopExit(deck)))
}

#[tauri::command]
fn deck_beatloop(deck: String, beats: f64, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::Beatloop(deck, beats)))
}

#[tauri::command]
fn deck_loop_scale(deck: String, factor: f64, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::LoopScale(deck, factor)))
}

/// Beat-sync (legacy): set `deck`'s tempo so its effective BPM matches the other
/// (first playing, else first loaded) deck. When another deck is playing it also
/// aligns the beat phase (one-shot phase sync, see `deck_phase_sync`).
#[tauri::command]
fn deck_sync(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;

    // Find a master reference deck: prefer a playing, loaded deck with a BPM.
    let (this_bpm, target_eff_bpm, other_playing) = {
        let m = engine.mirror();
        let this = m.decks.iter().find(|d| d.id == deck);
        let this_bpm = this.map(|d| d.bpm).unwrap_or(0.0);
        let master = m
            .decks
            .iter()
            .filter(|d| d.id != deck && d.loaded && d.bpm > 0.0)
            .max_by_key(|d| d.playing as u8);
        let target = master.map(|d| d.bpm * d.tempo).unwrap_or(0.0);
        (this_bpm, target, master.is_some_and(|d| d.playing))
    };

    if this_bpm <= 0.0 || target_eff_bpm <= 0.0 {
        return Ok(()); // Nothing to sync to.
    }
    // Tempo ratio, clamped to the engine's ±50% range.
    let tempo = (target_eff_bpm / this_bpm).clamp(0.5, 1.5);
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.tempo = tempo;
    }
    engine.send(Command::Tempo(deck, tempo));
    if other_playing {
        engine.phase_sync(deck, false);
    }
    Ok(())
}

// ---- WP19-05 sync / clock -------------------------------------------------------

/// Phase sync `deck` to the master clock (tempo + beat/bar phase). `lock` keeps it
/// locked (continuous tempo follow + inaudible phase nudging).
#[tauri::command]
fn deck_phase_sync(
    deck: String,
    lock: Option<bool>,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    // A phase sync moves the playhead by a fraction of a beat.
    let now = std::time::Instant::now();
    remote::note_local(&remote_ctl, deck, remote::LocalTransport::Jump, now);
    with_engine(&state, |e| e.phase_sync(deck, lock.unwrap_or(false)))
}

/// Turn continuous sync lock on/off without a one-shot alignment.
#[tauri::command]
fn deck_set_sync_lock(
    deck: String,
    enabled: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_sync_lock(deck, enabled))
}

/// Replace a deck's beatgrid (seconds-based: bpm, firstBeat, downbeat, beatsPerBar,
/// anchors `[{time, beat}]` for variable tempo, `fixed` to ignore the anchors).
/// Every tempo must be in 20..400 and every time finite and non-negative.
#[tauri::command]
fn deck_set_beatgrid(
    deck: String,
    grid: BeatGrid,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    check_grid(&grid)?;
    with_engine(&state, |e| e.set_grid(deck, grid))
}

/// One tempo change for [`deck_set_grid_markers`].
#[derive(Deserialize)]
struct GridMarkerReq {
    sec: f64,
    bpm: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GridMarkersReq {
    deck: String,
    bpm: f64,
    first_beat: f64,
    #[serde(default)]
    downbeat: Option<i64>,
    #[serde(default)]
    fixed: bool,
    #[serde(default)]
    markers: Vec<GridMarkerReq>,
}

/// Flexible beatgrid from tempo-change markers (WP19-37): `bpm` is the tempo from
/// `firstBeat` to the first marker, every `markers[i]` means "from `sec` on the tempo is
/// `bpm`", and `fixed` keeps the markers but plays the constant grid. Equivalent to building
/// the anchors in the UI and calling `deck_set_beatgrid`, with the same maths as the engine.
#[tauri::command]
fn deck_set_grid_markers(req: GridMarkersReq, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&req.deck)?;
    let grid = grid_from_markers_req(&req)?;
    with_engine(&state, |e| e.set_grid(deck, grid))
}

/// Validated grid for [`deck_set_grid_markers`]. Every marker is checked, not just the base
/// tempo: `merge_markers` would drop an out-of-range one silently, leaving the user with a grid
/// that is not the one they asked for (WP19-37 P1-9).
fn grid_from_markers_req(req: &GridMarkersReq) -> Result<BeatGrid, String> {
    check_bpm("bpm", req.bpm)?;
    check_sec("firstBeat", req.first_beat)?;
    for (i, m) in req.markers.iter().enumerate() {
        check_bpm(&format!("markers[{i}].bpm"), m.bpm)?;
        check_sec(&format!("markers[{i}].sec"), m.sec)?;
    }
    let markers: Vec<TempoMarker> = req
        .markers
        .iter()
        .map(|m| TempoMarker {
            sec: m.sec,
            bpm: m.bpm,
        })
        .collect();
    let mut grid = BeatGrid::from_markers(req.bpm, req.first_beat, &markers, req.fixed);
    grid.downbeat = req.downbeat;
    Ok(grid)
}

#[tauri::command]
fn deck_set_quantize(
    deck: String,
    enabled: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_quantize(deck, enabled))
}

/// Beat-jump by `beats` (±1/2/4/8/16/32; fractions allowed).
#[tauri::command]
fn deck_beat_jump(
    deck: String,
    beats: f64,
    state: State<'_, EngineState>,
    remote_ctl: State<'_, remote::RemoteCtl>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    if !beats.is_finite() || beats.abs() > 64.0 {
        return Err("beats must be within ±64".into());
    }
    let now = std::time::Instant::now();
    remote::note_local(&remote_ctl, deck, remote::LocalTransport::Jump, now);
    with_engine(&state, |e| e.beat_jump(deck, beats))
}

#[tauri::command]
fn deck_set_slip(deck: String, enabled: bool, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_slip(deck, enabled))
}

/// Reverse playback (censor when slip is on).
#[tauri::command]
fn deck_set_reverse(
    deck: String,
    enabled: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_reverse(deck, enabled))
}

/// Key shift in semitones (−12..12), independent of tempo.
#[tauri::command]
fn deck_set_key_shift(
    deck: String,
    semitones: f64,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    if !semitones.is_finite() {
        return Err("semitones must be finite".into());
    }
    with_engine(&state, |e| e.set_key_shift(deck, semitones))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyMatchReq {
    deck: String,
    /// Deck key 0..23 (pitch class + 12 × minor); omitted = last known.
    key: Option<u8>,
    /// Master key 0..23; omitted = last known key of the master deck.
    master_key: Option<u8>,
    /// Camelot (`8A`) or Open Key (`1m`) alternatives to `key` / `masterKey`.
    key_name: Option<String>,
    master_key_name: Option<String>,
}

fn parse_key(num: Option<u8>, name: Option<&str>) -> Result<Option<u8>, String> {
    if let Some(k) = num {
        return if k < mixai_core::keys::KEY_COUNT {
            Ok(Some(k))
        } else {
            Err(format!("key {k} out of range 0..23"))
        };
    }
    match name {
        None => Ok(None),
        Some(n) => mixai_core::keys::camelot_to_key(n)
            .or_else(|| mixai_core::keys::open_key_to_key(n))
            .map(Some)
            .ok_or_else(|| format!("unknown key '{n}'")),
    }
}

/// Key-shift `deck` so it plays in the master's key (or its relative); returns the
/// applied shift in semitones.
#[tauri::command]
fn deck_key_match(req: KeyMatchReq, state: State<'_, EngineState>) -> Result<f64, String> {
    let deck = parse_deck(&req.deck)?;
    let key = parse_key(req.key, req.key_name.as_deref())?;
    let master_key = parse_key(req.master_key, req.master_key_name.as_deref())?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    engine
        .key_match(deck, key, master_key)
        .map_err(|e| e.to_string())
}

/// Remember a deck's musical key (0..23 or Camelot / Open Key) for key matching.
#[tauri::command]
fn deck_set_key(
    deck: String,
    key: Option<u8>,
    key_name: Option<String>,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let key = parse_key(key, key_name.as_deref())?;
    with_engine(&state, |e| e.set_deck_key(deck, key))
}

/// Master clock: `source` = `auto` | `internal` | `a`..`d`; `bpm` sets the internal tempo.
#[tauri::command]
fn master_set_clock(
    source: Option<String>,
    bpm: Option<f64>,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let src = match source.as_deref() {
        None => None,
        Some(s) => {
            Some(ClockSource::parse(s).ok_or_else(|| format!("invalid clock source '{s}'"))?)
        }
    };
    if bpm.is_some_and(|b| !b.is_finite() || !(20.0..=300.0).contains(&b)) {
        return Err("bpm must be within 20..300".into());
    }
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    let src = src.unwrap_or_else(|| engine.perf().clock);
    engine.set_clock(src, bpm);
    Ok(())
}

/// Master tempo + beat phase (and per-deck beat positions) for UI / MIDI clock out.
#[tauri::command]
fn engine_clock_state(state: State<'_, EngineState>) -> Option<ClockState> {
    state.0.lock().unwrap().as_ref().map(|e| e.clock_state())
}

// ---- WP19-06 routing ------------------------------------------------------------

/// Set the output routing matrix (cue mix, headphone level, split mono, 4-ch mode,
/// booth level, per-output latency compensation in ms).
#[tauri::command]
fn routing_set(routing: RoutingConfig, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_routing(routing))
}

#[tauri::command]
fn routing_get(state: State<'_, EngineState>) -> Option<RoutingConfig> {
    state.0.lock().unwrap().as_ref().map(|e| e.routing())
}

// ---- WP19-10 FX ---------------------------------------------------------------------

/// Colour FX: `kind` = none | filter | phaser | flanger | noise | dub_echo; `param` −1..1.
#[tauri::command]
fn fx_color_set(
    deck: String,
    kind: String,
    param: f32,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let kind = ColorFxKind::parse(&kind).ok_or_else(|| format!("unknown colour fx '{kind}'"))?;
    if !param.is_finite() {
        return Err("param must be finite".into());
    }
    with_engine(&state, |e| e.set_color_fx(deck, kind, param))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeatFxReq {
    deck: String,
    /// none | echo | reverb | roll | gate
    kind: String,
    /// Wet/dry 0..1 (roll engages above 0.5).
    wet: f32,
    /// Beat fraction 1/32..8 (echo time, roll length, gate step).
    beats: f64,
    /// Echo feedback / reverb decay / gate depth, 0..1 (default 0.5).
    feedback: Option<f32>,
}

/// Beat FX synced to the master clock.
#[tauri::command]
fn fx_beat_set(req: BeatFxReq, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&req.deck)?;
    let kind =
        BeatFxKind::parse(&req.kind).ok_or_else(|| format!("unknown beat fx '{}'", req.kind))?;
    if !req.wet.is_finite() || !req.beats.is_finite() || req.beats <= 0.0 {
        return Err("wet/beats must be finite and beats > 0".into());
    }
    let fb = req.feedback.filter(|f| f.is_finite()).unwrap_or(0.5);
    with_engine(&state, |e| {
        e.set_beat_fx(deck, kind, req.wet, req.beats, fb)
    })
}

/// Start recording the master mix to a WAV file at `path`.
#[tauri::command]
fn start_recording(path: String, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| {
        e.start_recording(std::path::PathBuf::from(&path))
    })
}

/// Stop recording and finalize the WAV file.
#[tauri::command]
fn stop_recording(state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.stop_recording())
}

/// Whether a master recording is currently in progress.
#[tauri::command]
fn is_recording(state: State<'_, EngineState>) -> Result<bool, String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    Ok(engine.is_recording())
}

// ---- stems -------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadStemsReq {
    deck: String,
    /// Absolute paths to the four stems; any may be null/omitted.
    vocals: Option<String>,
    drums: Option<String>,
    bass: Option<String>,
    melody: Option<String>,
}

/// Decode and attach separated stems to a deck (off the audio thread).
/// Returns the indices [0..3] that were successfully loaded.
#[tauri::command]
fn load_stems(
    req: LoadStemsReq,
    state: State<'_, EngineState>,
    stem_waves: State<'_, StemWaveState>,
) -> Result<Vec<usize>, String> {
    let deck = parse_deck(&req.deck)?;
    let paths = [req.vocals, req.drums, req.bass, req.melody];
    let mut layers: [Option<mixai_core::deck::TrackBuffer>; 4] = [None, None, None, None];
    let mut lanes: [Option<Vec<u8>>; 4] = [None, None, None, None];
    let mut loaded = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        if let Some(path) = p {
            if path.is_empty() {
                continue;
            }
            match mixai_core::decoder::decode_file(path) {
                Ok(buf) => {
                    lanes[i] = Some(buf.compute_peak_lane(WAVE_POINTS_PER_SECOND));
                    layers[i] = Some(buf);
                    loaded.push(i);
                }
                Err(e) => log::warn!("stem {i} decode failed ({path}): {e}"),
            }
        }
    }
    if loaded.is_empty() {
        return Err("no stems could be decoded".into());
    }
    let bytes = stem_lanes_bytes(WAVE_POINTS_PER_SECOND, &lanes);
    // Stored under the engine lock, in the order the engine gets the commands (see
    // `publish_track_waves`): a track load that lands right after this clears them again.
    with_engine(&state, |e| {
        e.load_stems(deck, layers);
        stem_waves.0.lock().unwrap()[deck_slot(deck)] = Some(bytes);
    })?;
    Ok(loaded)
}

/// Enable/disable stem playback for a deck (keeps loaded buffers).
#[tauri::command]
fn deck_set_stems_active(
    deck: String,
    on: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_stems_active(deck, on))
}

/// Set the live gain (0..1.5) for a stem (0=vocals,1=drums,2=bass,3=melody).
#[tauri::command]
fn deck_set_stem_gain(
    deck: String,
    idx: usize,
    gain: f32,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_stem_gain(deck, idx, gain))
}

/// Select the active FX (0=off, 1=echo, 2=reverb) for a deck.
#[tauri::command]
fn deck_set_fx_kind(deck: String, kind: u8, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_fx_kind(deck, kind))
}

/// Set the FX wet/dry mix (0..1) for a deck.
#[tauri::command]
fn deck_set_fx_wet(deck: String, wet: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_fx_wet(deck, wet))
}

/// Set the FX beat division (echo time) for a deck.
#[tauri::command]
fn deck_set_fx_beats(
    deck: String,
    beats: f64,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_fx_beats(deck, beats))
}

// ---- Sampler -----------------------------------------------------------------

/// Load an audio file into a sampler pad (decoded off the audio thread).
#[tauri::command]
fn sampler_load(pad: usize, path: String, state: State<'_, EngineState>) -> Result<(), String> {
    let buffer = mixai_core::decoder::decode_file(&path).map_err(|e| e.to_string())?;
    with_engine(&state, |e| e.load_sample(pad, buffer))
}

/// Clear a sampler pad.
#[tauri::command]
fn sampler_clear(pad: usize, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.clear_sample(pad))
}

/// Trigger a sampler pad from the start.
#[tauri::command]
fn sampler_trigger(pad: usize, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.trigger_sample(pad))
}

/// Stop a sampler pad immediately.
#[tauri::command]
fn sampler_stop(pad: usize, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.stop_sample(pad))
}

/// Set a sampler pad's gain (0..1.5).
#[tauri::command]
fn sampler_set_gain(pad: usize, gain: f32, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_sample_gain(pad, gain))
}

/// Toggle one-shot vs. loop for a sampler pad.
#[tauri::command]
fn sampler_set_looping(
    pad: usize,
    looping: bool,
    state: State<'_, EngineState>,
) -> Result<(), String> {
    with_engine(&state, |e| e.set_sample_looping(pad, looping))
}

// ---- MIDI --------------------------------------------------------------------

#[tauri::command]
fn list_midi_inputs() -> Vec<String> {
    midi::list_inputs()
}

#[tauri::command]
fn midi_connect(
    name: String,
    app: tauri::AppHandle,
    midi: State<'_, MidiState>,
) -> Result<String, String> {
    midi::connect(app, &midi, &name)
}

#[tauri::command]
fn midi_disconnect(midi: State<'_, MidiState>) -> Result<(), String> {
    midi::disconnect(&midi);
    Ok(())
}

#[tauri::command]
fn midi_set_learn(enabled: bool, midi: State<'_, MidiState>) -> Result<(), String> {
    midi::set_learn(&midi, enabled);
    Ok(())
}

#[tauri::command]
fn midi_get_preset(midi: State<'_, MidiState>) -> midi::Preset {
    midi::get_preset(&midi)
}

#[tauri::command]
fn midi_set_preset(preset: midi::Preset, midi: State<'_, MidiState>) -> Result<(), String> {
    midi::set_preset(&midi, preset);
    Ok(())
}

// ---- Bluetooth LE MIDI ---------------------------------------------------------

#[tauri::command]
async fn ble_midi_scan(
    app: tauri::AppHandle,
    seconds: Option<u64>,
) -> Result<Vec<ble_midi::BleMidiDevice>, String> {
    ble_midi::scan(&app, seconds.unwrap_or(4)).await
}

#[tauri::command]
async fn ble_midi_connect(app: tauri::AppHandle, name: String) -> Result<String, String> {
    ble_midi::connect(app, name).await
}

#[tauri::command]
async fn ble_midi_disconnect(app: tauri::AppHandle, forget: Option<bool>) -> Result<(), String> {
    ble_midi::disconnect(&app, forget.unwrap_or(true)).await;
    Ok(())
}

/// `[device name (connected or remembered), connected]`.
#[tauri::command]
fn ble_midi_status(app: tauri::AppHandle) -> (Option<String>, bool) {
    ble_midi::status(&app)
}

// ---- HID ---------------------------------------------------------------------

#[tauri::command]
fn list_hid_devices() -> Result<Vec<hid::HidDeviceInfo>, String> {
    hid::list_devices()
}

#[tauri::command]
fn hid_connect(
    path: String,
    app: tauri::AppHandle,
    hid: State<'_, HidState>,
) -> Result<String, String> {
    hid::connect(app, &hid, &path)
}

#[tauri::command]
fn hid_disconnect(hid: State<'_, HidState>) -> Result<(), String> {
    hid::disconnect(&hid);
    Ok(())
}

#[tauri::command]
fn hid_open_path(hid: State<'_, HidState>) -> Option<String> {
    hid::open_path(&hid)
}

#[tauri::command]
fn hid_write_report(bytes: Vec<u8>, hid: State<'_, HidState>) -> Result<(), String> {
    hid::write_report(&hid, bytes)
}

// ---- app entry ---------------------------------------------------------------

pub fn run() {
    let _ = env_logger::try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(EngineState(Mutex::new(None)))
        .manage(WaveState::default())
        .manage(StemWaveState::default())
        .manage(MidiState::new())
        .manage(BleMidiState::new())
        .manage(HidState::new())
        .manage(CompanionState::default())
        .manage(pack::PackState::default())
        .manage(link::LinkCtl::default())
        .manage(remote::RemoteCtl::default())
        .manage(copilot::CopilotCtl::default())
        .setup(|app| {
            // Custom HTML title bar: drop the native frame on Windows/Linux only. macOS keeps
            // `decorations: true` + Overlay title bar from tauri.conf.json (native traffic lights).
            #[cfg(not(target_os = "macos"))]
            if let Some(main) = app.get_webview_window("main")
                && let Err(e) = main.set_decorations(false)
            {
                log::warn!("could not remove native window decorations: {e}");
            }

            // Start the audio engine; degrade gracefully on failure.
            match Engine::start() {
                Ok(engine) => {
                    log::info!(
                        "MIXAI audio engine started: {} Hz, {} ch",
                        engine.sample_rate(),
                        engine.channels()
                    );
                    let state: State<'_, EngineState> = app.state();
                    *state.0.lock().unwrap() = Some(engine);
                }
                Err(e) => log::error!("MIXAI audio engine failed to start: {e}"),
            }

            // 30 Hz state pump → webview.
            let handle = app.handle().clone();
            // Reconnect the remembered Bluetooth MIDI controller whenever it is switched on.
            ble_midi::start_auto_connect(handle.clone());
            link::init(&handle);
            remote::init(&handle);
            copilot::init(&handle);
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(33));
                    let state: State<'_, EngineState> = handle.state();
                    let snapshot = {
                        let guard = state.0.lock().unwrap();
                        guard.as_ref().map(|e| e.snapshot_state())
                    };
                    if let Some(s) = snapshot {
                        let _ = handle.emit("mixer://state", s);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            get_mixer_state,
            load_track,
            load_track_stream,
            deck_waveform_bands,
            deck_stem_lanes,
            deck_play,
            deck_pause,
            deck_seek,
            deck_set_volume,
            deck_set_trim,
            deck_set_tempo,
            deck_set_key_lock,
            deck_set_eq,
            deck_set_filter,
            deck_set_cue,
            set_crossfader,
            set_crossfader_curve,
            deck_set_crossfader_assign,
            set_master_volume,
            set_output_device,
            audio_output_info,
            set_cue_device,
            deck_set_hot_cue,
            deck_jump_hot_cue,
            deck_clear_hot_cue,
            deck_loop_in,
            deck_loop_out,
            deck_loop_toggle,
            deck_loop_exit,
            deck_beatloop,
            deck_loop_scale,
            deck_sync,
            deck_phase_sync,
            deck_set_sync_lock,
            deck_set_beatgrid,
            deck_set_grid_markers,
            deck_set_quantize,
            deck_beat_jump,
            deck_set_slip,
            deck_set_reverse,
            deck_set_key_shift,
            deck_key_match,
            deck_set_key,
            master_set_clock,
            engine_clock_state,
            routing_set,
            routing_get,
            fx_color_set,
            fx_beat_set,
            list_midi_inputs,
            midi_connect,
            midi_disconnect,
            midi_set_learn,
            midi_get_preset,
            midi_set_preset,
            ble_midi_scan,
            ble_midi_connect,
            ble_midi_disconnect,
            ble_midi_status,
            start_recording,
            stop_recording,
            is_recording,
            load_stems,
            deck_set_stems_active,
            deck_set_stem_gain,
            deck_set_fx_kind,
            deck_set_fx_wet,
            deck_set_fx_beats,
            sampler_load,
            sampler_clear,
            sampler_trigger,
            sampler_stop,
            sampler_set_gain,
            sampler_set_looping,
            companion::companion_status,
            companion::companion_configure,
            companion::companion_tracks,
            companion::companion_track_peaks,
            companion::companion_toggle_favorite,
            companion::companion_track_stems,
            companion::companion_request_stems,
            companion::companion_stem_job,
            companion::companion_get_profile,
            companion::companion_put_profile,
            list_hid_devices,
            hid_connect,
            hid_disconnect,
            hid_open_path,
            hid_write_report,
            window_ctl::window_show_snap_overlay,
            window_ctl::window_pop_out,
            pack::pack_inspect,
            pack::pack_install,
            pack::pack_list,
            pack::pack_remove,
            pack::pack_pick_file,
            pack::pack_build,
            pack::pack_export,
            // -- link (WP19-29): commands of src/link.rs --
            link::link_status,
            link::link_start,
            link::link_stop,
            link::link_set,
            // -- remote (WP19-42): commands of src/remote.rs --
            remote::remote_status,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_rotate,
            remote::remote_requests,
            remote::remote_request_set,
            remote::remote_set,
            // -- copilot (WP19-39): commands of src/copilot.rs --
            copilot::copilot_rank,
            copilot::copilot_plan,
            copilot::copilot_run,
            copilot::copilot_cancel,
            copilot::copilot_status,
            copilot::copilot_safety,
            copilot::copilot_intent,
            copilot::copilot_intent_schema,
            // -- stems / cue loops (WP19-41): commands of src/stems.rs --
            stems::deck_set_stem_mute,
            stems::deck_set_stem_xf,
            stems::deck_set_stem_mute_fx,
            stems::deck_save_cue_loop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MIXAI");
}

#[cfg(test)]
mod stem_lane_tests {
    use super::{StemWaveState, WaveState, publish_track_waves, stem_lanes_bytes};

    #[test]
    fn a_track_load_replaces_the_bands_and_drops_that_decks_stem_lanes() {
        let waves = WaveState::default();
        let stems = StemWaveState::default();
        waves.0.lock().unwrap()[1] = Some(vec![1]);
        *stems.0.lock().unwrap() = [Some(vec![10]), Some(vec![11]), None, Some(vec![13])];
        publish_track_waves(1, vec![7, 8, 9], &waves, &stems);
        assert_eq!(
            *waves.0.lock().unwrap(),
            [None, Some(vec![7, 8, 9]), None, None]
        );
        // Only the loaded deck loses its lanes (they were the previous track's stems).
        assert_eq!(
            *stems.0.lock().unwrap(),
            [Some(vec![10]), None, None, Some(vec![13])]
        );
    }

    #[test]
    fn stem_lanes_wire_form_is_header_mask_and_four_padded_lanes() {
        // Drums (1) and melody (3) loaded; melody is one point shorter and gets zero-padded.
        let lanes = [None, Some(vec![1, 2, 3]), None, Some(vec![7, 8])];
        assert_eq!(
            stem_lanes_bytes(150, &lanes),
            vec![
                150, 0, 0, 0, // points per second
                3, 0, 0, 0, // len
                0b1010, 0, 0, 0, // mask
                0, 0, 0, // vocals (absent)
                1, 2, 3, // drums
                0, 0, 0, // bass (absent)
                7, 8, 0, // melody (padded)
            ]
        );
        // No stems at all: header only, len 0, mask 0.
        assert_eq!(
            stem_lanes_bytes(150, &[None, None, None, None]),
            vec![150, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
    }
}

#[cfg(test)]
mod grid_command_tests {
    use super::*;
    use mixai_core::GridAnchor;

    fn req(bpm: f64, first_beat: f64, markers: &[(f64, f64)]) -> GridMarkersReq {
        GridMarkersReq {
            deck: "a".into(),
            bpm,
            first_beat,
            downbeat: Some(0),
            fixed: false,
            markers: markers
                .iter()
                .map(|&(sec, bpm)| GridMarkerReq { sec, bpm })
                .collect(),
        }
    }

    /// P1-9: every marker of `deck_set_grid_markers` is range-checked, not just the base tempo.
    #[test]
    fn grid_markers_reject_every_out_of_range_value() {
        let ok = grid_from_markers_req(&req(120.0, 0.5, &[(16.5, 128.0)])).expect("valid");
        assert!(ok.is_variable() && ok.beat_at(30.0).is_finite());
        for bad in [
            1e-300,
            1e308,
            0.0,
            -1.0,
            19.9,
            400.1,
            f64::NAN,
            f64::INFINITY,
        ] {
            assert!(
                grid_from_markers_req(&req(120.0, 0.5, &[(16.5, bad)])).is_err(),
                "marker bpm {bad}"
            );
            assert!(
                grid_from_markers_req(&req(bad, 0.5, &[])).is_err(),
                "bpm {bad}"
            );
        }
        for bad in [-0.1, f64::NAN, f64::INFINITY] {
            assert!(
                grid_from_markers_req(&req(120.0, 0.5, &[(bad, 128.0)])).is_err(),
                "marker sec {bad}"
            );
            assert!(
                grid_from_markers_req(&req(120.0, bad, &[])).is_err(),
                "firstBeat {bad}"
            );
        }
    }

    /// P1-9: `deck_set_beatgrid` rejects bpm <= 0 and non-finite anchors.
    #[test]
    fn beatgrid_rejects_bad_tempo_and_anchors() {
        let good = BeatGrid::constant(128.0, 0.25);
        assert!(check_grid(&good).is_ok());
        for bad in [0.0, -128.0, 1e-300, 1e308, f64::NAN] {
            assert!(check_grid(&BeatGrid::constant(bad, 0.25)).is_err(), "{bad}");
        }
        assert!(check_grid(&BeatGrid::constant(128.0, -1.0)).is_err());
        let mut g = good.clone();
        g.anchors = vec![
            GridAnchor {
                time: 0.0,
                beat: 0.0,
            },
            GridAnchor {
                time: f64::NAN,
                beat: 4.0,
            },
        ];
        assert!(check_grid(&g).is_err());
        g.anchors[1] = GridAnchor {
            time: 2.0,
            beat: f64::INFINITY,
        };
        assert!(check_grid(&g).is_err());
        g.anchors[1] = GridAnchor {
            time: 2.0,
            beat: 4.0,
        };
        assert!(check_grid(&g).is_ok());
        // A 1e-300 s segment is a 1e302 BPM tempo: rejected like any other anchor tempo.
        g.anchors[1] = GridAnchor {
            time: 1e-300,
            beat: 1.0,
        };
        assert!(check_grid(&g).is_err());
    }
}
