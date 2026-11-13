//! Controller intents shared by every surface (desktop UI, LAN remote, FFI, OSC, MIDI).
//! Serde form = the client messages of `docs/live/remote-protocol.md`.

use crate::core::Command;
use crate::midi::{MidiAction, MidiEvent, MidiMsg, MidiTarget, MixField};
use crate::preset::Setlist;
use crate::session::{Session, SessionError};
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Who may send a control.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Performer,
    Controller,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Control {
    SetParam {
        insert: u32,
        param: String,
        value: f32,
    },
    SetParamNorm {
        insert: u32,
        param: String,
        norm: f32,
    },
    SetEnabled {
        insert: u32,
        on: bool,
    },
    AddInsert {
        fx: String,
        at: u32,
    },
    RemoveInsert {
        insert: u32,
    },
    MoveInsert {
        insert: u32,
        to: u32,
    },
    LoadPreset {
        name: String,
    },
    SavePreset {
        name: String,
    },
    DeletePreset {
        name: String,
    },
    SetMix {
        #[serde(default)]
        input_db: Option<f32>,
        #[serde(default)]
        main_db: Option<f32>,
        #[serde(default)]
        monitor_db: Option<f32>,
        #[serde(default)]
        monitor_dry: Option<f32>,
        #[serde(default)]
        bypass: Option<bool>,
        #[serde(default)]
        mute: Option<bool>,
        /// Monitor option "tuned only for the audience" (`MixState::monitor_untuned`).
        #[serde(default)]
        monitor_untuned: Option<bool>,
    },
    LoadSetlist {
        setlist: Setlist,
    },
    Goto {
        song: u32,
        part: u32,
    },
    Next,
    Prev,
    TapTempo,
    Panic,
    LatencyProbe,
    /// Arm MIDI learn: the next CC / note binds to `target`. `null` cancels.
    MidiLearn {
        #[serde(default)]
        target: Option<MidiTarget>,
    },
    /// Remove binding by index in `state.midi.map.bindings`.
    MidiUnbind {
        index: u32,
    },
    MidiSettings {
        #[serde(default)]
        program_change: Option<bool>,
        /// 1..16, or 0 = omni.
        #[serde(default)]
        channel: Option<u8>,
    },
}

impl Control {
    pub fn required_role(&self) -> Role {
        match self {
            Control::LoadPreset { .. }
            | Control::SetMix { .. }
            | Control::Goto { .. }
            | Control::Next
            | Control::Prev
            | Control::TapTempo
            | Control::Panic => Role::Performer,
            _ => Role::Controller,
        }
    }
}

/// Averages the last taps into a tempo (2..8 taps, resets after 2 s idle).
#[derive(Default)]
pub struct TapTempo {
    taps: Vec<Instant>,
}

impl TapTempo {
    pub fn tap(&mut self, now: Instant) -> Option<f32> {
        if self
            .taps
            .last()
            .is_some_and(|t| now.duration_since(*t).as_secs_f32() > 2.0)
        {
            self.taps.clear();
        }
        self.taps.push(now);
        if self.taps.len() > 8 {
            self.taps.remove(0);
        }
        if self.taps.len() < 2 {
            return None;
        }
        let span = now.duration_since(self.taps[0]).as_secs_f32();
        let beats = (self.taps.len() - 1) as f32;
        let bpm = 60.0 * beats / span.max(1e-3);
        (40.0..=240.0).contains(&bpm).then_some(bpm)
    }
}

