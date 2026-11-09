//! [`DecksMapping`] (controller mapping engine) and [`MidiClock`] (MIDI clock generator).
//!
//! The `decks-mapping` action vocabulary has ~90 variants; over FFI each action is one flat
//! [`MappedAction`] record (`group` / `kind` + the common runtime fields) with the full action as
//! JSON in `action_json`, which is also what every method taking an action accepts.

use std::sync::Mutex;

use decks_mapping::ble::BleMidiDecoder;
use decks_mapping::clock::ClockGenerator;
use decks_mapping::format::FeedbackKey;
use decks_mapping::{Action, DeviceInfo, FeedbackState, FeedbackValue, MappingEngine, MappingFile};

use crate::engine::EngineSnapshot;
use crate::{DecksError, lock};

fn mapping_err(e: impl std::fmt::Display) -> DecksError {
    DecksError::Mapping {
        reason: e.to_string(),
    }
}

// ---- records ----------------------------------------------------------------------------

/// One action produced by the mapping engine.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MappedAction {
    /// `deck`, `mixer`, `fx`, `library`, `sampler` or `clock`.
    pub group: String,
    /// snake_case action type, e.g. `play_pause`, `hot_cue`, `volume`, `jog_scratch`.
    pub kind: String,
    /// 0-based deck / mixer channel the action targets (after deck-layer rewriting).
    pub deck: Option<u8>,
    /// Absolute value (faders, knobs, velocity, clock BPM).
    pub value: Option<f32>,
    /// Relative amount (encoders, jog wheels).
    pub delta: Option<f32>,
    /// Momentary state (press / release).
    pub pressed: Option<bool>,
    /// Slot / index / note number when the action has one.
    pub slot: Option<u8>,
    /// The inner action object (`{"type":"hot_cue","deck":0,"slot":2,"pressed":true}`).
    pub params_json: String,
    /// The complete action (`{"deck":{...}}`), accepted back by `sync_value`, `start_learn`.
    pub action_json: String,
    pub timestamp_us: u64,
}

impl MappedAction {
    fn from_action(a: &Action, timestamp_us: u64) -> Self {
        let json = serde_json::to_value(a).unwrap_or_default();
        let (group, inner) = json
            .as_object()
            .and_then(|o| o.iter().next())
            .map(|(k, v)| (k.clone(), v.clone()))
            .unwrap_or_default();
        let kind = inner
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string();
        let slot = ["slot", "index", "note"].iter().find_map(|k| {
            inner
                .get(*k)
                .and_then(serde_json::Value::as_u64)
                .and_then(|v| u8::try_from(v).ok())
        });
        let mut m = a.clone();
        Self {
            group,
            kind,
            deck: m.deck_mut().copied(),
            value: m.value_mut().copied(),
            delta: m.delta_mut().copied(),
            pressed: m.pressed_mut().copied(),
            slot,
            params_json: inner.to_string(),
            // Serialised from the action itself (serde field order), not via `Value` (sorted keys).
            action_json: serde_json::to_string(a).unwrap_or_default(),
            timestamp_us,
        }
    }
}

/// Outgoing MIDI (LED, meter, clock).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MidiOutMessage {
    pub bytes: Vec<u8>,
    /// Exact due time for scheduled messages (clock ticks); `None` = send now.
    pub at_us: Option<f64>,
}

impl From<decks_mapping::MidiOut> for MidiOutMessage {
    fn from(m: decks_mapping::MidiOut) -> Self {
        Self {
            bytes: m.bytes,
            at_us: m.at_us,
        }
    }
}

/// State value for LED / meter feedback.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum FeedbackLevel {
    On {
        on: bool,
    },
    /// 0..1 (meters, jog ring).
    Level {
        value: f32,
    },
    /// Colour index, `None` = off.
    Colour {
        index: Option<u8>,
    },
}

/// One piece of engine state. `key_json` is a `decks_mapping::format::FeedbackKey`, e.g.
/// `{"type":"playing","deck":0}` or `{"type":"hot_cue_set","deck":1,"slot":3}`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FeedbackItem {
    pub key_json: String,
    pub value: FeedbackLevel,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MappingProfileInfo {
    pub id: String,
    pub name: String,
    pub vendor: Option<String>,
    pub description: Option<String>,
}

impl From<&MappingFile> for MappingProfileInfo {
    fn from(m: &MappingFile) -> Self {
        Self {
            id: m.id.clone(),
            name: m.name.clone(),
            vendor: m.vendor.clone(),
            description: m.description.clone(),
        }
    }
}

