//! Native MIDI controller support (`midir`).
//!
//! Ported from the web app's data-driven engine (`apps/web/src/lib/midi-engine.ts`):
//! a list of `Mapping {status, midino, type, action, deck}` translates raw MIDI
//! bytes into semantic `MidiAction`s, which are dispatched to the audio engine.
//!
//! Two layers, same as the web version:
//!   1. **Input mapping** — bytes → action (this file).
//!   2. **Output feedback (LEDs)** — engine state → MIDI out (follow-up; the
//!      port handle is kept so we can light pads/buttons next).
//!
//! Plus a **learn mode**: the next control touched is reported to the UI so a
//! user can bind any controller without a preset.

use std::sync::{Arc, Mutex};

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::EngineState;
use mixai_core::{Command, DeckId};

// ---- mapping model -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MidiAction {
    Play,
    Cue,
    Sync,
    Shift,
    TempoSlider,
    VolumeFader,
    Crossfader,
    Filter,
    EqHi,
    EqMid,
    EqLow,
    HeadphoneCue,
    LoopIn,
    LoopOut,
    Reloop,
    LoopHalve,
    LoopDouble,
    Beatloop1,
    Beatloop2,
    Beatloop4,
    Beatloop8,
    Hotcue1,
    Hotcue2,
    Hotcue3,
    Hotcue4,
    Hotcue5,
    Hotcue6,
    Hotcue7,
    Hotcue8,
    MasterVolume,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ControlType {
    Note,
    Cc,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    /// Status byte (message type + channel), e.g. 0x90 = Note On ch1.
    pub status: u8,
    /// Note or CC number.
    pub midino: u8,
    pub action: MidiAction,
    /// Target deck (None = master/global).
    pub deck: Option<DeckId>,
    #[serde(rename = "type")]
    pub control_type: ControlType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub mappings: Vec<Mapping>,
}

impl Default for Preset {
    fn default() -> Self {
        ddj_flx4_preset()
    }
}

/// Default Pioneer DDJ-FLX4 preset (subset that maps to v0.1 engine features).
/// Deck A = ch1 (status 0x90/0xB0), Deck B = ch2 (status 0x91/0xB1).
/// Hot-cue pads live on their own performance-pad channels (0x97 / 0x99).
pub fn ddj_flx4_preset() -> Preset {
    use ControlType::{Cc, Note};
    use MidiAction::*;

    let mut m = Vec::new();
    // Per-deck (A on ch1, B on ch2) transport + mixer.
    for (deck, note_st, cc_st, pad_st) in
        [(DeckId::A, 0x90u8, 0xB0u8, 0x97u8), (DeckId::B, 0x91u8, 0xB1u8, 0x99u8)]
    {
        let d = Some(deck);
        m.push(Mapping { status: note_st, midino: 0x0B, action: Play, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x0C, action: Cue, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x58, action: Sync, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x3F, action: Shift, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x54, action: HeadphoneCue, deck: d, control_type: Note });
        // Loops.
        m.push(Mapping { status: note_st, midino: 0x10, action: LoopIn, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x11, action: LoopOut, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x4D, action: Reloop, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x51, action: LoopHalve, deck: d, control_type: Note });
        m.push(Mapping { status: note_st, midino: 0x53, action: LoopDouble, deck: d, control_type: Note });
        // Continuous controls (we use the 7-bit MSB only for v0.1).
        m.push(Mapping { status: cc_st, midino: 0x00, action: TempoSlider, deck: d, control_type: Cc });
        m.push(Mapping { status: cc_st, midino: 0x07, action: EqHi, deck: d, control_type: Cc });
        m.push(Mapping { status: cc_st, midino: 0x0B, action: EqMid, deck: d, control_type: Cc });
        m.push(Mapping { status: cc_st, midino: 0x0F, action: EqLow, deck: d, control_type: Cc });
        m.push(Mapping { status: cc_st, midino: 0x13, action: VolumeFader, deck: d, control_type: Cc });
        m.push(Mapping { status: cc_st, midino: 0x18, action: Filter, deck: d, control_type: Cc });
        // Hot-cue pads 1..8 on the performance-pad channel.
        let cues = [Hotcue1, Hotcue2, Hotcue3, Hotcue4, Hotcue5, Hotcue6, Hotcue7, Hotcue8];
        for (i, action) in cues.into_iter().enumerate() {
            m.push(Mapping { status: pad_st, midino: i as u8, action, deck: d, control_type: Note });
        }
    }
    // Master / global.
    m.push(Mapping { status: 0xB6, midino: 0x1F, action: Crossfader, deck: None, control_type: Cc });
    m.push(Mapping { status: 0xB6, midino: 0x09, action: MasterVolume, deck: None, control_type: Cc });

    Preset { name: "Pioneer DDJ-FLX4".into(), mappings: m }
}

