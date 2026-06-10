//! MIXAI Tauri app: exposes the `mixai-core` audio engine to the webview via
//! commands, and pushes a throttled `mixer://state` event at ~30 Hz so the UI
//! meters/transport stay live without polling.

use std::sync::Mutex;
use std::time::Duration;

use mixai_core::{
    list_output_devices, AudioDevice, Command, DeckId, Engine, MixerState,
};
use serde::Deserialize;
use tauri::{Emitter, Manager, State};

mod midi;
use midi::MidiState;

mod hid;
use hid::HidState;

mod companion;
use companion::CompanionState;

/// Tauri-managed engine handle. `Option` so a device failure doesn't crash the
/// whole app — the UI degrades to "UI preview" mode.
pub struct EngineState(pub Mutex<Option<Engine>>);

fn parse_deck(s: &str) -> Result<DeckId, String> {
    DeckId::from_str(s).ok_or_else(|| format!("invalid deck '{s}'"))
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
fn load_track(req: LoadReq, state: State<'_, EngineState>) -> Result<Vec<f32>, String> {
    let deck = parse_deck(&req.deck)?;
    // Decode off the audio thread, then send the buffer in.
    let buffer = mixai_core::decoder::decode_file(&req.source).map_err(|e| e.to_string())?;
    load_decoded(deck, buffer, req.track_id, req.title, req.artist, req.bpm, &state)
}

/// Shared loader: analyse a decoded buffer, mirror metadata, send it to the
/// engine, and return the precomputed waveform peaks. Used by both the local
/// (`load_track`) and remote-streaming (`load_track_stream`) paths.
fn load_decoded(
    deck: DeckId,
    buffer: mixai_core::deck::TrackBuffer,
    track_id: Option<String>,
    title: Option<String>,
    artist: Option<String>,
    req_bpm: Option<f64>,
    state: &State<'_, EngineState>,
) -> Result<Vec<f32>, String> {
    let dur = buffer.duration_secs();
    // Precompute waveform peaks while we own the buffer (engine takes ownership).
    let peaks = buffer.compute_peaks(2000);
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
    Ok(peaks)
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
    )
}

#[tauri::command]
fn deck_play(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.playing = true;
    }
    engine.send(Command::Play(deck));
    Ok(())
}

#[tauri::command]
fn deck_pause(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        d.playing = false;
    }
    engine.send(Command::Pause(deck));
    Ok(())
}

#[tauri::command]
fn deck_seek(deck: String, position: f64, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
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
fn deck_set_key_lock(deck: String, enabled: bool, state: State<'_, EngineState>) -> Result<(), String> {
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
fn deck_set_eq(deck: String, band: String, db: f32, state: State<'_, EngineState>) -> Result<(), String> {
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

#[tauri::command]
fn set_master_volume(value: f32, state: State<'_, EngineState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    engine.mirror().master_volume = value;
    engine.send(Command::MasterVolume(value));
    Ok(())
}

#[tauri::command]
fn set_output_device(_device_id: String) -> Result<(), String> {
    // Device switching rebuilds the cpal stream; implemented in a follow-up.
    // The settings UI is wired so this lands without UI changes.
    Ok(())
}

#[tauri::command]
fn set_cue_device(_device_id: String) -> Result<(), String> {
    Ok(())
}

// ---- hot cues + loops --------------------------------------------------------

fn with_engine(
    state: &State<'_, EngineState>,
    f: impl FnOnce(&Engine),
) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;
    f(engine);
    Ok(())
}

#[tauri::command]
fn deck_set_hot_cue(deck: String, slot: usize, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::SetHotCue(deck, slot)))
}

#[tauri::command]
fn deck_jump_hot_cue(deck: String, slot: usize, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.send(Command::JumpHotCue(deck, slot)))
}

