//! The fixed action vocabulary a mapping can bind to.
//!
//! JSON shape: externally tagged by group, internally tagged by `type`, snake_case:
//! `{"deck": {"type": "hot_cue", "deck": 0, "slot": 0}}`. Runtime-filled fields (`value`,
//! `delta`, `pressed`, `velocity`, `note`) default to zero / false in mapping files; the engine
//! fills them from the incoming control. Decks, mixer channels, FX units and sampler slots are
//! **0-based**.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// One semantic action produced by the mapping engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Deck(DeckAction),
    Mixer(MixerAction),
    Fx(FxAction),
    Library(LibraryAction),
    Sampler(SamplerAction),
    Clock(ClockAction),
}

/// Performance-pad modes (names cover both rekordbox and Serato layouts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PadMode {
    HotCue,
    PadFx1,
    PadFx2,
    BeatJump,
    BeatLoop,
    Sampler,
    Keyboard,
    KeyShift,
    PitchPlay,
    Roll,
    AutoLoop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EqBand {
    Low,
    Mid,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SortColumn {
    Bpm,
    Artist,
    Title,
    Key,
}

/// Clock role of the engine relative to external gear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClockMode {
    /// Engine tempo is internal; no clock is sent.
    Internal,
    /// Engine sends MIDI clock (master).
    Master,
    /// Engine follows incoming MIDI clock (slave).
    Follow,
}

/// Per-deck transport, loop, cue, jog and pad actions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeckAction {
    PlayPause {
        deck: u8,
    },
    Cue {
        deck: u8,
        #[serde(default)]
        pressed: bool,
    },
    /// Return to the start of the track.
    CueGotoStart {
        deck: u8,
    },
    /// Jump to the temporary cue and play (Serato SHIFT+PLAY).
    Stutter {
        deck: u8,
    },
    /// Toggle beat sync.
    Sync {
        deck: u8,
    },
    SyncOff {
        deck: u8,
    },
    SetTempoMaster {
        deck: u8,
    },
    TempoRangeCycle {
        deck: u8,
    },
    /// Pitch fader, -1.0 (min) ..= 1.0 (max) after the binding's value range.
    Tempo {
        deck: u8,
        #[serde(default)]
        value: f32,
    },
    KeyLock {
        deck: u8,
    },
    KeyShift {
        deck: u8,
        semitones: i8,
    },
    JogTouch {
        deck: u8,
        #[serde(default)]
        pressed: bool,
    },
    /// Platter rotation while touched (vinyl mode): scratch by `delta` encoder ticks.
    JogScratch {
        deck: u8,
        #[serde(default)]
        delta: f32,
    },
    /// Wheel side / untouched rotation: temporary pitch bend.
    JogBend {
        deck: u8,
        #[serde(default)]
        delta: f32,
    },
    /// SHIFT + rotation: fast search / skip.
    JogSearch {
        deck: u8,
        #[serde(default)]
        delta: f32,
    },
    VinylMode {
        deck: u8,
    },
    LoopIn {
        deck: u8,
        #[serde(default)]
        pressed: bool,
    },
    LoopOut {
        deck: u8,
        #[serde(default)]
        pressed: bool,
    },
    AutoLoop {
        deck: u8,
        beats: f32,
    },
    LoopExit {
        deck: u8,
    },
    LoopRoll {
        deck: u8,
        beats: f32,
        #[serde(default)]
        pressed: bool,
    },
    LoopHalve {
        deck: u8,
    },
    LoopDouble {
        deck: u8,
    },
    LoopActiveToggle {
        deck: u8,
    },
    HotCue {
        deck: u8,
        slot: u8,
        #[serde(default)]
        pressed: bool,
    },
    HotCueDelete {
        deck: u8,
        slot: u8,
    },
    /// Call the previous (-1) / next (+1) memory cue or loop.
    CueCall {
        deck: u8,
        direction: i8,
    },
    CueMemoryDelete {
        deck: u8,
    },
    CueMemorySave {
        deck: u8,
    },
    BeatJump {
        deck: u8,
        beats: f32,
    },
    /// Jump by the deck's current beat-jump size, backwards (-1) / forwards (+1).
    BeatJumpBySize {
        deck: u8,
        direction: i8,
    },
    /// Halve (-1) / double (+1) the beat-jump size.
    BeatJumpSize {
        deck: u8,
        direction: i8,
    },
    PadMode {
        deck: u8,
        mode: PadMode,
    },
    PitchPlay {
        deck: u8,
        semitones: i8,
        #[serde(default)]
        pressed: bool,
    },
    Censor {
        deck: u8,
        #[serde(default)]
        pressed: bool,
    },
    Reverse {
        deck: u8,
    },
    /// Rewind (-1) / fast-forward (+1) while held.
    Seek {
        deck: u8,
        direction: i8,
        #[serde(default)]
        pressed: bool,
    },
    LoadPrevious {
        deck: u8,
    },
}

