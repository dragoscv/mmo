//! MIDI control: message parsing, the binding map, MIDI learn and program-change recall.
//!
//! Pure logic (no port I/O): the binary feeds raw bytes from midir. Bluetooth LE MIDI pedals appear
//! as ordinary ports once paired in the OS (Windows MIDI Services, CoreMIDI, BlueZ), so they need
//! nothing extra here. See `docs/live/midi.md`.

use serde::{Deserialize, Serialize};

/// A parsed channel message (running status is resolved by the caller's port API).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidiMsg {
    /// Control change: channel 0..15, controller, value 0..127.
    Cc { ch: u8, num: u8, value: u8 },
    /// Note on with velocity > 0.
    NoteOn { ch: u8, num: u8, vel: u8 },
    /// Note off (or note on with velocity 0).
    NoteOff { ch: u8, num: u8 },
    /// Program change 0..127.
    Program { ch: u8, num: u8 },
}

impl MidiMsg {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let (&status, data) = bytes.split_first()?;
        if !(0x80..0xF0).contains(&status) {
            return None;
        }
        let ch = status & 0x0F;
        let d0 = *data.first()? & 0x7F;
        match status & 0xF0 {
            0xB0 => Some(Self::Cc {
                ch,
                num: d0,
                value: *data.get(1)? & 0x7F,
            }),
            0x90 => {
                let vel = *data.get(1)? & 0x7F;
                Some(if vel == 0 {
                    Self::NoteOff { ch, num: d0 }
                } else {
                    Self::NoteOn { ch, num: d0, vel }
                })
            }
            0x80 => Some(Self::NoteOff { ch, num: d0 }),
            0xC0 => Some(Self::Program { ch, num: d0 }),
            _ => None,
        }
    }

    fn source(&self) -> Option<MidiSource> {
        match *self {
            Self::Cc { ch, num, .. } => Some(MidiSource {
                kind: SourceKind::Cc,
                channel: Some(ch),
                number: num,
            }),
            Self::NoteOn { ch, num, .. } | Self::NoteOff { ch, num } => Some(MidiSource {
                kind: SourceKind::Note,
                channel: Some(ch),
                number: num,
            }),
            Self::Program { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Cc,
    Note,
}

/// What a binding listens to. `channel: None` = any channel (omni).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiSource {
    pub kind: SourceKind,
    #[serde(default)]
    pub channel: Option<u8>,
    pub number: u8,
}

impl MidiSource {
    fn matches(&self, other: &MidiSource) -> bool {
        self.kind == other.kind
            && self.number == other.number
            && (self.channel.is_none() || self.channel == other.channel)
    }
}

/// Continuous mix fields a fader/expression pedal can drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MixField {
    InputDb,
    MainDb,
    MonitorDb,
    MonitorDry,
}

/// One-shot actions (note on / CC crossing 64 upwards).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MidiAction {
    Next,
    Prev,
    TapTempo,
    Panic,
    ToggleBypass,
    ToggleMute,
}

/// What a binding controls. Parameters address the first insert of an effect kind, so a binding
/// keeps working when a song part loads another preset (insert ids change on every load).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MidiTarget {
    Param {
        fx: String,
        param: String,
    },
    /// Insert on/off by effect kind (CC >= 64 or note held = on; note toggles).
    Enable {
        fx: String,
    },
    Mix {
        field: MixField,
    },
    Action {
        action: MidiAction,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MidiBinding {
    pub source: MidiSource,
    pub target: MidiTarget,
}

/// Persisted map (`midi.json`) plus the transient learn state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MidiMap {
    #[serde(default)]
    pub bindings: Vec<MidiBinding>,
    /// Program change recalls the song part whose `program` matches (default on).
    #[serde(default = "yes")]
    pub program_change: bool,
    /// Only listen to this channel (0..15); `None` = omni.
    #[serde(default)]
    pub channel: Option<u8>,
}

impl Default for MidiMap {
    fn default() -> Self {
        Self {
            bindings: Vec::new(),
            program_change: true,
            channel: None,
        }
    }
}

fn yes() -> bool {
    true
}

/// Session-side MIDI state sent to clients.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MidiState {
    pub map: MidiMap,
    /// Target waiting for the next CC/note (MIDI learn).
    pub learning: Option<MidiTarget>,
    /// Input ports the engine has open.
    pub ports: Vec<String>,
    /// Last message seen (for the "MIDI activity" light), e.g. `"cc 1/64 = 100"`.
    pub last: Option<String>,
}