/// A control captured by MIDI learn.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LearnedControl {
    /// Suggested input id, e.g. `ch1.cc7`.
    pub id: String,
    /// 1-based MIDI channel.
    pub channel: Option<u8>,
    /// `decks_mapping::format::InputKind` as JSON.
    pub kind_json: String,
    pub samples: u32,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct BleMidiMessage {
    /// 13-bit BLE timestamp in ms (wraps at 8192).
    pub timestamp_ms: u16,
    /// The decoded MIDI message as raw bytes.
    pub bytes: Vec<u8>,
}

fn device(
    port_name: String,
    usb_vendor: Option<u16>,
    usb_product: Option<u16>,
    identity_reply: Option<Vec<u8>>,
) -> DeviceInfo {
    DeviceInfo {
        port_name,
        usb: usb_vendor.zip(usb_product),
        identity_reply,
    }
}

// ---- free functions ---------------------------------------------------------------------

/// Built-in controller profiles.
#[uniffi::export]
pub fn mapping_builtin_profiles() -> Vec<MappingProfileInfo> {
    decks_mapping::profiles::builtin()
        .iter()
        .map(Into::into)
        .collect()
}

/// JSON Schema (draft 2020-12) of mapping format v1, for editors.
#[uniffi::export]
pub fn mapping_json_schema() -> String {
    decks_mapping::json_schema_string()
}

// ---- mapping object ---------------------------------------------------------------------

struct MappingState {
    engine: MappingEngine,
    ble: BleMidiDecoder,
}

/// Mapping runtime for one connected controller. Feed raw MIDI from the host's MIDI thread
/// (`on_midi`), apply the returned actions to `DecksEngine`, and send `feedback` bytes back.
#[derive(uniffi::Object)]
pub struct DecksMapping {
    state: Mutex<MappingState>,
}

impl DecksMapping {
    fn build(file: MappingFile) -> Result<Self, DecksError> {
        let engine = MappingEngine::new(file).map_err(mapping_err)?;
        Ok(Self {
            state: Mutex::new(MappingState {
                engine,
                ble: BleMidiDecoder::new(),
            }),
        })
    }
}

fn parse_action(json: &str) -> Result<Action, DecksError> {
    serde_json::from_str(json).map_err(|e| DecksError::invalid(format!("action json: {e}")))
}

fn feedback_state(items: &[FeedbackItem]) -> Result<FeedbackState, DecksError> {
    let mut st = FeedbackState::default();
    for it in items {
        let key: FeedbackKey = serde_json::from_str(&it.key_json)
            .map_err(|e| DecksError::invalid(format!("feedback key json: {e}")))?;
        st.set(
            key,
            match it.value {
                FeedbackLevel::On { on } => FeedbackValue::On(on),
                FeedbackLevel::Level { value } => FeedbackValue::Level(value),
                FeedbackLevel::Colour { index } => FeedbackValue::Colour(index),
            },
        );
    }
    Ok(st)
}

fn snapshot_feedback(s: &EngineSnapshot) -> FeedbackState {
    let mut st = FeedbackState::default();
    for d in &s.decks {
        let deck = d.deck;
        st.set(FeedbackKey::Playing { deck }, FeedbackValue::On(d.playing));
        st.set(FeedbackKey::Loaded { deck }, FeedbackValue::On(d.loaded));
        st.set(
            FeedbackKey::LoopActive { deck },
            FeedbackValue::On(d.loop_active),
        );
        st.set(FeedbackKey::Sync { deck }, FeedbackValue::On(d.sync_lock));
        st.set(
            FeedbackKey::CueIndicator { deck },
            FeedbackValue::On(
                d.loaded && !d.playing && (d.playhead_sec - d.cue_point_sec).abs() < 0.02,
            ),
        );
        st.set(
            FeedbackKey::ChannelCue { channel: deck },
            FeedbackValue::On(d.pfl),
        );
        st.set(
            FeedbackKey::Vu { channel: deck },
            FeedbackValue::Level(d.vu),
        );
        let rev = if d.duration_sec > 0.0 {
            // 33⅓ rpm: one revolution = 1.8 s.
            (d.playhead_sec / 1.8).fract() as f32
        } else {
            0.0
        };
        st.set(FeedbackKey::JogPosition { deck }, FeedbackValue::Level(rev));
        for (slot, c) in d.hot_cues.iter().enumerate() {
            st.set(
                FeedbackKey::HotCueSet {
                    deck,
                    slot: slot as u8,
                },
                FeedbackValue::On(c.is_some()),
            );
        }
    }
    st
}