impl Session {
    /// Apply a control and return the engine commands it produced.
    pub fn apply_control(
        &mut self,
        c: Control,
        now: Instant,
    ) -> Result<Vec<Command>, SessionError> {
        Ok(match c {
            Control::SetParam {
                insert,
                param,
                value,
            } => vec![self.set_param(insert, &param, value)?],
            Control::SetParamNorm {
                insert,
                param,
                norm,
            } => {
                let fx = self
                    .chain
                    .iter()
                    .find(|i| i.id == insert)
                    .map(|i| i.fx.clone())
                    .ok_or(SessionError::UnknownInsert(insert))?;
                let kind = live_dsp::FxKind::from_id(&fx).ok_or(SessionError::UnknownFx(fx))?;
                let spec = kind
                    .specs()
                    .iter()
                    .find(|s| s.id == param)
                    .copied()
                    .ok_or_else(|| SessionError::UnknownParam(param.clone()))?;
                vec![self.set_param(insert, &param, spec.from_normalized(norm))?]
            }
            Control::SetEnabled { insert, on } => vec![self.set_enabled(insert, on)?],
            Control::AddInsert { fx, at } => vec![self.add_insert(&fx, at as usize)?],
            Control::RemoveInsert { insert } => vec![self.remove_insert(insert)?],
            Control::MoveInsert { insert, to } => vec![self.move_insert(insert, to as usize)?],
            Control::LoadPreset { name } => vec![self.load_preset(&name)?],
            Control::SavePreset { name } => {
                self.save_preset(&name);
                vec![]
            }
            Control::DeletePreset { name } => {
                self.delete_preset(&name)?;
                vec![]
            }
            Control::SetMix {
                input_db,
                main_db,
                monitor_db,
                monitor_dry,
                bypass,
                mute,
                monitor_untuned,
            } => self.set_mix(|m| {
                let db = |v: f32| v.clamp(-60.0, 12.0);
                if let Some(v) = input_db.filter(|v| v.is_finite()) {
                    m.input_db = db(v);
                }
                if let Some(v) = main_db.filter(|v| v.is_finite()) {
                    m.main_db = db(v);
                }
                if let Some(v) = monitor_db.filter(|v| v.is_finite()) {
                    m.monitor_db = db(v);
                }
                if let Some(v) = monitor_dry.filter(|v| v.is_finite()) {
                    m.monitor_dry = v.clamp(0.0, 1.0);
                }
                if let Some(v) = bypass {
                    m.bypass = v;
                }
                if let Some(v) = mute {
                    m.mute = v;
                }
                if let Some(v) = monitor_untuned {
                    m.monitor_untuned = v;
                }
            }),
            Control::LoadSetlist { setlist } => {
                self.load_setlist(setlist);
                vec![]
            }
            Control::Goto { song, part } => self.goto(song as usize, part as usize)?,
            Control::Next => self.next_part()?,
            Control::Prev => self.prev_part()?,
            Control::TapTempo => match self.tap.tap(now) {
                Some(bpm) => {
                    self.bpm = Some(bpm);
                    let ids: Vec<u32> = self
                        .chain
                        .iter()
                        .filter(|i| i.fx == "delay")
                        .map(|i| i.id)
                        .collect();
                    let mut out = Vec::new();
                    for id in ids {
                        out.push(self.set_param(id, "bpm", bpm)?);
                    }
                    out
                }
                None => vec![],
            },
            Control::Panic => self.panic(),
            Control::LatencyProbe => vec![Command::StartLatencyProbe],
            Control::MidiLearn { target } => {
                self.midi.learning = target;
                self.revision += 1;
                vec![]
            }
            Control::MidiUnbind { index } => {
                let i = index as usize;
                if i >= self.midi.map.bindings.len() {
                    return Err(SessionError::UnknownBinding(index));
                }
                self.midi.map.bindings.remove(i);
                self.persist_midi();
                self.revision += 1;
                vec![]
            }
            Control::MidiSettings {
                program_change,
                channel,
            } => {
                if let Some(p) = program_change {
                    self.midi.map.program_change = p;
                }
                if let Some(c) = channel {
                    self.midi.map.channel = (1..=16).contains(&c).then(|| c - 1);
                }
                self.persist_midi();
                self.revision += 1;
                vec![]
            }
        })
    }

    fn panic(&mut self) -> Vec<Command> {
        let mut v = self.set_mix(|m| m.mute = true);
        v.push(Command::Reset);
        v
    }

    /// Feed one raw MIDI message (from any input port). Errors (e.g. a binding for an effect the
    /// current preset lacks) are ignored: MIDI has no reply channel.
    pub fn apply_midi(&mut self, bytes: &[u8], now: Instant) -> Vec<Command> {
        let Some(msg) = MidiMsg::parse(bytes) else {
            return vec![];
        };
        let label = crate::midi::describe(&msg);
        let events = self
            .midi_router
            .route(&mut self.midi.map, &mut self.midi.learning, msg);
        // The activity light is UI-only: it must not bump the revision 30 times a second while a
        // pedal sweeps, so it rides along with the next real change.
        self.midi.last = Some(label);
        let mut out = Vec::new();
        for e in events {
            out.extend(self.apply_midi_event(e, now).unwrap_or_default());
        }
        out
    }

