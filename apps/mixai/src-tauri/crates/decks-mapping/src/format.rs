//! Mapping format v1 (JSON). See `docs/decks/mapping-format.md` for the prose spec; the JSON
//! Schema is generated from these types ([`crate::json_schema_string`]).
//!
//! Conventions: MIDI channels are **1-based** (1..=16) like manufacturers' tables; `null` /
//! absent channel = omni. Decks, mixer channels, FX units and sampler slots are 0-based.

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::action::{Action, PadMode};
use crate::scale::ScaleMode;
use crate::value::{RelativeEncoding, ValueTransform};

/// Current mapping format version.
pub const FORMAT_VERSION: u32 = 1;

fn is_false(b: &bool) -> bool {
    !*b
}
fn default_true() -> bool {
    true
}
fn default_version() -> u32 {
    FORMAT_VERSION
}

/// A complete controller mapping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MappingFile {
    /// Format version; must be 1.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Stable identifier, e.g. `pioneer-ddj-flx4-rekordbox`.
    pub id: String,
    /// Human-readable name.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// URLs of the manufacturer documents the mapping was derived from.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// How to recognise the device.
    #[serde(default)]
    pub device: DeviceMatch,
    /// Physical controls (MIDI in).
    #[serde(default)]
    pub inputs: Vec<InputDef>,
    /// Modifier (shift) layers.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<ModifierDef>,
    /// Deck-switching layers (a physical side controls one of several virtual decks).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deck_layers: Vec<DeckLayerDef>,
    /// Input → action bindings.
    #[serde(default)]
    pub bindings: Vec<Binding>,
    /// LED / meter feedback (MIDI out).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<OutputDef>,
    /// MIDI clock behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock: Option<ClockConfig>,
    /// Groove-lane recording of incoming notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groove: Option<GrooveConfig>,
    /// Optional sandboxed rhai script.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<ScriptDef>,
}

/// Device recognition rules. Every present rule that matches adds to the score.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DeviceMatch {
    /// Regex matched against the OS port name (case-sensitive unless `(?i)` is used).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_regex: Option<String>,
    /// USB vendor / product ids (product `null` = any product of the vendor).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub usb: Vec<UsbId>,
    /// Match on the MIDI Universal Identity Reply (`F0 7E dd 06 02 ...`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sysex_identity: Option<IdentityMatch>,
    /// Tie-breaker between profiles matching the same device (higher wins).
    #[serde(default)]
    pub priority: i32,
    /// Match any device (fallback profiles). Scores lowest.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fallback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct UsbId {
    pub vendor_id: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<u16>,
}

/// Universal Identity Reply match: manufacturer id (1 or 3 bytes), optional family / member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct IdentityMatch {
    pub manufacturer: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<u16>,
}

/// Parsed Universal Identity Reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityReply {
    pub device_id: u8,
    pub manufacturer: Vec<u8>,
    pub family: u16,
    pub member: u16,
    pub version: [u8; 4],
}

/// The Universal Identity Request (broadcast) to send on connect.
pub const IDENTITY_REQUEST: [u8; 6] = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];

impl IdentityReply {
    /// Parse `F0 7E <dev> 06 02 <mfr(1|3)> <fam lsb msb> <member lsb msb> <ver x4> F7`.
    pub fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < 15 || b[0] != 0xF0 || b[1] != 0x7E || b[3] != 0x06 || b[4] != 0x02 {
            return None;
        }
        let (manufacturer, rest) = if b[5] == 0x00 {
            (b[5..8].to_vec(), &b[8..])
        } else {
            (vec![b[5]], &b[6..])
        };
        if rest.len() < 9 || rest[8] != 0xF7 {
            return None;
        }
        Some(Self {
            device_id: b[2],
            manufacturer,
            family: u16::from(rest[0]) | (u16::from(rest[1]) << 7),
            member: u16::from(rest[2]) | (u16::from(rest[3]) << 7),
            version: [rest[4], rest[5], rest[6], rest[7]],
        })
    }
}

/// What the host knows about a connected device.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceInfo {
    pub port_name: String,
    pub usb: Option<(u16, u16)>,
    /// Raw identity reply, if the device answered [`IDENTITY_REQUEST`].
    pub identity_reply: Option<Vec<u8>>,
}