// ---- runtime -----------------------------------------------------------------

/// A learned control event surfaced to the UI in learn mode.
#[derive(Debug, Clone, Serialize)]
pub struct LearnEvent {
    pub status: u8,
    pub midino: u8,
    pub value: u8,
}

/// Shared MIDI runtime, managed by Tauri. Holds the live connection plus the
/// active preset and learn flag (both read from the input callback).
#[derive(Default)]
pub struct MidiState {
    inner: Mutex<MidiInner>,
}

#[derive(Default)]
struct MidiInner {
    _conn_in: Option<MidiInputConnection<()>>,
    conn_out: Option<MidiOutputConnection>,
    preset: Arc<Mutex<Preset>>,
    learn: Arc<std::sync::atomic::AtomicBool>,
}

impl MidiState {
    pub fn new() -> Self {
        MidiState::default()
    }
}

/// List available MIDI input port names.
pub fn list_inputs() -> Vec<String> {
    match MidiInput::new("mixai-scan") {
        Ok(input) => input
            .ports()
            .iter()
            .filter_map(|p| input.port_name(p).ok())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Connect to the input (and matching output, if any) whose name contains
/// `name_contains`. Replaces any existing connection.
pub fn connect(
    app: AppHandle,
    midi: &MidiState,
    name_contains: &str,
) -> Result<String, String> {
    let input = MidiInput::new("mixai-in").map_err(|e| e.to_string())?;
    let port = input
        .ports()
        .into_iter()
        .find(|p| {
            input
                .port_name(p)
                .map(|n| n.to_lowercase().contains(&name_contains.to_lowercase()))
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("no MIDI input matching '{name_contains}'"))?;
    let port_name = input.port_name(&port).unwrap_or_else(|_| "MIDI".into());

    let mut guard = midi.inner.lock().unwrap();
    // Auto-pick the DDJ-FLX4 preset if the device name matches; else keep
    // whatever was set (default to FLX4 for the scaffold).
    if guard.preset.lock().unwrap().mappings.is_empty() {
        *guard.preset.lock().unwrap() = ddj_flx4_preset();
    }
    let preset = guard.preset.clone();
    let learn = guard.learn.clone();
    let app_cb = app.clone();

    let conn = input
        .connect(
            &port,
            "mixai-in",
            move |_stamp, bytes, _| handle_message(&app_cb, &preset, &learn, bytes),
            (),
        )
        .map_err(|e| e.to_string())?;
    guard._conn_in = Some(conn);

    // Best-effort matching output for LED feedback (follow-up wiring).
    if let Ok(output) = MidiOutput::new("mixai-out") {
        if let Some(op) = output.ports().into_iter().find(|p| {
            output
                .port_name(p)
                .map(|n| n.to_lowercase().contains(&name_contains.to_lowercase()))
                .unwrap_or(false)
        }) {
            if let Ok(oc) = output.connect(&op, "mixai-out") {
                guard.conn_out = Some(oc);
            }
        }
    }

    Ok(port_name)
}

pub fn disconnect(midi: &MidiState) {
    let mut guard = midi.inner.lock().unwrap();
    guard._conn_in = None;
    guard.conn_out = None;
}

pub fn set_learn(midi: &MidiState, on: bool) {
    let guard = midi.inner.lock().unwrap();
    guard.learn.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Return a clone of the active preset (name + mappings) for the UI / sharing.
pub fn get_preset(midi: &MidiState) -> Preset {
    let guard = midi.inner.lock().unwrap();
    let preset = guard.preset.lock().unwrap();
    if preset.mappings.is_empty() {
        ddj_flx4_preset()
    } else {
        preset.clone()
    }
}

/// Replace the active preset (e.g. an imported/edited custom mapping). Takes
/// effect immediately for the live connection (the input callback reads it).
pub fn set_preset(midi: &MidiState, preset: Preset) {
    let guard = midi.inner.lock().unwrap();
    *guard.preset.lock().unwrap() = preset;
}

/// Parse one MIDI message and either report it (learn) or dispatch its action.
fn handle_message(
    app: &AppHandle,
    preset: &Arc<Mutex<Preset>>,
    learn: &Arc<std::sync::atomic::AtomicBool>,
    bytes: &[u8],
) {
    if bytes.len() < 2 {
        return;
    }
    let status = bytes[0];
    let midino = bytes[1];
    let value = *bytes.get(2).unwrap_or(&0);

    if learn.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = app.emit("midi://learn", LearnEvent { status, midino, value });
        return;
    }

    // Note Off (0x8n) and Note On with velocity 0 both = release; ignore for
    // momentary triggers (we act on press only).
    let is_note_off = (status & 0xF0) == 0x80 || ((status & 0xF0) == 0x90 && value == 0);

    let preset = preset.lock().unwrap();
    let Some(map) = preset
        .mappings
        .iter()
        .find(|m| m.status == status && m.midino == midino)
    else {
        return;
    };

    let cmd = match map_to_command(map, value, is_note_off) {
        Some(c) => c,
        None => return,
    };

    // Dispatch on the engine via the managed state.
    let state: tauri::State<'_, EngineState> = app.state();
    let guard = state.0.lock().unwrap();
    if let Some(engine) = guard.as_ref() {
        engine.send(cmd);
    }
}

/// Translate a matched mapping + value into an engine `Command`.
fn map_to_command(map: &Mapping, value: u8, is_note_off: bool) -> Option<Command> {
    use MidiAction::*;
    let norm = value as f32 / 127.0; // 0..1
    let deck = map.deck;

    // Helper for deck-scoped commands.
    macro_rules! d {
        () => {
            deck?
        };
    }

    Some(match map.action {
        // Momentary buttons act on press only.
        Play if !is_note_off => Command::Play(d!()),
        Cue if !is_note_off => Command::Pause(d!()),
        LoopIn if !is_note_off => Command::LoopIn(d!()),
        LoopOut if !is_note_off => Command::LoopOut(d!()),
        Reloop if !is_note_off => Command::LoopToggle(d!()),
        LoopHalve if !is_note_off => Command::LoopScale(d!(), 0.5),
        LoopDouble if !is_note_off => Command::LoopScale(d!(), 2.0),
        Beatloop1 if !is_note_off => Command::Beatloop(d!(), 1.0),
        Beatloop2 if !is_note_off => Command::Beatloop(d!(), 2.0),
        Beatloop4 if !is_note_off => Command::Beatloop(d!(), 4.0),
        Beatloop8 if !is_note_off => Command::Beatloop(d!(), 8.0),
        Hotcue1 if !is_note_off => Command::JumpHotCue(d!(), 0),
        Hotcue2 if !is_note_off => Command::JumpHotCue(d!(), 1),
        Hotcue3 if !is_note_off => Command::JumpHotCue(d!(), 2),
        Hotcue4 if !is_note_off => Command::JumpHotCue(d!(), 3),
        Hotcue5 if !is_note_off => Command::JumpHotCue(d!(), 4),
        Hotcue6 if !is_note_off => Command::JumpHotCue(d!(), 5),
        Hotcue7 if !is_note_off => Command::JumpHotCue(d!(), 6),
        Hotcue8 if !is_note_off => Command::JumpHotCue(d!(), 7),
        HeadphoneCue if !is_note_off => Command::Cue(d!(), true),

        // Continuous controls.
        VolumeFader => Command::Volume(d!(), norm),
        TempoSlider => Command::Tempo(d!(), 0.5 + norm as f64), // 0.5..1.5
        Filter => Command::Filter(d!(), norm * 2.0 - 1.0),      // -1..1
        EqHi => Command::Eq(d!(), "high".into(), norm * 32.0 - 26.0),
        EqMid => Command::Eq(d!(), "mid".into(), norm * 32.0 - 26.0),
        EqLow => Command::Eq(d!(), "low".into(), norm * 32.0 - 26.0),
        Crossfader => Command::Crossfader(norm * 2.0 - 1.0),
        MasterVolume => Command::MasterVolume(norm * 1.5),

        // Releases / unmapped-on-this-edge → nothing.
        _ => return None,
    })
}
