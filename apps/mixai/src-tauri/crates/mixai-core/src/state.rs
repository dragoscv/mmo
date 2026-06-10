//! Serializable state mirrored to the UI. Field names use camelCase to match
//! the TypeScript types in `apps/mixai/src/bridge/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeckId {
    A,
    B,
    C,
    D,
}

impl DeckId {
    pub const ALL: [DeckId; 4] = [DeckId::A, DeckId::B, DeckId::C, DeckId::D];

    pub fn index(self) -> usize {
        match self {
            DeckId::A => 0,
            DeckId::B => 1,
            DeckId::C => 2,
            DeckId::D => 3,
        }
    }

    pub fn from_str(s: &str) -> Option<DeckId> {
        match s {
            "a" => Some(DeckId::A),
            "b" => Some(DeckId::B),
            "c" => Some(DeckId::C),
            "d" => Some(DeckId::D),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrossfaderAssign {
    A,
    Thru,
    B,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrossfaderCurve {
    Linear,
    Smooth,
    Sharp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckState {
    pub id: DeckId,
    pub track_id: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub loaded: bool,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub bpm: f64,
    pub tempo: f64,
    pub key_lock: bool,
    pub volume: f32,
    pub eq_low: f32,
    pub eq_mid: f32,
    pub eq_high: f32,
    pub filter: f32,
    pub crossfader_assign: CrossfaderAssign,
    pub cue: bool,
    pub vu: f32,
    /// Hot-cue positions in seconds (None = unset), 8 slots.
    pub hot_cues: Vec<Option<f64>>,
    pub loop_active: bool,
    pub loop_start: f64,
    pub loop_end: f64,
    /// Beatgrid anchor: time of the first detected beat, in seconds.
    pub first_beat: f64,
    /// True when separated stems are loaded for this deck.
    pub has_stems: bool,
    /// True when stem playback is active (overrides the full mix).
    pub stems_active: bool,
    /// Per-stem gains [vocals, drums, bass, melody], 0..1.5.
    pub stem_gains: Vec<f32>,
    /// Active FX (0=off, 1=echo, 2=reverb).
    pub fx_kind: u8,
    /// FX wet/dry mix, 0..1.
    pub fx_wet: f32,
    /// FX beat division (echo time), e.g. 0.25/0.5/1/2.
    pub fx_beats: f64,
}

impl DeckState {
    pub fn empty(id: DeckId) -> Self {
        let assign = match id {
            DeckId::A | DeckId::C => CrossfaderAssign::A,
            DeckId::B | DeckId::D => CrossfaderAssign::B,
        };
        DeckState {
            id,
            track_id: None,
            title: None,
            artist: None,
            loaded: false,
            playing: false,
            position: 0.0,
            duration: 0.0,
            bpm: 0.0,
            tempo: 1.0,
            key_lock: true,
            volume: 0.85,
            eq_low: 0.0,
            eq_mid: 0.0,
            eq_high: 0.0,
            filter: 0.0,
            crossfader_assign: assign,
            cue: false,
            vu: 0.0,
            hot_cues: vec![None; 8],
            loop_active: false,
            loop_start: 0.0,
            loop_end: 0.0,
            first_beat: 0.0,
            has_stems: false,
            stems_active: false,
            stem_gains: vec![1.0; 4],
            fx_kind: 0,
            fx_wet: 0.0,
            fx_beats: 0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerState {
    pub crossfader: f32,
    pub crossfader_curve: CrossfaderCurve,
    pub master_volume: f32,
    pub cue_volume: f32,
    pub master_vu: f32,
    pub decks: Vec<DeckState>,
    pub sample_rate: u32,
    pub latency_ms: f32,
}

impl MixerState {
    pub fn initial(sample_rate: u32) -> Self {
        MixerState {
            crossfader: 0.0,
            crossfader_curve: CrossfaderCurve::Smooth,
            master_volume: 0.85,
            cue_volume: 0.7,
            master_vu: 0.0,
            decks: DeckId::ALL.iter().map(|&id| DeckState::empty(id)).collect(),
            sample_rate,
            latency_ms: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub is_default: bool,
}