impl DeviceMatch {
    /// Score how well `dev` matches; `None` = no match. Fallback profiles score lowest.
    ///
    /// Vendor-wide rules (USB vendor without product, identity without family) are *weak*:
    /// they only count when the name regex also matched (or no regex is set), so e.g. a
    /// Novation Launchpad is not taken for a Circuit Tracks.
    pub fn score(&self, dev: &DeviceInfo) -> Option<i64> {
        let mut score: i64 = 0;
        let mut any_rule = false;
        let mut name_ok = true;
        if let Some(re) = &self.name_regex {
            any_rule = true;
            name_ok = Regex::new(re).ok()?.is_match(&dev.port_name);
            if name_ok {
                score += 100;
            }
        }
        if !self.usb.is_empty() {
            any_rule = true;
            if let Some((v, p)) = dev.usb {
                for id in &self.usb {
                    if id.vendor_id == v && id.product_id.is_none_or(|pp| pp == p) {
                        if id.product_id.is_some() {
                            score += 300;
                        } else if name_ok {
                            score += 50;
                        }
                        break;
                    }
                }
            }
        }
        if let Some(im) = &self.sysex_identity {
            any_rule = true;
            if let Some(reply) = dev.identity_reply.as_deref().and_then(IdentityReply::parse) {
                if reply.manufacturer == im.manufacturer
                    && im.family.is_none_or(|f| f == reply.family)
                    && im.member.is_none_or(|m| m == reply.member)
                    && (im.family.is_some() || name_ok)
                {
                    score += 200 + i64::from(im.family.is_some()) * 100;
                }
            }
        }
        if score > 0 {
            return Some(score * 1000 + i64::from(self.priority));
        }
        if self.fallback || !any_rule {
            return Some(1000 + i64::from(self.priority));
        }
        None
    }
}

/// One physical control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InputDef {
    /// Unique id within the mapping, e.g. `deck1.play`.
    pub id: String,
    /// 1-based MIDI channel; absent = any channel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<u8>,
    #[serde(flatten)]
    pub kind: InputKind,
}

/// Message pattern of a control.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InputKind {
    /// Note on/off button or pad (value = velocity / 127, pressed = velocity > 0).
    Note { note: u8 },
    /// Range of notes (keyboards); the note number is passed to the action.
    NoteRange { first: u8, last: u8 },
    /// 7-bit control change. `relative` = endless encoder.
    Cc {
        cc: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relative: Option<RelativeEncoding>,
    },
    /// 14-bit control change pair; emitted when the LSB arrives (MSB first, as MIDI 1.0 says).
    Cc14 { msb: u8, lsb: u8 },
    /// Relative jog wheel. Bindings with `jog_scratch` become `jog_bend` while untouched.
    Jog { cc: u8, encoding: RelativeEncoding },
    /// NRPN (CC 99/98 select, CC 6/38 data). `high_res` waits for the data LSB.
    Nrpn {
        param: u16,
        #[serde(default, skip_serializing_if = "is_false")]
        high_res: bool,
    },
    /// 14-bit pitch bend.
    PitchBend,
    /// Programme change within `first..=last`; `program - first` fills the action index.
    ProgramChange {
        #[serde(default)]
        first: u8,
        #[serde(default = "max_7bit")]
        last: u8,
    },
    /// SysEx matched against a hex pattern with `??` wildcards, e.g. `"F0 00 20 29 ?? F7"`.
    Sysex { pattern: String },
}

fn max_7bit() -> u8 {
    127
}

/// A modifier (shift) — held by an input or set by the host (virtual modifier).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ModifierDef {
    pub id: String,
    /// Input that drives the modifier; absent = virtual (host calls `set_modifier`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// `true` = each press toggles; `false` = held while pressed.
    #[serde(default, skip_serializing_if = "is_false")]
    pub toggle: bool,
}

/// A deck-switching layer: physical `side` targets one of `decks`; each press of `input`
/// advances to the next deck.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DeckLayerDef {
    pub side: u8,
    pub decks: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
}

/// When a binding fires on a button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    /// Momentary actions on press + release, other actions on press, continuous always.
    #[default]
    Auto,
    Press,
    Release,
    Both,
}

/// Binding conditions.
///
/// Among the bindings of one input whose conditions hold, only those requiring the **most**
/// modifiers fire. So an unshifted binding still works while SHIFT is held unless a
/// SHIFT-specific binding exists for that input (hardware-shift controllers such as the FLX4
/// send different messages under SHIFT and need no conditions at all).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct Condition {
    /// Modifiers that must be held.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<String>,
    /// If true, no other modifier may be held.
    #[serde(default, skip_serializing_if = "is_false")]
    pub exact: bool,
    /// Only when the target deck's pad mode equals this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pad_mode: Option<PadMode>,
}

/// Scale lock for note actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ScaleLockDef {
    /// Use the loaded track's key set by the host (`set_track_key`).
    #[serde(default = "default_true")]
    pub follow_track_key: bool,
    /// Fixed key pitch class (0 = C) when not following / no track key.
    #[serde(default)]
    pub key: u8,
    #[serde(default)]
    pub mode: ScaleMode,
}

