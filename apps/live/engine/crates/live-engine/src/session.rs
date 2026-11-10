//! Control-thread mirror of the audio state: knows every insert and parameter so the desktop UI
//! and remote controllers can read state without touching the audio thread, and turns user
//! intents into [`Command`]s.

use crate::control::TapTempo;
use crate::core::Command;
use crate::midi::{MidiRouter, MidiState};
use crate::preset::{Preset, PresetError, Setlist, factory, parse_key};
use crate::store::Store;
use live_dsp::param::param_index;
use live_dsp::{FxKind, Insert};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InsertState {
    pub id: u32,
    pub fx: String,
    pub enabled: bool,
    /// (param id, value) in spec order.
    pub params: Vec<(String, f32)>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MixState {
    pub input_db: f32,
    pub main_db: f32,
    pub monitor_db: f32,
    pub monitor_dry: f32,
    pub bypass: bool,
    pub mute: bool,
}

impl Default for MixState {
    fn default() -> Self {
        Self {
            input_db: 0.0,
            main_db: 0.0,
            monitor_db: 0.0,
            monitor_dry: 0.0,
            bypass: false,
            mute: false,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Position {
    pub song: usize,
    pub part: usize,
}

/// Serializable state for clients (the remote protocol sends this on connect + on change).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    pub preset: String,
    pub chain: Vec<InsertState>,
    pub mix: MixState,
    pub setlist: Option<Setlist>,
    pub position: Option<Position>,
    pub presets: Vec<String>,
    /// Names of the built-in presets (read-only: cannot be deleted, saving over them makes a user copy).
    #[serde(default)]
    pub factory_presets: Vec<String>,
    /// Factory presets overridden by a user copy (`delete_preset` reverts them; unmodified ones refuse).
    #[serde(default)]
    pub modified_presets: Vec<String>,
    pub bpm: Option<f32>,
    /// MIDI map, learn target, open ports, last message.
    #[serde(default)]
    pub midi: MidiState,
    pub revision: u64,
}

pub struct Session {
    sr: f32,
    max_block: usize,
    next_id: u32,
    pub preset_name: String,
    pub chain: Vec<InsertState>,
    pub mix: MixState,
    pub presets: Vec<Preset>,
    pub setlist: Option<Setlist>,
    pub position: Option<Position>,
    pub revision: u64,
    pub bpm: Option<f32>,
    pub midi: MidiState,
    /// Where user presets, the setlist and the MIDI map are persisted (none = memory only).
    pub store: Option<Store>,
    pub(crate) tap: TapTempo,
    pub(crate) midi_router: MidiRouter,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SessionError {
    #[error("unknown insert {0}")]
    UnknownInsert(u32),
    #[error("unknown parameter `{0}`")]
    UnknownParam(String),
    #[error("unknown preset `{0}`")]
    UnknownPreset(String),
    #[error("unknown effect `{0}`")]
    UnknownFx(String),
    #[error("chain is full")]
    Full,
    #[error("no setlist loaded")]
    NoSetlist,
    #[error("`{0}` is a factory preset and cannot be deleted")]
    FactoryPreset(String),
    #[error("no MIDI binding {0}")]
    UnknownBinding(u32),
    #[error(transparent)]
    Preset(#[from] PresetError),
}

impl Session {
    pub fn new(sample_rate: f32, max_block: usize) -> Self {
        Self {
            sr: sample_rate,
            max_block,
            next_id: 1,
            preset_name: String::new(),
            chain: Vec::new(),
            mix: MixState::default(),
            presets: factory(),
            setlist: None,
            position: None,
            revision: 0,
            bpm: None,
            midi: MidiState::default(),
            store: None,
            tap: TapTempo::default(),
            midi_router: MidiRouter::default(),
        }
    }

    /// Attach a data directory: loads user presets (a user preset named like a factory one wins),
    /// the last setlist and the MIDI map. Returns non-fatal warnings (unreadable preset files).
    pub fn with_store(mut self, store: Store) -> (Self, Vec<String>) {
        let (user, warnings) = store.load_presets();
        for p in user {
            match self.presets.iter_mut().find(|x| x.name == p.name) {
                Some(slot) => *slot = p,
                None => self.presets.push(p),
            }
        }
        self.setlist = store.load_setlist();
        self.midi.map = store.load_midi();
        self.store = Some(store);
        (self, warnings)
    }

    fn persist(&self, what: &str, r: impl FnOnce(&Store) -> std::io::Result<()>) {
        if let Some(st) = &self.store
            && let Err(e) = r(st)
        {
            log::warn!("saving {what} to {}: {e}", st.dir().display());
        }
    }

    pub(crate) fn persist_midi(&self) {
        let m = self.midi.map.clone();
        self.persist("MIDI map", |s| s.save_midi(&m));
    }

    pub fn state(&self) -> SessionState {
        let factory = factory();
        let modified_presets = factory
            .iter()
            .filter(|f| self.presets.iter().any(|p| p.name == f.name && p != *f))
            .map(|f| f.name.clone())
            .collect();
        SessionState {
            preset: self.preset_name.clone(),
            chain: self.chain.clone(),
            mix: self.mix.clone(),
            setlist: self.setlist.clone(),
            position: self.position.clone(),
            presets: self.presets.iter().map(|p| p.name.clone()).collect(),
            factory_presets: factory.into_iter().map(|p| p.name).collect(),
            modified_presets,
            bpm: self.bpm,
            midi: self.midi.clone(),
            revision: self.revision,
        }
    }

    fn bump(&mut self) {
        self.revision += 1;
    }

    /// Load a preset by name: returns the chain swap command.
    pub fn load_preset(&mut self, name: &str) -> Result<Command, SessionError> {
        let preset = self
            .presets
            .iter()
            .find(|p| p.name == name)
            .cloned()
            .ok_or_else(|| SessionError::UnknownPreset(name.into()))?;
        self.load(&preset)
    }

    pub fn load(&mut self, preset: &Preset) -> Result<Command, SessionError> {
        let built = preset.build(self.sr, self.max_block, self.next_id)?;
        for w in &built.warnings {
            log::warn!("preset {}: {w}", preset.name);
        }
        self.next_id += built.chain.inserts.len() as u32;
        self.chain = built
            .chain
            .inserts
            .iter()
            .map(|i| InsertState {
                id: i.id,
                fx: i.kind.id().into(),
                enabled: i.enabled(),
                params: i
                    .fx
                    .specs()
                    .iter()
                    .enumerate()
                    .map(|(k, s)| (s.id.to_string(), i.fx.param(k)))
                    .collect(),
            })
            .collect();
        self.preset_name = preset.name.clone();
        self.bump();
        Ok(Command::SwapChain { chain: built.chain })
    }

    /// Current chain captured as a preset (for "save as").
    pub fn capture(&self, name: &str) -> Preset {
        Preset {
            version: crate::preset::FORMAT_VERSION,
            name: name.into(),
            description: String::new(),
            tags: vec![],
            chain: self
                .chain
                .iter()
                .map(|i| crate::preset::InsertSpec {
                    fx: i.fx.clone(),
                    enabled: i.enabled,
                    params: i.params.iter().cloned().collect(),
                })
                .collect(),
        }
    }

    pub fn save_preset(&mut self, name: &str) {
        let p = self.capture(name);
        self.persist("preset", |s| s.save_preset(&p));
        match self.presets.iter_mut().find(|x| x.name == name) {
            Some(slot) => *slot = p,
            None => self.presets.push(p),
        }
        self.preset_name = name.into();
        self.bump();
    }

    /// Delete a user preset. A user copy of a factory preset reverts to the factory version.
    pub fn delete_preset(&mut self, name: &str) -> Result<(), SessionError> {
        let i = self
            .presets
            .iter()
            .position(|p| p.name == name)
            .ok_or_else(|| SessionError::UnknownPreset(name.into()))?;
        match factory().into_iter().find(|p| p.name == name) {
            Some(f) if f == self.presets[i] => {
                return Err(SessionError::FactoryPreset(name.into()));
            }
            Some(f) => self.presets[i] = f,
            None => {
                self.presets.remove(i);
            }
        }
        self.persist("preset deletion", |s| s.delete_preset(name));
        self.bump();
        Ok(())
    }

    pub fn set_param(
        &mut self,
        insert: u32,
        param: &str,
        value: f32,
    ) -> Result<Command, SessionError> {
        let ins = self
            .chain
            .iter_mut()
            .find(|i| i.id == insert)
            .ok_or(SessionError::UnknownInsert(insert))?;
        let kind =
            FxKind::from_id(&ins.fx).ok_or_else(|| SessionError::UnknownFx(ins.fx.clone()))?;
        let specs = kind.specs();
        let index =
            param_index(specs, param).ok_or_else(|| SessionError::UnknownParam(param.into()))?;
        let v = specs[index].clamp(value);
        ins.params[index].1 = v;
        self.bump();
        Ok(Command::SetParam {
            insert,
            index,
            value: v,
        })
    }

    pub fn set_enabled(&mut self, insert: u32, on: bool) -> Result<Command, SessionError> {
        let ins = self
            .chain
            .iter_mut()
            .find(|i| i.id == insert)
            .ok_or(SessionError::UnknownInsert(insert))?;
        ins.enabled = on;
        self.bump();
        Ok(Command::SetEnabled { insert, on })
    }

    pub fn add_insert(&mut self, fx: &str, at: usize) -> Result<Command, SessionError> {
        if self.chain.len() >= live_dsp::chain::MAX_INSERTS {
            return Err(SessionError::Full);
        }
        let kind = FxKind::from_id(fx).ok_or_else(|| SessionError::UnknownFx(fx.into()))?;
        let id = self.next_id;
        self.next_id += 1;
        let ins = Insert::new(id, kind, self.sr, self.max_block);
        let state = InsertState {
            id,
            fx: fx.into(),
            enabled: true,
            params: ins
                .fx
                .specs()
                .iter()
                .enumerate()
                .map(|(k, s)| (s.id.to_string(), ins.fx.param(k)))
                .collect(),
        };
        let at = at.min(self.chain.len());
        self.chain.insert(at, state);
        self.bump();
        Ok(Command::AddInsert {
            at,
            insert: Box::new(ins),
        })
    }

    pub fn remove_insert(&mut self, insert: u32) -> Result<Command, SessionError> {
        let i = self
            .chain
            .iter()
            .position(|i| i.id == insert)
            .ok_or(SessionError::UnknownInsert(insert))?;
        self.chain.remove(i);
        self.bump();
        Ok(Command::RemoveInsert { insert })
    }

    pub fn move_insert(&mut self, insert: u32, to: usize) -> Result<Command, SessionError> {
        let i = self
            .chain
            .iter()
            .position(|i| i.id == insert)
            .ok_or(SessionError::UnknownInsert(insert))?;
        let s = self.chain.remove(i);
        let to = to.min(self.chain.len());
        self.chain.insert(to, s);
        self.bump();
        Ok(Command::MoveInsert { insert, to })
    }

    pub fn set_mix(&mut self, f: impl FnOnce(&mut MixState)) -> Vec<Command> {
        let before = self.mix.clone();
        f(&mut self.mix);
        let m = &self.mix;
        let mut out = Vec::new();
        if m.input_db != before.input_db {
            out.push(Command::InputGain(m.input_db));
        }
        if m.main_db != before.main_db {
            out.push(Command::MainGain(m.main_db));
        }
        if m.monitor_db != before.monitor_db {
            out.push(Command::MonitorGain(m.monitor_db));
        }
        if m.monitor_dry != before.monitor_dry {
            out.push(Command::MonitorDry(m.monitor_dry));
        }
        if m.bypass != before.bypass {
            out.push(Command::Bypass(m.bypass));
        }
        if m.mute != before.mute {
            out.push(Command::Mute(m.mute));
        }
        if !out.is_empty() {
            self.bump();
        }
        out
    }

    pub fn load_setlist(&mut self, setlist: Setlist) {
        self.persist("setlist", |s| s.save_setlist(&setlist));
        self.setlist = Some(setlist);
        self.position = None;
        self.bump();
    }

    /// Jump to a song part: loads its preset and applies the song key/tempo to tune/delay inserts.
    pub fn goto(&mut self, song: usize, part: usize) -> Result<Vec<Command>, SessionError> {
        let sl = self.setlist.as_ref().ok_or(SessionError::NoSetlist)?;
        let s = sl.songs.get(song).ok_or(SessionError::NoSetlist)?.clone();
        let p = s.parts.get(part).ok_or(SessionError::NoSetlist)?.clone();
        let mut cmds = vec![self.load_preset(&p.preset)?];
        let ids: Vec<(u32, String)> = self.chain.iter().map(|i| (i.id, i.fx.clone())).collect();
        if let Some((key, scale)) = s.key.as_deref().and_then(parse_key) {
            for (id, fx) in &ids {
                if fx == "autotune" || fx == "harmonizer" {
                    cmds.push(self.set_param(*id, "key", key as f32)?);
                    cmds.push(self.set_param(*id, "scale", scale as f32)?);
                }
            }
        }
        if let Some(bpm) = s.bpm {
            self.bpm = Some(bpm);
            for (id, fx) in &ids {
                if fx == "delay" {
                    cmds.push(self.set_param(*id, "bpm", bpm)?);
                }
            }
        }
        self.position = Some(Position { song, part });
        self.bump();
        Ok(cmds)
    }

    /// Next part, or the first part of the next song.
    pub fn next_part(&mut self) -> Result<Vec<Command>, SessionError> {
        let sl = self.setlist.as_ref().ok_or(SessionError::NoSetlist)?;
        let (s, p) = match &self.position {
            None => (0, 0),
            Some(pos) => {
                let parts = sl.songs.get(pos.song).map_or(0, |s| s.parts.len());
                if pos.part + 1 < parts {
                    (pos.song, pos.part + 1)
                } else if pos.song + 1 < sl.songs.len() {
                    (pos.song + 1, 0)
                } else {
                    (pos.song, pos.part)
                }
            }
        };
        self.goto(s, p)
    }

    pub fn prev_part(&mut self) -> Result<Vec<Command>, SessionError> {
        let sl = self.setlist.as_ref().ok_or(SessionError::NoSetlist)?;
        let (s, p) = match &self.position {
            None => (0, 0),
            Some(pos) if pos.part > 0 => (pos.song, pos.part - 1),
            Some(pos) if pos.song > 0 => {
                let prev = pos.song - 1;
                (prev, sl.songs[prev].parts.len().saturating_sub(1))
            }
            Some(pos) => (pos.song, pos.part),
        };
        self.goto(s, p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::{Song, SongPart};

    #[test]
    fn state_serializes_and_round_trips() {
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Natural Vocal").unwrap();
        let j = serde_json::to_string(&s.state()).expect("state must serialize");
        let back: SessionState = serde_json::from_str(&j).expect("state must parse");
        assert_eq!(back, s.state());
    }

    fn setlist() -> Setlist {
        Setlist {
            version: 1,
            name: "Gig".into(),
            songs: vec![
                Song {
                    title: "One".into(),
                    artist: String::new(),
                    key: Some("A minor".into()),
                    bpm: Some(90.0),
                    parts: vec![
                        SongPart {
                            name: "Verse".into(),
                            preset: "Natural Vocal".into(),
                            program: Some(1),
                        },
                        SongPart {
                            name: "Chorus".into(),
                            preset: "Pop Polish".into(),
                            program: Some(2),
                        },
                    ],
                    lyrics: None,
                    notes: String::new(),
                },
                Song {
                    title: "Two".into(),
                    artist: String::new(),
                    key: None,
                    bpm: None,
                    parts: vec![SongPart {
                        name: "All".into(),
                        preset: "Hard Tune".into(),
                        program: None,
                    }],
                    lyrics: None,
                    notes: String::new(),
                },
            ],
        }
    }

    #[test]
    fn setlist_navigation_applies_key_and_tempo() {
        let mut s = Session::new(48000.0, 128);
        s.load_setlist(setlist());
        s.next_part().unwrap();
        assert_eq!(s.preset_name, "Natural Vocal");
        s.next_part().unwrap();
        assert_eq!(s.preset_name, "Pop Polish");
        let tune = s.chain.iter().find(|i| i.fx == "autotune").unwrap();
        assert_eq!(tune.params.iter().find(|p| p.0 == "key").unwrap().1, 9.0);
        assert_eq!(tune.params.iter().find(|p| p.0 == "scale").unwrap().1, 2.0);
        let delay = s.chain.iter().find(|i| i.fx == "delay").unwrap();
        assert_eq!(delay.params.iter().find(|p| p.0 == "bpm").unwrap().1, 90.0);
        s.next_part().unwrap();
        assert_eq!(s.position, Some(Position { song: 1, part: 0 }));
        s.next_part().unwrap(); // stays at the end
        assert_eq!(s.position, Some(Position { song: 1, part: 0 }));
        s.prev_part().unwrap();
        assert_eq!(s.position, Some(Position { song: 0, part: 1 }));
    }

    #[test]
    fn edits_update_shadow_and_clamp() {
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Natural Vocal").unwrap();
        let id = s.chain[3].id; // compressor
        match s.set_param(id, "ratio", 999.0).unwrap() {
            Command::SetParam { value, .. } => assert_eq!(value, 20.0),
            _ => panic!(),
        }
        assert!(matches!(
            s.set_param(id, "nope", 1.0),
            Err(SessionError::UnknownParam(_))
        ));
        let r0 = s.revision;
        s.add_insert("chorus", 2).unwrap();
        assert_eq!(s.chain[2].fx, "chorus");
        assert!(s.revision > r0);
        s.save_preset("Mine");
        assert!(
            s.presets
                .iter()
                .any(|p| p.name == "Mine" && p.chain.len() == 7)
        );
    }
}