    fn apply_midi_event(
        &mut self,
        e: MidiEvent,
        now: Instant,
    ) -> Result<Vec<Command>, SessionError> {
        let first = |s: &Session, fx: &str| {
            s.chain
                .iter()
                .find(|i| i.fx == fx)
                .map(|i| (i.id, i.enabled))
        };
        Ok(match e {
            MidiEvent::Learned(_) => {
                self.persist_midi();
                self.revision += 1;
                vec![]
            }
            MidiEvent::Value {
                target: MidiTarget::Param { fx, param },
                norm,
            } => match first(self, &fx) {
                Some((insert, _)) => self.apply_control(
                    Control::SetParamNorm {
                        insert,
                        param,
                        norm,
                    },
                    now,
                )?,
                None => vec![],
            },
            MidiEvent::Value {
                target: MidiTarget::Mix { field },
                norm,
            } => {
                // Faders: -60..+12 dB with unity at ~83 % travel; dry blend 0..1.
                let db = -60.0 + norm * 72.0;
                self.set_mix(|m| match field {
                    MixField::InputDb => m.input_db = db,
                    MixField::MainDb => m.main_db = db,
                    MixField::MonitorDb => m.monitor_db = db,
                    MixField::MonitorDry => m.monitor_dry = norm,
                })
            }
            MidiEvent::Value { .. } => vec![],
            MidiEvent::Enable { fx, on } => match first(self, &fx) {
                Some((insert, enabled)) => {
                    vec![self.set_enabled(insert, on.unwrap_or(!enabled))?]
                }
                None => vec![],
            },
            MidiEvent::Action(a) => match a {
                MidiAction::Next => self.next_part()?,
                MidiAction::Prev => self.prev_part()?,
                MidiAction::TapTempo => self.apply_control(Control::TapTempo, now)?,
                MidiAction::Panic => self.panic(),
                MidiAction::ToggleBypass => {
                    let b = !self.mix.bypass;
                    self.set_mix(|m| m.bypass = b)
                }
                MidiAction::ToggleMute => {
                    let v = !self.mix.mute;
                    self.set_mix(|m| m.mute = v)
                }
            },
            MidiEvent::Program(n) => match self.find_program(n) {
                Some((s, p)) => self.goto(s, p)?,
                None => vec![],
            },
        })
    }