/// Mixer section actions. `channel` is the 0-based mixer channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MixerAction {
    Volume {
        channel: u8,
        #[serde(default)]
        value: f32,
    },
    Trim {
        channel: u8,
        #[serde(default)]
        value: f32,
    },
    Eq {
        channel: u8,
        band: EqBand,
        #[serde(default)]
        value: f32,
    },
    /// Per-channel colour FX / filter, 0.5 = off.
    Filter {
        channel: u8,
        #[serde(default)]
        value: f32,
    },
    Crossfader {
        #[serde(default)]
        value: f32,
    },
    MasterVolume {
        #[serde(default)]
        value: f32,
    },
    /// Master filter, 0.5 = off (Circuit Tracks project CC74).
    MasterFilter {
        #[serde(default)]
        value: f32,
    },
    MasterFilterResonance {
        #[serde(default)]
        value: f32,
    },
    /// Send level of a channel into a bus (0 = reverb, 1 = delay).
    Send {
        channel: u8,
        bus: u8,
        #[serde(default)]
        value: f32,
    },
    HeadphoneCue {
        channel: u8,
    },
    MasterCue,
    HeadphoneMix {
        #[serde(default)]
        value: f32,
    },
    HeadphoneLevel {
        #[serde(default)]
        value: f32,
    },
    MicLevel {
        #[serde(default)]
        value: f32,
    },
    SmartFader,
    SmartCfx,
    /// Channel-fader start: `start` = fader left the bottom (true) or returned (false).
    FaderStart {
        channel: u8,
        start: bool,
    },
    /// Crossfader start for `channel` (0 = left side deck, 1 = right side deck).
    CrossfaderStart {
        channel: u8,
        start: bool,
    },
}

