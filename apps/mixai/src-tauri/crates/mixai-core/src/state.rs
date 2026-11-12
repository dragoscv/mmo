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

    // Inherent helper returning Option (used across the app); not the FromStr trait.
    #[allow(clippy::should_implement_trait)]
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

impl CrossfaderAssign {
    /// Wire name (`"a"` / `"thru"` / `"b"`, as serialised) → value; `None` for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "a" => Some(Self::A),
            "thru" => Some(Self::Thru),
            "b" => Some(Self::B),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrossfaderCurve {
    Linear,
    Smooth,
    Sharp,
}

impl CrossfaderCurve {
    /// Wire name (`"linear"` / `"smooth"` / `"sharp"`, as serialised) → value; `None` for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "linear" => Some(Self::Linear),
            "smooth" => Some(Self::Smooth),
            "sharp" => Some(Self::Sharp),
            _ => None,
        }
    }

    /// Gain-law index understood by `dsp::crossfader_gain`.
    pub fn law(self) -> u8 {
        match self {
            Self::Linear => 0,
            Self::Smooth => 1,
            Self::Sharp => 2,
        }
    }
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
    /// Channel trim in dB (pre-EQ, separate from `volume`); −96 = −∞ (silence), max +12.
    #[serde(default)]
    pub trim_db: f32,
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
    /// Slip shadow playhead in seconds while slip is engaged (loop / reverse running).
    #[serde(default)]
    pub slip_shadow: Option<f64>,
    /// Beatgrid anchor: time of the first detected beat, in seconds.
    pub first_beat: f64,
    /// True when separated stems are loaded for this deck.
    pub has_stems: bool,
    /// True when stem playback is active (overrides the full mix).
    pub stems_active: bool,
    /// Per-stem gains [vocals, drums, bass, melody], 0..1.5.
    pub stem_gains: Vec<f32>,
    /// Per-stem crossfader [vocals, drums, bass, melody], −1 (side A) .. +1 (side B); 0 = the
    /// stem follows the deck. Moving it to the side the deck is NOT on fades that stem out.
    #[serde(default = "default_stem_xf")]
    pub stem_xf: Vec<f32>,
    /// Stem mute FX: muting a stem leaves an echo tail of it instead of a hard cut.
    #[serde(default)]
    pub stem_mute_fx: bool,
    /// Echo time of the stem mute FX in beats.
    #[serde(default = "default_stem_mute_fx_beats")]
    pub stem_mute_fx_beats: f64,
    /// Loop length in beats stored on each hot cue (None = a plain cue), 8 slots. Jumping to a
    /// cue that carries a loop starts that loop at the cue.
    #[serde(default = "default_hot_cue_loops")]
    pub hot_cue_loops: Vec<Option<f64>>,
    /// Level each stem had when it was last muted with the mute command (what an unmute brings
    /// back). Bookkeeping of the UI mirror, not part of the wire form: see
    /// [`DeckState::mirror_stem_mute`].
    #[serde(skip, default = "default_stem_pre_mute")]
    pub stem_pre_mute: [f32; 4],
    /// Active FX (0=off, 1=echo, 2=reverb).
    pub fx_kind: u8,
    /// FX wet/dry mix, 0..1.
    pub fx_wet: f32,
    /// FX beat division (echo time), e.g. 0.25/0.5/1/2.
    pub fx_beats: f64,
}

/// Default echo time of the stem mute FX in beats.
pub const STEM_MUTE_FX_BEATS: f64 = 0.5;

fn default_stem_xf() -> Vec<f32> {
    vec![0.0; 4]
}

fn default_stem_mute_fx_beats() -> f64 {
    STEM_MUTE_FX_BEATS
}

fn default_hot_cue_loops() -> Vec<Option<f64>> {
    vec![None; 8]
}

fn default_stem_pre_mute() -> [f32; 4] {
    [1.0; 4]
}

/// What the stem mute command does to one stem's level. `gain` = its level now, `remembered` =
/// the level kept from its last mute. Returns `(level, remembered)` after the command, or
/// `None` when the stem is already in that state (a muted stem muted again, an audible one
/// unmuted).
///
/// A mute keeps the level the stem had and an unmute brings it back (unity when nothing usable
/// was kept). Level moves in between do not touch the kept level, so the audio thread
/// ([`crate::deck::Deck::set_stem_mute`]) and the UI mirror ([`DeckState::mirror_stem_mute`])
/// reach the same level from the mute commands alone.
pub fn stem_mute_step(gain: f32, remembered: f32, on: bool) -> Option<(f32, f32)> {
    let muted = gain <= crate::deck::STEM_SILENT;
    if on == muted {
        return None;
    }
    if on {
        Some((0.0, if gain.is_finite() { gain } else { 1.0 }))
    } else if remembered.is_finite() && remembered > crate::deck::STEM_SILENT {
        Some((remembered, 1.0))
    } else {
        Some((1.0, 1.0))
    }
}