#[uniffi::export]
impl DecksMapping {
    /// Built-in profile by id (see `mapping_builtin_profiles`).
    #[uniffi::constructor]
    pub fn from_builtin(id: String) -> Result<Self, DecksError> {
        let file = decks_mapping::profiles::builtin()
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| DecksError::NotFound {
                reason: format!("mapping profile {id}"),
            })?;
        Self::build(file)
    }

    /// Mapping format v1 JSON (validated, script compiled).
    #[uniffi::constructor]
    pub fn from_json(json: String) -> Result<Self, DecksError> {
        Self::build(MappingFile::from_json(&json).map_err(mapping_err)?)
    }

    /// Best built-in profile for a connected device (falls back to the generic 2-deck one).
    #[uniffi::constructor]
    pub fn detect(
        port_name: String,
        usb_vendor: Option<u16>,
        usb_product: Option<u16>,
        identity_reply: Option<Vec<u8>>,
    ) -> Result<Self, DecksError> {
        let dev = device(port_name, usb_vendor, usb_product, identity_reply);
        Self::build(decks_mapping::profiles::detect(&dev))
    }

    pub fn profile(&self) -> MappingProfileInfo {
        lock(&self.state).engine.mapping().into()
    }

    /// The live mapping (including learned bindings) as JSON.
    pub fn to_json(&self) -> String {
        lock(&self.state).engine.mapping().to_json_pretty()
    }

    /// Raw MIDI bytes (one or more, possibly partial, messages) → actions.
    pub fn on_midi(&self, port: String, bytes: Vec<u8>, timestamp_us: u64) -> Vec<MappedAction> {
        lock(&self.state)
            .engine
            .on_midi_events(&port, &bytes, timestamp_us)
            .iter()
            .map(|e| MappedAction::from_action(&e.action, e.timestamp_us))
            .collect()
    }

    /// One BLE-MIDI characteristic value → actions (decoder keeps running status / SysEx).
    pub fn on_ble_midi(
        &self,
        port: String,
        packet: Vec<u8>,
        timestamp_us: u64,
    ) -> Result<Vec<MappedAction>, DecksError> {
        let mut s = lock(&self.state);
        let events = s.ble.decode(&packet).map_err(mapping_err)?;
        let mut out = Vec::new();
        for ev in events {
            for a in s.engine.on_message(&port, &ev.message, timestamp_us) {
                out.push(MappedAction::from_action(&a, timestamp_us));
            }
        }
        Ok(out)
    }

    /// Decode one BLE-MIDI packet to plain MIDI messages (no mapping).
    pub fn ble_decode(&self, packet: Vec<u8>) -> Result<Vec<BleMidiMessage>, DecksError> {
        let events = lock(&self.state).ble.decode(&packet).map_err(mapping_err)?;
        Ok(events
            .into_iter()
            .map(|e| BleMidiMessage {
                timestamp_ms: e.timestamp_ms,
                bytes: e.message.to_bytes(),
            })
            .collect())
    }

    /// LED / meter messages for changed state (`items` = current engine state).
    pub fn feedback(&self, items: Vec<FeedbackItem>) -> Result<Vec<MidiOutMessage>, DecksError> {
        let st = feedback_state(&items)?;
        Ok(lock(&self.state)
            .engine
            .feedback(&st)
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Like `feedback`, but every output is sent (after connecting a device).
    pub fn feedback_all(
        &self,
        items: Vec<FeedbackItem>,
    ) -> Result<Vec<MidiOutMessage>, DecksError> {
        let st = feedback_state(&items)?;
        Ok(lock(&self.state)
            .engine
            .feedback_all(&st)
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Feedback straight from an `EngineSnapshot` (playing, loaded, loop, sync, cue, PFL, VU,
    /// jog ring, hot cues).
    pub fn feedback_from_snapshot(&self, snapshot: EngineSnapshot) -> Vec<MidiOutMessage> {
        let st = snapshot_feedback(&snapshot);
        lock(&self.state)
            .engine
            .feedback(&st)
            .into_iter()
            .map(Into::into)
            .collect()
    }

    /// Tell soft takeover the engine's current value of an absolute control.
    pub fn sync_value(&self, action_json: String) -> Result<(), DecksError> {
        let a = parse_action(&action_json)?;
        lock(&self.state).engine.sync_value(&a);
        Ok(())
    }

    /// Virtual modifier (shift) set by the host.
    pub fn set_modifier(&self, id: String, on: bool) {
        lock(&self.state).engine.set_modifier(&id, on);
    }

    /// Point a physical side (0 / 1) at a virtual deck (0..3).
    pub fn set_side_deck(&self, side: u8, deck: u8) {
        lock(&self.state).engine.set_side_deck(side, deck);
    }

    /// Beat position for the groove lane (master clock beat).
    pub fn set_beat_position(&self, beats: f64) {
        lock(&self.state).engine.set_beat_position(beats);
    }

    /// Due MIDI clock messages (mappings with `clock.send`).
    pub fn clock_out(&self, now_us: f64) -> Vec<MidiOutMessage> {
        lock(&self.state)
            .engine
            .clock_out(now_us)
            .into_iter()
            .map(Into::into)
            .collect()
    }

    /// Tempo of incoming MIDI clock (follow mode), if locked.
    pub fn followed_bpm(&self) -> Option<f64> {
        lock(&self.state).engine.clock_follower().bpm()
    }

    /// Script errors since the last call.
    pub fn take_script_errors(&self) -> Vec<String> {
        lock(&self.state)
            .engine
            .take_script_errors()
            .into_iter()
            .map(|e| e.to_string())
            .collect()
    }

    // ---- MIDI learn ---------------------------------------------------------------------

    /// Capture the next control; `target_action_json` = action to bind it to (`None` = only
    /// identify the control). While learning `on_midi` returns no actions.
    pub fn start_learn(&self, target_action_json: Option<String>) -> Result<(), DecksError> {
        let target = target_action_json
            .as_deref()
            .map(parse_action)
            .transpose()?;
        lock(&self.state).engine.start_learn(target);
        Ok(())
    }

    pub fn cancel_learn(&self) {
        lock(&self.state).engine.cancel_learn();
    }

    pub fn is_learning(&self) -> bool {
        lock(&self.state).engine.is_learning()
    }

    /// Call periodically while learning; returns the control once the gesture went quiet.
    pub fn poll_learn(&self, now_us: u64) -> Option<LearnedControl> {
        lock(&self.state)
            .engine
            .poll_learn(now_us)
            .map(|p| LearnedControl {
                id: p.id,
                channel: p.channel,
                kind_json: serde_json::to_string(&p.kind).unwrap_or_default(),
                samples: u32::try_from(p.samples).unwrap_or(u32::MAX),
            })
    }

    /// Add the last learned control + its target action to the live mapping. Returns `false`
    /// when nothing was learned with a target.
    pub fn accept_learned(&self) -> Result<bool, DecksError> {
        let mut s = lock(&self.state);
        let Some((input, binding)) = s.engine.learned_binding() else {
            return Ok(false);
        };
        s.engine.add_binding(input, binding).map_err(mapping_err)?;
        Ok(true)
    }
}

// ---- MIDI clock ---------------------------------------------------------------------------

/// MIDI clock master (24 PPQN), timestamp driven: call `tick(now_us)` from a timer and send the
/// returned messages at their `at_us`.
#[derive(uniffi::Object)]
pub struct MidiClock {
    clock: Mutex<ClockGenerator>,
}

#[uniffi::export]
impl MidiClock {
    #[uniffi::constructor]
    pub fn new(bpm: f64) -> Self {
        Self {
            clock: Mutex::new(ClockGenerator::new(bpm)),
        }
    }

    pub fn set_bpm(&self, bpm: f64) {
        lock(&self.clock).set_bpm(bpm);
    }

    pub fn bpm(&self) -> f64 {
        lock(&self.clock).bpm()
    }

    pub fn is_running(&self) -> bool {
        lock(&self.clock).is_running()
    }

    /// Start from the top; `phase` (0..1 of a beat) aligns the first tick with the beatgrid.
    pub fn start(&self, now_us: f64, phase: f64) {
        lock(&self.clock).start(now_us, phase);
    }

    pub fn stop(&self, now_us: f64) {
        lock(&self.clock).stop(now_us);
    }

    pub fn resume(&self, now_us: f64) {
        lock(&self.clock).resume(now_us);
    }

    pub fn set_song_position(&self, now_us: f64, sixteenths: u16) {
        lock(&self.clock).set_song_position(now_us, sixteenths);
    }

    /// Every message due at or before `now_us`, with exact timestamps.
    pub fn tick(&self, now_us: f64) -> Vec<MidiOutMessage> {
        lock(&self.clock)
            .poll(now_us)
            .into_iter()
            .map(|e| MidiOutMessage {
                bytes: e.message.to_bytes(),
                at_us: Some(e.at_us),
            })
            .collect()
    }

    /// Next due time (schedule the timer for it), if running.
    pub fn next_due_us(&self) -> Option<f64> {
        lock(&self.clock).next_due_us()
    }
}