/// Input → action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Binding {
    /// Input id.
    pub input: String,
    pub action: Action,
    #[serde(default, skip_serializing_if = "is_default_condition")]
    pub when: Condition,
    #[serde(default, skip_serializing_if = "is_default_trigger")]
    pub trigger: Trigger,
    #[serde(default, skip_serializing_if = "ValueTransform::is_default")]
    pub transform: ValueTransform,
    /// Ignore an absolute control until it reaches the engine's current value.
    #[serde(default, skip_serializing_if = "is_false")]
    pub soft_takeover: bool,
    /// Physical side; the action's deck is rewritten by the side's deck layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_lock: Option<ScaleLockDef>,
}

fn is_default_condition(c: &Condition) -> bool {
    c.modifiers.is_empty() && !c.exact && c.pad_mode.is_none()
}
fn is_default_trigger(t: &Trigger) -> bool {
    *t == Trigger::Auto
}

impl Binding {
    pub fn new(input: impl Into<String>, action: Action) -> Self {
        Self {
            input: input.into(),
            action,
            when: Condition::default(),
            trigger: Trigger::Auto,
            transform: ValueTransform::default(),
            soft_takeover: false,
            side: None,
            scale_lock: None,
        }
    }
}

/// Engine state a feedback output reflects. `deck` / `slot` / `unit` are 0-based.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FeedbackKey {
    Playing {
        deck: u8,
    },
    CueIndicator {
        deck: u8,
    },
    Sync {
        deck: u8,
    },
    LoopActive {
        deck: u8,
    },
    HotCueSet {
        deck: u8,
        slot: u8,
    },
    /// Colour index (0..=127) of a hot cue.
    HotCueColour {
        deck: u8,
        slot: u8,
    },
    PadMode {
        deck: u8,
        mode: PadMode,
    },
    VinylMode {
        deck: u8,
    },
    Loaded {
        deck: u8,
    },
    ChannelCue {
        channel: u8,
    },
    /// Channel level meter 0..1.
    Vu {
        channel: u8,
    },
    /// Jog ring position 0..1 (one platter revolution).
    JogPosition {
        deck: u8,
    },
    FxOn {
        unit: u8,
    },
    SamplerLoaded {
        slot: u8,
    },
    SamplerPlaying {
        slot: u8,
    },
    MasterCue,
    /// Host-defined key.
    Custom {
        name: String,
    },
}

/// Which MIDI message an output sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OutMessage {
    Note,
    Cc,
}

/// LED / meter output.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct OutputDef {
    pub id: String,
    /// 1-based channel.
    pub channel: u8,
    pub message: OutMessage,
    /// Note or CC number.
    pub number: u8,
    pub source: FeedbackKey,
    /// Physical side: the source's deck is replaced by the side's current deck layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<u8>,
    #[serde(flatten)]
    pub kind: OutputKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutputKind {
    /// On / off LED.
    Led {
        #[serde(default = "max_7bit")]
        on: u8,
        #[serde(default)]
        off: u8,
    },
    /// Colour LED: the state's colour index is sent as velocity / value, `off` when unset.
    Colour {
        #[serde(default)]
        off: u8,
    },
    /// Meter / ring: level 0..1 scaled to `min..=max`.
    Meter {
        #[serde(default)]
        min: u8,
        #[serde(default = "max_7bit")]
        max: u8,
    },
}

/// MIDI clock behaviour of this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
pub struct ClockConfig {
    /// Follow incoming clock (device is master / engine is slave).
    #[serde(default)]
    pub receive: bool,
    /// Send clock to the device (engine is master).
    #[serde(default)]
    pub send: bool,
}

/// Groove-lane recording.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct GrooveConfig {
    /// 1-based channels whose notes are recorded.
    pub channels: Vec<u8>,
    /// Quantisation step in ticks at 96 PPQ (24 = 16th note).
    #[serde(default = "default_quantize")]
    pub quantize_ticks: u32,
    /// Pattern length in bars.
    #[serde(default = "default_bars")]
    pub bars: u32,
}

fn default_quantize() -> u32 {
    24
}
fn default_bars() -> u32 {
    4
}

/// Sandboxed rhai script.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ScriptDef {
    /// Script source; may define `init()`, `on_midi(ev)`.
    pub source: String,
    /// Operation budget per call (default 100 000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_operations: Option<u64>,
    /// Wall-time budget per call in milliseconds (default 5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_millis: Option<u64>,
}

/// Validation / parse errors.
#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported mapping format version {0} (expected 1)")]
    Version(u32),
    #[error("duplicate input id `{0}`")]
    DuplicateInput(String),
    #[error("binding / modifier / layer references unknown input `{0}`")]
    UnknownInput(String),
    #[error("binding references unknown modifier `{0}`")]
    UnknownModifier(String),
    #[error("invalid channel {0} (expected 1..=16)")]
    Channel(u8),
    #[error("invalid device name regex: {0}")]
    Regex(String),
    #[error("invalid sysex pattern `{0}`")]
    SysexPattern(String),
    #[error("deck layer for side {0} has no decks")]
    EmptyLayer(u8),
}