/// What an incoming message resolved to.
#[derive(Clone, Debug, PartialEq)]
pub enum MidiEvent {
    /// The pending learn target was bound to this source.
    Learned(MidiBinding),
    /// Continuous value 0..1 for a parameter or mix field.
    Value {
        target: MidiTarget,
        norm: f32,
    },
    /// Enable state for an insert kind.
    Enable {
        fx: String,
        on: Option<bool>,
    },
    Action(MidiAction),
    Program(u8),
}

/// Per-binding memory for edge detection (CC switches send 127/0, some pedals send 0..127 sweeps).
#[derive(Default)]
pub struct MidiRouter {
    last_cc: Vec<(MidiSource, u8)>,
}

impl MidiRouter {
    /// Resolve one message. `learning` is consumed when a CC/note arrives.
    pub fn route(
        &mut self,
        map: &mut MidiMap,
        learning: &mut Option<MidiTarget>,
        msg: MidiMsg,
    ) -> Vec<MidiEvent> {
        let ch = match msg {
            MidiMsg::Cc { ch, .. }
            | MidiMsg::NoteOn { ch, .. }
            | MidiMsg::NoteOff { ch, .. }
            | MidiMsg::Program { ch, .. } => ch,
        };
        if map.channel.is_some_and(|c| c != ch) {
            return vec![];
        }
        if let MidiMsg::Program { num, .. } = msg {
            return if map.program_change {
                vec![MidiEvent::Program(num)]
            } else {
                vec![]
            };
        }
        let Some(src) = msg.source() else {
            return vec![];
        };
        // Learn on the first "press": a CC of any value or a note on (not the note off that follows).
        if learning.is_some() && !matches!(msg, MidiMsg::NoteOff { .. }) {
            let target = learning.take().expect("checked");
            let source = MidiSource {
                channel: map.channel.or(Some(ch)),
                ..src
            };
            map.bindings.retain(|b| b.source != source);
            let b = MidiBinding { source, target };
            map.bindings.push(b.clone());
            return vec![MidiEvent::Learned(b)];
        }
        let previous = self.remember(&src, msg);
        let mut out = Vec::new();
        for b in map.bindings.iter().filter(|b| b.source.matches(&src)) {
            if let Some(e) = Self::event(&b.target, msg, previous) {
                out.push(e);
            }
        }
        out
    }

    fn remember(&mut self, src: &MidiSource, msg: MidiMsg) -> Option<u8> {
        let MidiMsg::Cc { value, .. } = msg else {
            return None;
        };
        match self.last_cc.iter_mut().find(|(s, _)| s == src) {
            Some((_, v)) => Some(std::mem::replace(v, value)),
            None => {
                self.last_cc.push((*src, value));
                None
            }
        }
    }

    fn event(target: &MidiTarget, msg: MidiMsg, previous: Option<u8>) -> Option<MidiEvent> {
        match (target, msg) {
            (MidiTarget::Param { .. } | MidiTarget::Mix { .. }, MidiMsg::Cc { value, .. }) => {
                Some(MidiEvent::Value {
                    target: target.clone(),
                    norm: value as f32 / 127.0,
                })
            }
            (MidiTarget::Param { .. } | MidiTarget::Mix { .. }, MidiMsg::NoteOn { vel, .. }) => {
                Some(MidiEvent::Value {
                    target: target.clone(),
                    norm: vel as f32 / 127.0,
                })
            }
            (MidiTarget::Enable { fx }, MidiMsg::Cc { value, .. }) => Some(MidiEvent::Enable {
                fx: fx.clone(),
                on: Some(value >= 64),
            }),
            (MidiTarget::Enable { fx }, MidiMsg::NoteOn { .. }) => Some(MidiEvent::Enable {
                fx: fx.clone(),
                on: None,
            }),
            (MidiTarget::Action { action }, MidiMsg::NoteOn { .. }) => {
                Some(MidiEvent::Action(*action))
            }
            // Momentary foot switches send 127 then 0: fire once on the upward crossing.
            (MidiTarget::Action { action }, MidiMsg::Cc { value, .. })
                if value >= 64 && previous.is_none_or(|p| p < 64) =>
            {
                Some(MidiEvent::Action(*action))
            }
            _ => None,
        }
    }
}