impl DeckState {
    /// The UI mirror's side of [`crate::deck::Deck::set_stem_mute`]: mute (`on`) or unmute stem
    /// `idx` in `stem_gains`, an unmute returning to the level the stem had before the mute.
    /// Returns the stem's level afterwards, `None` when nothing changed (already in that
    /// state, or `idx` out of range).
    pub fn mirror_stem_mute(&mut self, idx: usize, on: bool) -> Option<f32> {
        if idx >= self.stem_pre_mute.len() {
            return None;
        }
        if self.stem_gains.len() < self.stem_pre_mute.len() {
            self.stem_gains.resize(self.stem_pre_mute.len(), 1.0);
        }
        let (gain, keep) = stem_mute_step(self.stem_gains[idx], self.stem_pre_mute[idx], on)?;
        self.stem_gains[idx] = gain;
        self.stem_pre_mute[idx] = keep;
        Some(gain)
    }

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
            trim_db: 0.0,
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
            slip_shadow: None,
            first_beat: 0.0,
            has_stems: false,
            stems_active: false,
            stem_gains: vec![1.0; 4],
            stem_xf: default_stem_xf(),
            stem_mute_fx: false,
            stem_mute_fx_beats: STEM_MUTE_FX_BEATS,
            hot_cue_loops: default_hot_cue_loops(),
            stem_pre_mute: default_stem_pre_mute(),
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
    /// Output channels of the open stream.
    #[serde(default)]
    pub channels: u16,
    /// Frames per audio callback (fixed or observed; `None` until known).
    #[serde(default)]
    pub buffer_frames: Option<u32>,
    /// Audio callback time / buffer period (0..4; 1.0 = the callback used the whole period).
    #[serde(default)]
    pub dsp_load: f32,
    /// Audio callbacks that overran their buffer period since the engine started (the count
    /// carries over an output device switch).
    #[serde(default)]
    pub overruns: u32,
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
            channels: 0,
            buffer_frames: None,
            dsp_load: 0.0,
            overruns: 0,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stem_mute_step_keeps_the_level_and_brings_it_back() {
        // Mute: the level goes to 0 and is kept.
        assert_eq!(stem_mute_step(0.6, 1.0, true), Some((0.0, 0.6)));
        assert_eq!(stem_mute_step(1.5, 0.3, true), Some((0.0, 1.5)));
        // Unmute: the kept level comes back and the memory is cleared.
        assert_eq!(stem_mute_step(0.0, 0.6, false), Some((0.6, 1.0)));
        // Nothing usable kept (silence, junk): unity.
        for kept in [0.0, 0.001, -1.0, f32::NAN, f32::INFINITY] {
            assert_eq!(stem_mute_step(0.0, kept, false), Some((1.0, 1.0)), "{kept}");
        }
        // Already in that state: nothing to do.
        assert_eq!(stem_mute_step(0.0, 0.6, true), None);
        assert_eq!(stem_mute_step(0.001, 0.6, true), None);
        assert_eq!(stem_mute_step(0.4, 0.6, false), None);
        // A junk level never becomes the kept level.
        assert_eq!(stem_mute_step(f32::NAN, 0.6, true), Some((0.0, 1.0)));
    }

    #[test]
    fn mirror_stem_mute_fills_a_short_gain_list() {
        let mut d = DeckState::empty(DeckId::A);
        d.stem_gains = vec![0.5];
        assert_eq!(d.mirror_stem_mute(2, true), Some(0.0));
        assert_eq!(d.stem_gains, vec![0.5, 1.0, 0.0, 1.0]);
        assert_eq!(d.mirror_stem_mute(0, true), Some(0.0));
        assert_eq!(d.mirror_stem_mute(0, false), Some(0.5));
        assert_eq!(d.mirror_stem_mute(0, false), None);
        assert_eq!(d.mirror_stem_mute(9, true), None);
        assert_eq!(d.stem_gains, vec![0.5, 1.0, 0.0, 1.0]);
    }
}
