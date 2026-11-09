//! Controller intents shared by every surface (desktop UI, LAN remote, FFI, OSC, MIDI).
//! Serde form = the client messages of `docs/live/remote-protocol.md`.

use crate::core::Command;
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
            Control::SetMix {
                input_db,
                main_db,
                monitor_db,
                monitor_dry,
                bypass,
                mute,
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
            Control::Panic => {
                let mut v = self.set_mix(|m| m.mute = true);
                v.push(Command::Reset);
                v
            }
            Control::LatencyProbe => vec![Command::StartLatencyProbe],
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
}