/// Human-readable form for the activity light.
pub fn describe(msg: &MidiMsg) -> String {
    match *msg {
        MidiMsg::Cc { ch, num, value } => format!("cc {}/{num} = {value}", ch + 1),
        MidiMsg::NoteOn { ch, num, vel } => format!("note {}/{num} on {vel}", ch + 1),
        MidiMsg::NoteOff { ch, num } => format!("note {}/{num} off", ch + 1),
        MidiMsg::Program { ch, num } => format!("program {}/{num}", ch + 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc(num: u8, value: u8) -> MidiMsg {
        MidiMsg::Cc { ch: 0, num, value }
    }

    #[test]
    fn parses_channel_messages() {
        assert_eq!(
            MidiMsg::parse(&[0xB2, 7, 100]),
            Some(MidiMsg::Cc {
                ch: 2,
                num: 7,
                value: 100
            })
        );
        assert_eq!(
            MidiMsg::parse(&[0x90, 60, 0]),
            Some(MidiMsg::NoteOff { ch: 0, num: 60 })
        );
        assert_eq!(
            MidiMsg::parse(&[0xC5, 3]),
            Some(MidiMsg::Program { ch: 5, num: 3 })
        );
        assert_eq!(MidiMsg::parse(&[0xF8]), None); // clock
        assert_eq!(MidiMsg::parse(&[0xB0, 7]), None); // truncated
        assert_eq!(MidiMsg::parse(&[]), None);
    }

    #[test]
    fn learn_binds_next_cc_and_replaces_old_binding() {
        let mut map = MidiMap::default();
        let mut r = MidiRouter::default();
        let mut learning = Some(MidiTarget::Mix {
            field: MixField::MainDb,
        });
        let ev = r.route(&mut map, &mut learning, cc(11, 30));
        assert!(matches!(ev.as_slice(), [MidiEvent::Learned(_)]));
        assert!(learning.is_none());
        let mut learning = Some(MidiTarget::Action {
            action: MidiAction::Next,
        });
        r.route(&mut map, &mut learning, cc(11, 127));
        assert_eq!(
            map.bindings.len(),
            1,
            "same source rebinds instead of stacking"
        );
        assert_eq!(
            map.bindings[0].target,
            MidiTarget::Action {
                action: MidiAction::Next
            }
        );
    }

    #[test]
    fn foot_switch_fires_once_per_press() {
        let mut map = MidiMap {
            bindings: vec![MidiBinding {
                source: MidiSource {
                    kind: SourceKind::Cc,
                    channel: None,
                    number: 80,
                },
                target: MidiTarget::Action {
                    action: MidiAction::Next,
                },
            }],
            ..MidiMap::default()
        };
        let mut r = MidiRouter::default();
        let mut l = None;
        let fired = |e: Vec<MidiEvent>| {
            e.iter()
                .filter(|e| **e == MidiEvent::Action(MidiAction::Next))
                .count()
        };
        assert_eq!(fired(r.route(&mut map, &mut l, cc(80, 127))), 1);
        assert_eq!(
            fired(r.route(&mut map, &mut l, cc(80, 127))),
            0,
            "held switch repeats nothing"
        );
        assert_eq!(fired(r.route(&mut map, &mut l, cc(80, 0))), 0);
        assert_eq!(fired(r.route(&mut map, &mut l, cc(80, 127))), 1);
    }

    #[test]
    fn channel_filter_and_program_change() {
        let mut map = MidiMap {
            channel: Some(1),
            ..MidiMap::default()
        };
        let mut r = MidiRouter::default();
        let mut l = None;
        assert!(
            r.route(&mut map, &mut l, MidiMsg::Program { ch: 0, num: 2 })
                .is_empty()
        );
        assert_eq!(
            r.route(&mut map, &mut l, MidiMsg::Program { ch: 1, num: 2 }),
            vec![MidiEvent::Program(2)]
        );
        map.program_change = false;
        assert!(
            r.route(&mut map, &mut l, MidiMsg::Program { ch: 1, num: 2 })
                .is_empty()
        );
    }

    #[test]
    fn expression_pedal_maps_to_norm() {
        let target = MidiTarget::Param {
            fx: "reverb".into(),
            param: "mix".into(),
        };
        let mut map = MidiMap {
            bindings: vec![MidiBinding {
                source: MidiSource {
                    kind: SourceKind::Cc,
                    channel: Some(0),
                    number: 4,
                },
                target: target.clone(),
            }],
            ..MidiMap::default()
        };
        let mut r = MidiRouter::default();
        let mut l = None;
        assert_eq!(
            r.route(&mut map, &mut l, cc(4, 127)),
            vec![MidiEvent::Value { target, norm: 1.0 }]
        );
        // Other channel does not match a channel-bound source.
        assert!(
            r.route(
                &mut map,
                &mut l,
                MidiMsg::Cc {
                    ch: 3,
                    num: 4,
                    value: 1
                }
            )
            .is_empty()
        );
    }
}