    /// First part whose `program` equals `n`, searching from the current song so a repeated
    /// program number in later songs is reachable by stepping through the set.
    fn find_program(&self, n: u8) -> Option<(usize, usize)> {
        let sl = self.setlist.as_ref()?;
        let start = self.position.as_ref().map_or(0, |p| p.song);
        let count = sl.songs.len();
        (0..count).map(|k| (start + k) % count).find_map(|s| {
            sl.songs[s]
                .parts
                .iter()
                .position(|p| p.program == Some(n))
                .map(|p| (s, p))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn parses_protocol_json() {
        let c: Control =
            serde_json::from_str(r#"{"type":"set_mix","monitor_dry":0.5,"mute":false}"#).unwrap();
        assert!(matches!(
            c,
            Control::SetMix {
                monitor_dry: Some(_),
                mute: Some(false),
                ..
            }
        ));
        let n: Control = serde_json::from_str(r#"{"type":"next"}"#).unwrap();
        assert_eq!(n, Control::Next);
        assert_eq!(n.required_role(), Role::Performer);
        let p: Control =
            serde_json::from_str(r#"{"type":"add_insert","fx":"reverb","at":3}"#).unwrap();
        assert_eq!(p.required_role(), Role::Controller);
        assert!(Role::Controller > Role::Performer && Role::Performer > Role::Viewer);
    }

    /// The monitor option "tuned only for the audience" as a client message: it round-trips,
    /// a message from a client that predates it still parses and leaves it alone, and it needs
    /// the role the other mix fields need.
    #[test]
    fn monitor_untuned_message() {
        let on: Control =
            serde_json::from_str(r#"{"type":"set_mix","monitor_untuned":true}"#).unwrap();
        match &on {
            Control::SetMix {
                input_db: None,
                main_db: None,
                monitor_db: None,
                monitor_dry: None,
                bypass: None,
                mute: None,
                monitor_untuned: Some(true),
            } => {}
            other => panic!("{other:?}"),
        }
        let json = serde_json::to_string(&on).unwrap();
        assert!(json.contains(r#""monitor_untuned":true"#), "{json}");
        assert_eq!(serde_json::from_str::<Control>(&json).unwrap(), on);
        assert_eq!(on.required_role(), Role::Performer);
        let old: Control = serde_json::from_str(r#"{"type":"set_mix","mute":false}"#).unwrap();
        assert!(matches!(
            old,
            Control::SetMix {
                monitor_untuned: None,
                mute: Some(false),
                ..
            }
        ));
        assert_eq!(old.required_role(), on.required_role());

        let mut s = Session::new(48000.0, 128);
        s.load_preset("Pop Polish").unwrap();
        let t0 = Instant::now();
        let cmds = s.apply_control(on.clone(), t0).unwrap();
        assert!(s.mix.monitor_untuned);
        assert!(matches!(
            cmds.as_slice(),
            [Command::SetMonitorChain { chain: Some(_) }]
        ));
        // The old message changes what it names and nothing else.
        let cmds = s.apply_control(old, t0).unwrap();
        assert!(cmds.is_empty() && s.mix.monitor_untuned);
        // Sent again: no second chain.
        assert!(s.apply_control(on, t0).unwrap().is_empty());
        let off: Control =
            serde_json::from_str(r#"{"type":"set_mix","monitor_untuned":false,"mute":true}"#)
                .unwrap();
        let cmds = s.apply_control(off, t0).unwrap();
        assert!(!s.mix.monitor_untuned && s.mix.mute);
        assert!(matches!(
            cmds.as_slice(),
            [
                Command::Mute(true),
                Command::SetMonitorChain { chain: None }
            ]
        ));
        // Not a boolean: the message is refused, as for `bypass` and `mute`.
        assert!(
            serde_json::from_str::<Control>(r#"{"type":"set_mix","monitor_untuned":1}"#).is_err()
        );
    }

    #[test]
    fn tap_tempo_averages() {
        let mut t = TapTempo::default();
        let t0 = Instant::now();
        assert_eq!(t.tap(t0), None);
        let mut bpm = None;
        for k in 1..5 {
            bpm = t.tap(t0 + Duration::from_millis(500 * k));
        }
        assert!((bpm.unwrap() - 120.0).abs() < 0.5);
        // Idle > 2 s resets.
        assert_eq!(t.tap(t0 + Duration::from_secs(10)), None);
    }

    #[test]
    fn tap_sets_delay_bpm_and_panic_mutes() {
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Pop Polish").unwrap();
        let t0 = Instant::now();
        for k in 0..4 {
            s.apply_control(Control::TapTempo, t0 + Duration::from_millis(600 * k))
                .unwrap();
        }
        let d = s.chain.iter().find(|i| i.fx == "delay").unwrap();
        assert!((d.params.iter().find(|p| p.0 == "bpm").unwrap().1 - 100.0).abs() < 0.5);
        let delay_id = d.id;
        let cmds = s.apply_control(Control::Panic, t0).unwrap();
        assert!(s.mix.mute);
        assert!(matches!(cmds.last(), Some(Command::Reset)));
        let norm = s
            .apply_control(
                Control::SetParamNorm {
                    insert: delay_id,
                    param: "mix".into(),
                    norm: 0.5,
                },
                t0,
            )
            .unwrap();
        assert!(matches!(norm[0], Command::SetParam { value, .. } if (value - 0.5).abs() < 1e-6));
    }

    fn gig() -> Setlist {
        use crate::preset::{Song, SongPart};
        let part = |name: &str, preset: &str, program| SongPart {
            name: name.into(),
            preset: preset.into(),
            program,
        };
        Setlist {
            version: 1,
            name: "Gig".into(),
            songs: vec![
                Song {
                    title: "One".into(),
                    artist: String::new(),
                    key: None,
                    bpm: None,
                    parts: vec![
                        part("Verse", "Natural Vocal", Some(1)),
                        part("Chorus", "Pop Polish", Some(2)),
                    ],
                    lyrics: None,
                    notes: String::new(),
                },
                Song {
                    title: "Two".into(),
                    artist: String::new(),
                    key: None,
                    bpm: None,
                    parts: vec![part("All", "Hard Snap", Some(7))],
                    lyrics: None,
                    notes: String::new(),
                },
            ],
        }
    }

    #[test]
    fn midi_learn_then_pedal_drives_reverb_mix() {
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Natural Vocal").unwrap();
        let t0 = Instant::now();
        let target = MidiTarget::Param {
            fx: "reverb".into(),
            param: "mix".into(),
        };
        s.apply_control(
            Control::MidiLearn {
                target: Some(target),
            },
            t0,
        )
        .unwrap();
        assert!(s.state().midi.learning.is_some());
        assert!(
            s.apply_midi(&[0xB0, 4, 10], t0).is_empty(),
            "learning swallows the first move"
        );
        assert!(s.midi.learning.is_none());
        let cmds = s.apply_midi(&[0xB0, 4, 127], t0);
        let reverb = s.chain.iter().find(|i| i.fx == "reverb").unwrap();
        assert!(
            matches!(cmds.as_slice(), [Command::SetParam { insert, .. }] if *insert == reverb.id)
        );
        assert_eq!(reverb.params.iter().find(|p| p.0 == "mix").unwrap().1, 1.0);
        // A chain without reverb: the binding is silently inert, not an error.
        let id = reverb.id;
        s.apply_control(Control::RemoveInsert { insert: id }, t0)
            .unwrap();
        assert!(s.apply_midi(&[0xB0, 4, 64], t0).is_empty());
    }

    #[test]
    fn foot_switch_and_program_change_navigate_the_set() {
        let mut s = Session::new(48000.0, 128);
        s.load_setlist(gig());
        let t0 = Instant::now();
        s.apply_control(
            Control::MidiLearn {
                target: Some(MidiTarget::Action {
                    action: MidiAction::Next,
                }),
            },
            t0,
        )
        .unwrap();
        s.apply_midi(&[0xB0, 80, 127], t0); // learn
        s.apply_midi(&[0xB0, 80, 0], t0);
        s.apply_midi(&[0xB0, 80, 127], t0); // press -> first part
        assert_eq!(s.preset_name, "Natural Vocal");
        s.apply_midi(&[0xB0, 80, 0], t0);
        s.apply_midi(&[0xB0, 80, 127], t0);
        assert_eq!(s.preset_name, "Pop Polish");
        s.apply_midi(&[0xC0, 7], t0);
        assert_eq!(s.position.as_ref().map(|p| p.song), Some(1));
        assert_eq!(s.preset_name, "Hard Snap");
        // Unknown program: nothing happens.
        assert!(s.apply_midi(&[0xC0, 99], t0).is_empty());
        // Omni off on another channel ignores it.
        s.apply_control(
            Control::MidiSettings {
                program_change: None,
                channel: Some(2),
            },
            t0,
        )
        .unwrap();
        assert_eq!(s.midi.map.channel, Some(1));
        assert!(s.apply_midi(&[0xC0, 1], t0).is_empty());
        assert!(matches!(
            s.apply_control(Control::MidiUnbind { index: 9 }, t0),
            Err(SessionError::UnknownBinding(9))
        ));
        s.apply_control(Control::MidiUnbind { index: 0 }, t0)
            .unwrap();
        assert!(s.midi.map.bindings.is_empty());
    }

    #[test]
    fn store_persists_user_presets_setlist_and_midi_across_sessions() {
        let dir = std::env::temp_dir().join(format!("live-session-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let t0 = Instant::now();
        {
            let (mut s, w) = Session::new(48000.0, 128).with_store(crate::store::Store::new(&dir));
            assert!(w.is_empty());
            s.load_preset("Natural Vocal").unwrap();
            s.save_preset("My Gig Vocal");
            s.load_setlist(gig());
            s.apply_control(
                Control::MidiLearn {
                    target: Some(MidiTarget::Action {
                        action: MidiAction::Panic,
                    }),
                },
                t0,
            )
            .unwrap();
            s.apply_midi(&[0x90, 36, 100], t0);
            // Factory presets cannot be deleted while unmodified.
            assert!(matches!(
                s.delete_preset("Pop Polish"),
                Err(SessionError::FactoryPreset(_))
            ));
            assert!(s.state().modified_presets.is_empty());
            // Overwriting a factory preset with a changed chain marks it modified; delete reverts it.
            s.load_preset("Pop Polish").unwrap();
            let first = s.chain[0].id;
            s.apply_control(Control::RemoveInsert { insert: first }, t0)
                .unwrap();
            s.save_preset("Pop Polish");
            assert_eq!(s.state().modified_presets, vec!["Pop Polish".to_string()]);
            s.delete_preset("Pop Polish").unwrap();
            assert!(s.state().modified_presets.is_empty());
        }
        let (mut s, _) = Session::new(48000.0, 128).with_store(crate::store::Store::new(&dir));
        assert!(s.presets.iter().any(|p| p.name == "My Gig Vocal"));
        assert_eq!(s.setlist.as_ref().map(|l| l.songs.len()), Some(2));
        assert_eq!(s.midi.map.bindings.len(), 1);
        s.apply_midi(&[0x90, 36, 100], t0);
        assert!(s.mix.mute, "restored pad binding triggers panic");
        s.apply_control(
            Control::DeletePreset {
                name: "My Gig Vocal".into(),
            },
            t0,
        )
        .unwrap();
        let (s2, _) = Session::new(48000.0, 128).with_store(crate::store::Store::new(&dir));
        assert!(!s2.presets.iter().any(|p| p.name == "My Gig Vocal"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