/// Effect actions. `unit` is the 0-based FX unit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FxAction {
    Toggle {
        unit: u8,
    },
    Select {
        unit: u8,
        direction: i8,
    },
    /// Beat multiplier down (-1) / up (+1).
    Beats {
        unit: u8,
        direction: i8,
    },
    Level {
        unit: u8,
        #[serde(default)]
        value: f32,
    },
    Param {
        unit: u8,
        index: u8,
        #[serde(default)]
        value: f32,
    },
    /// Route `unit` to mixer `channel` (`on` follows the switch position).
    Assign {
        unit: u8,
        channel: u8,
        #[serde(default)]
        on: bool,
    },
    /// Momentary pad FX `slot` on `page` for `deck`.
    PadFx {
        deck: u8,
        page: u8,
        slot: u8,
        #[serde(default)]
        pressed: bool,
    },
    TapTempo {
        unit: u8,
    },
    TapReset {
        unit: u8,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LibraryAction {
    Scroll {
        #[serde(default)]
        delta: f32,
    },
    ScrollFast {
        #[serde(default)]
        delta: f32,
    },
    FocusNext,
    FocusPrevious,
    Load {
        deck: u8,
    },
    Sort {
        column: SortColumn,
    },
    ZoomWaveform {
        #[serde(default)]
        delta: f32,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SamplerAction {
    Trigger {
        slot: u8,
        #[serde(default)]
        velocity: f32,
        #[serde(default)]
        pressed: bool,
    },
    Stop {
        slot: u8,
    },
    /// Load the selected library track into `slot` (SHIFT + pad).
    Load {
        slot: u8,
    },
    /// Play `note` on a pitched instrument (scale lock is applied by the engine first).
    Note {
        instrument: u8,
        #[serde(default)]
        note: u8,
        #[serde(default)]
        velocity: f32,
        #[serde(default)]
        pressed: bool,
    },
    Volume {
        #[serde(default)]
        value: f32,
    },
    Bank {
        direction: i8,
    },
    /// Select a groove pattern / project (Circuit Tracks programme change on channel 16).
    SelectPattern {
        #[serde(default)]
        index: u8,
        #[serde(default)]
        queued: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClockAction {
    Start,
    Stop,
    Continue,
    /// Song Position Pointer (16th notes).
    SongPosition {
        #[serde(default)]
        sixteenths: u16,
    },
    /// Tempo estimate from the clock follower changed.
    Tempo {
        #[serde(default)]
        bpm: f32,
    },
    SetMode {
        mode: ClockMode,
    },
    Tap,
    Nudge {
        direction: i8,
    },
}

impl Action {
    /// Deck index (or mixer channel / deck-scoped field) that a deck-switching layer rewrites.
    pub fn deck_mut(&mut self) -> Option<&mut u8> {
        use DeckAction as D;
        match self {
            Action::Deck(d) => Some(match d {
                D::PlayPause { deck }
                | D::Cue { deck, .. }
                | D::CueGotoStart { deck }
                | D::Stutter { deck }
                | D::Sync { deck }
                | D::SyncOff { deck }
                | D::SetTempoMaster { deck }
                | D::TempoRangeCycle { deck }
                | D::Tempo { deck, .. }
                | D::KeyLock { deck }
                | D::KeyShift { deck, .. }
                | D::JogTouch { deck, .. }
                | D::JogScratch { deck, .. }
                | D::JogBend { deck, .. }
                | D::JogSearch { deck, .. }
                | D::VinylMode { deck }
                | D::LoopIn { deck, .. }
                | D::LoopOut { deck, .. }
                | D::AutoLoop { deck, .. }
                | D::LoopExit { deck }
                | D::LoopRoll { deck, .. }
                | D::LoopHalve { deck }
                | D::LoopDouble { deck }
                | D::LoopActiveToggle { deck }
                | D::HotCue { deck, .. }
                | D::HotCueDelete { deck, .. }
                | D::CueCall { deck, .. }
                | D::CueMemoryDelete { deck }
                | D::CueMemorySave { deck }
                | D::BeatJump { deck, .. }
                | D::BeatJumpBySize { deck, .. }
                | D::BeatJumpSize { deck, .. }
                | D::PadMode { deck, .. }
                | D::PitchPlay { deck, .. }
                | D::Censor { deck, .. }
                | D::Reverse { deck }
                | D::Seek { deck, .. }
                | D::LoadPrevious { deck } => deck,
            }),
            Action::Mixer(
                MixerAction::Volume { channel, .. }
                | MixerAction::Trim { channel, .. }
                | MixerAction::Eq { channel, .. }
                | MixerAction::Filter { channel, .. }
                | MixerAction::Send { channel, .. }
                | MixerAction::HeadphoneCue { channel }
                | MixerAction::FaderStart { channel, .. }
                | MixerAction::CrossfaderStart { channel, .. },
            ) => Some(channel),
            Action::Fx(FxAction::PadFx { deck, .. }) => Some(deck),
            Action::Library(LibraryAction::Load { deck }) => Some(deck),
            _ => None,
        }
    }

    /// Absolute continuous value (faders, knobs).
    pub fn value_mut(&mut self) -> Option<&mut f32> {
        match self {
            Action::Deck(DeckAction::Tempo { value, .. }) => Some(value),
            Action::Mixer(
                MixerAction::Volume { value, .. }
                | MixerAction::Trim { value, .. }
                | MixerAction::Eq { value, .. }
                | MixerAction::Filter { value, .. }
                | MixerAction::Crossfader { value }
                | MixerAction::MasterVolume { value }
                | MixerAction::MasterFilter { value }
                | MixerAction::MasterFilterResonance { value }
                | MixerAction::Send { value, .. }
                | MixerAction::HeadphoneMix { value }
                | MixerAction::HeadphoneLevel { value }
                | MixerAction::MicLevel { value },
            ) => Some(value),
            Action::Fx(FxAction::Level { value, .. } | FxAction::Param { value, .. }) => {
                Some(value)
            }
            Action::Sampler(SamplerAction::Volume { value }) => Some(value),
            Action::Sampler(
                SamplerAction::Trigger { velocity, .. } | SamplerAction::Note { velocity, .. },
            ) => Some(velocity),
            Action::Clock(ClockAction::Tempo { bpm }) => Some(bpm),
            _ => None,
        }
    }

    /// Relative amount (encoders, jog wheels).
    pub fn delta_mut(&mut self) -> Option<&mut f32> {
        match self {
            Action::Deck(
                DeckAction::JogScratch { delta, .. }
                | DeckAction::JogBend { delta, .. }
                | DeckAction::JogSearch { delta, .. },
            ) => Some(delta),
            Action::Library(
                LibraryAction::Scroll { delta }
                | LibraryAction::ScrollFast { delta }
                | LibraryAction::ZoomWaveform { delta },
            ) => Some(delta),
            _ => None,
        }
    }

    /// Momentary state (true on press, false on release).
    pub fn pressed_mut(&mut self) -> Option<&mut bool> {
        use DeckAction as D;
        match self {
            Action::Deck(
                D::Cue { pressed, .. }
                | D::JogTouch { pressed, .. }
                | D::LoopIn { pressed, .. }
                | D::LoopOut { pressed, .. }
                | D::LoopRoll { pressed, .. }
                | D::HotCue { pressed, .. }
                | D::PitchPlay { pressed, .. }
                | D::Censor { pressed, .. }
                | D::Seek { pressed, .. },
            ) => Some(pressed),
            Action::Fx(FxAction::PadFx { pressed, .. } | FxAction::Assign { on: pressed, .. }) => {
                Some(pressed)
            }
            Action::Sampler(
                SamplerAction::Trigger { pressed, .. } | SamplerAction::Note { pressed, .. },
            ) => Some(pressed),
            _ => None,
        }
    }

    /// Note number for pitched actions (filled from note-range inputs).
    pub fn note_mut(&mut self) -> Option<&mut u8> {
        match self {
            Action::Sampler(SamplerAction::Note { note, .. }) => Some(note),
            _ => None,
        }
    }

    /// Small integer index filled from programme-change inputs.
    pub fn index_mut(&mut self) -> Option<&mut u8> {
        match self {
            Action::Sampler(SamplerAction::SelectPattern { index, .. }) => Some(index),
            _ => None,
        }
    }

    /// True if the action carries a press/release state.
    pub fn is_momentary(&self) -> bool {
        self.clone().pressed_mut().is_some()
    }

    /// Stable identity of the control target, ignoring runtime-filled fields. Used as the
    /// soft-takeover key.
    pub fn target_key(&self) -> String {
        let mut a = self.clone();
        if let Some(v) = a.value_mut() {
            *v = 0.0;
        }
        if let Some(v) = a.delta_mut() {
            *v = 0.0;
        }
        if let Some(p) = a.pressed_mut() {
            *p = false;
        }
        if let Some(n) = a.note_mut() {
            *n = 0;
        }
        serde_json::to_string(&a).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shape_is_group_then_type() {
        let a = Action::Deck(DeckAction::HotCue {
            deck: 1,
            slot: 2,
            pressed: true,
        });
        let s = serde_json::to_string(&a).unwrap();
        assert_eq!(
            s,
            r#"{"deck":{"type":"hot_cue","deck":1,"slot":2,"pressed":true}}"#
        );
        let back: Action =
            serde_json::from_str(r#"{"deck":{"type":"hot_cue","deck":1,"slot":2}}"#).unwrap();
        assert_eq!(
            back,
            Action::Deck(DeckAction::HotCue {
                deck: 1,
                slot: 2,
                pressed: false
            })
        );
    }

    #[test]
    fn target_key_ignores_runtime_fields() {
        let a = Action::Mixer(MixerAction::Volume {
            channel: 0,
            value: 0.3,
        });
        let b = Action::Mixer(MixerAction::Volume {
            channel: 0,
            value: 0.9,
        });
        assert_eq!(a.target_key(), b.target_key());
    }
}