impl MappingFile {
    /// Parse and validate a mapping JSON document.
    pub fn from_json(text: &str) -> Result<Self, FormatError> {
        let m: Self = serde_json::from_str(text)?;
        m.validate()?;
        Ok(m)
    }

    pub fn to_json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).expect("mapping serialises")
    }

    /// Structural validation (ids, references, channels, regex, sysex patterns).
    pub fn validate(&self) -> Result<(), FormatError> {
        if self.version != FORMAT_VERSION {
            return Err(FormatError::Version(self.version));
        }
        if let Some(re) = &self.device.name_regex {
            Regex::new(re).map_err(|e| FormatError::Regex(e.to_string()))?;
        }
        let mut ids = std::collections::HashSet::new();
        for i in &self.inputs {
            if !ids.insert(i.id.as_str()) {
                return Err(FormatError::DuplicateInput(i.id.clone()));
            }
            if let Some(c) = i.channel {
                if !(1..=16).contains(&c) {
                    return Err(FormatError::Channel(c));
                }
            }
            if let InputKind::Sysex { pattern } = &i.kind {
                parse_sysex_pattern(pattern)
                    .ok_or_else(|| FormatError::SysexPattern(pattern.clone()))?;
            }
        }
        let known = |id: &str| -> Result<(), FormatError> {
            if ids.contains(id) {
                Ok(())
            } else {
                Err(FormatError::UnknownInput(id.to_string()))
            }
        };
        let mut mods = std::collections::HashSet::new();
        for m in &self.modifiers {
            if let Some(i) = &m.input {
                known(i)?;
            }
            mods.insert(m.id.as_str());
        }
        for l in &self.deck_layers {
            if l.decks.is_empty() {
                return Err(FormatError::EmptyLayer(l.side));
            }
            if let Some(i) = &l.input {
                known(i)?;
            }
        }
        for b in &self.bindings {
            known(&b.input)?;
            for m in &b.when.modifiers {
                if !mods.contains(m.as_str()) {
                    return Err(FormatError::UnknownModifier(m.clone()));
                }
            }
        }
        for o in &self.outputs {
            if !(1..=16).contains(&o.channel) {
                return Err(FormatError::Channel(o.channel));
            }
        }
        Ok(())
    }
}

/// Parse a SysEx hex pattern into `Some(byte)` / `None` (wildcard) items.
pub fn parse_sysex_pattern(p: &str) -> Option<Vec<Option<u8>>> {
    let items: Option<Vec<Option<u8>>> = p
        .split_whitespace()
        .map(|t| {
            if t == "??" {
                Some(None)
            } else {
                u8::from_str_radix(t, 16).ok().map(Some)
            }
        })
        .collect();
    items.filter(|v| !v.is_empty())
}

/// True if `bytes` matches a parsed SysEx pattern exactly (same length).
pub fn sysex_matches(pattern: &[Option<u8>], bytes: &[u8]) -> bool {
    pattern.len() == bytes.len()
        && pattern
            .iter()
            .zip(bytes)
            .all(|(p, b)| p.is_none_or(|v| v == *b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_reply_parse_3byte_manufacturer() {
        let r = IdentityReply::parse(&[
            0xF0, 0x7E, 0x00, 0x06, 0x02, 0x00, 0x20, 0x29, 0x01, 0x02, 0x03, 0x04, 1, 2, 3, 4,
            0xF7,
        ])
        .unwrap();
        assert_eq!(r.manufacturer, vec![0x00, 0x20, 0x29]);
        assert_eq!(r.family, 0x01 | (0x02 << 7));
        assert_eq!(r.member, 0x03 | (0x04 << 7));
    }

    #[test]
    fn sysex_pattern_wildcards() {
        let p = parse_sysex_pattern("F0 7E ?? 06 02 F7").unwrap();
        assert!(sysex_matches(&p, &[0xF0, 0x7E, 0x10, 0x06, 0x02, 0xF7]));
        assert!(!sysex_matches(&p, &[0xF0, 0x7E, 0x10, 0x06, 0x01, 0xF7]));
        assert!(parse_sysex_pattern("F0 zz").is_none());
    }

    #[test]
    fn validate_rejects_unknown_input() {
        let m = MappingFile {
            version: 1,
            id: "x".into(),
            name: "x".into(),
            vendor: None,
            description: None,
            sources: vec![],
            device: DeviceMatch::default(),
            inputs: vec![],
            modifiers: vec![],
            deck_layers: vec![],
            bindings: vec![Binding::new(
                "nope",
                Action::Clock(crate::action::ClockAction::Start),
            )],
            outputs: vec![],
            clock: None,
            groove: None,
            script: None,
        };
        assert!(matches!(m.validate(), Err(FormatError::UnknownInput(_))));
    }
}