#[tauri::command]
fn deck_clear_hot_cue(deck: String, slot: usize, state: State<'_, EngineState>) -> Result<(), String> {
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

/// Beat-sync: set `deck`'s tempo so its effective BPM matches the other
/// (first playing, else first loaded) deck. Reads BPMs from the mirror.
#[tauri::command]
fn deck_sync(deck: String, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    let guard = state.0.lock().unwrap();
    let engine = guard.as_ref().ok_or("engine not running")?;

    // Find a master reference deck: prefer a playing, loaded deck with a BPM.
    let (this_bpm, target_eff_bpm) = {
        let m = engine.mirror();
        let this = m.decks.iter().find(|d| d.id == deck);
        let this_bpm = this.map(|d| d.bpm).unwrap_or(0.0);
        let master = m
            .decks
            .iter()
            .filter(|d| d.id != deck && d.loaded && d.bpm > 0.0)
            .max_by_key(|d| d.playing as u8);
        let target = master.map(|d| d.bpm * d.tempo).unwrap_or(0.0);
        (this_bpm, target)
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
    Ok(())
}

/// Start recording the master mix to a WAV file at `path`.
#[tauri::command]
fn start_recording(path: String, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.start_recording(std::path::PathBuf::from(&path)))
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
fn load_stems(req: LoadStemsReq, state: State<'_, EngineState>) -> Result<Vec<usize>, String> {
    let deck = parse_deck(&req.deck)?;
    let paths = [req.vocals, req.drums, req.bass, req.melody];
    let mut layers: [Option<mixai_core::deck::TrackBuffer>; 4] = [None, None, None, None];
    let mut loaded = Vec::new();
    for (i, p) in paths.iter().enumerate() {
        if let Some(path) = p {
            if path.is_empty() {
                continue;
            }
            match mixai_core::decoder::decode_file(path) {
                Ok(buf) => {
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
    with_engine(&state, |e| e.load_stems(deck, layers))?;
    Ok(loaded)
}

/// Enable/disable stem playback for a deck (keeps loaded buffers).
#[tauri::command]
fn deck_set_stems_active(deck: String, on: bool, state: State<'_, EngineState>) -> Result<(), String> {
    let deck = parse_deck(&deck)?;
    with_engine(&state, |e| e.set_stems_active(deck, on))
}

/// Set the live gain (0..1.5) for a stem (0=vocals,1=drums,2=bass,3=melody).
#[tauri::command]
fn deck_set_stem_gain(deck: String, idx: usize, gain: f32, state: State<'_, EngineState>) -> Result<(), String> {
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
fn deck_set_fx_beats(deck: String, beats: f64, state: State<'_, EngineState>) -> Result<(), String> {
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
fn sampler_set_looping(pad: usize, looping: bool, state: State<'_, EngineState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_sample_looping(pad, looping))
}

// ---- MIDI --------------------------------------------------------------------

#[tauri::command]
fn list_midi_inputs() -> Vec<String> {
    midi::list_inputs()
}

#[tauri::command]
fn midi_connect(name: String, app: tauri::AppHandle, midi: State<'_, MidiState>) -> Result<String, String> {
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

// ---- HID ---------------------------------------------------------------------

#[tauri::command]
fn list_hid_devices() -> Result<Vec<hid::HidDeviceInfo>, String> {
    hid::list_devices()
}

#[tauri::command]
fn hid_connect(path: String, app: tauri::AppHandle, hid: State<'_, HidState>) -> Result<String, String> {
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
        .manage(MidiState::new())
        .manage(HidState::new())
        .manage(CompanionState::default())
        .setup(|app| {
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
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(33));
                let state: State<'_, EngineState> = handle.state();
                let snapshot = {
                    let guard = state.0.lock().unwrap();
                    guard.as_ref().map(|e| e.snapshot_state())
                };
                if let Some(s) = snapshot {
                    let _ = handle.emit("mixer://state", s);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            get_mixer_state,
            load_track,
            load_track_stream,
            deck_play,
            deck_pause,
            deck_seek,
            deck_set_volume,
            deck_set_tempo,
            deck_set_key_lock,
            deck_set_eq,
            deck_set_filter,
            deck_set_cue,
            set_crossfader,
            set_master_volume,
            set_output_device,
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
            list_midi_inputs,
            midi_connect,
            midi_disconnect,
            midi_set_learn,
            midi_get_preset,
            midi_set_preset,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running MIXAI");
}
