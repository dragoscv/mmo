//! Control-thread mirror of the audio state: knows every insert and parameter so the desktop UI
//! and remote controllers can read state without touching the audio thread, and turns user
//! intents into [`Command`]s.

use crate::control::TapTempo;
use crate::core::{Command, is_pitch_fx};
use crate::midi::{MidiRouter, MidiState};
use crate::preset::{Preset, PresetError, Setlist, factory, parse_key};
use crate::store::Store;
use live_dsp::param::param_index;
use live_dsp::{Chain, FxKind, Insert};
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
    /// Monitor option "tuned only for the audience": the in-ear bus gets the chain without the
    /// pitch effects (so without their delay); the main bus keeps the full chain.
    #[serde(default)]
    pub monitor_untuned: bool,
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
            monitor_untuned: false,
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

/// Drop the pitch effects ([`is_pitch_fx`]) of a freshly built chain: what is left feeds the
/// monitor bus while `mix.monitor_untuned` is on. Control thread only (frees the dropped boxes);
/// the vector keeps its full capacity, so the audio thread can still add inserts to it.
fn without_pitch(mut chain: Box<Chain>) -> Box<Chain> {
    chain.inserts.retain(|i| !is_pitch_fx(i.kind));
    chain
}

/// Factory presets renamed since the first release: setlists, MIDI maps and remotes saved with the
/// old name keep working. Used only when no preset carries the old name literally, so a user
/// preset saved as "Hard Tune" still loads as itself.
pub fn renamed_preset(name: &str) -> &str {
    match name {
        "Hard Tune" => "Hard Snap",
        _ => name,
    }
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

    /// The chain that feeds the monitor bus when `mix.monitor_untuned` is switched on: the
    /// current chain without the pitch effects — same insert ids, order, parameters and enabled
    /// flags, built the way a preset is built. Its effects start with empty state: it is a
    /// second set of effects, not a tap on the main chain, so its reverb and delay fill up from
    /// the moment it is switched on. Allocates: control thread only.
    fn monitor_chain(&self) -> Option<Box<Chain>> {
        let mut chain = match self.capture("").build(self.sr, self.max_block, 0) {
            Ok(built) => built.chain,
            Err(e) => {
                log::warn!("monitor chain: {e}");
                return None;
            }
        };
        // Insert ids are the link between the two chains.
        for (ins, st) in chain.inserts.iter_mut().zip(&self.chain) {
            ins.id = st.id;
        }
        Some(without_pitch(chain))
    }

    /// Load a preset by name: returns the chain swap command (one command: with
    /// `mix.monitor_untuned` on it carries the monitor chain too).
    pub fn load_preset(&mut self, name: &str) -> Result<Command, SessionError> {
        let name = if self.presets.iter().any(|p| p.name == name) {
            name
        } else {
            renamed_preset(name)
        };
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
        // With the monitor option on, the same preset is built a second time for the monitor
        // bus (same ids) and loses its pitch effects.
        let monitor = if self.mix.monitor_untuned {
            let again = preset.build(self.sr, self.max_block, self.next_id)?;
            Some(without_pitch(again.chain))
        } else {
            None
        };
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
        Ok(match monitor {
            Some(monitor) => Command::SwapChains {
                chain: built.chain,
                monitor,
            },
            None => Command::SwapChain { chain: built.chain },
        })
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
        // The monitor chain gets its own instance (same id), unless it is a pitch effect.
        let monitor = (self.mix.monitor_untuned && !is_pitch_fx(kind))
            .then(|| Box::new(Insert::new(id, kind, self.sr, self.max_block)));
        Ok(match monitor {
            Some(monitor) => Command::AddInsertBoth {
                at,
                insert: Box::new(ins),
                monitor,
            },
            None => Command::AddInsert {
                at,
                insert: Box::new(ins),
            },
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
        let untuned = m.monitor_untuned;
        if untuned != before.monitor_untuned {
            // On: the monitor chain is built from the chain as it is now. Off: the audio thread
            // fades back to the main chain and hands the monitor chain back.
            match untuned.then(|| self.monitor_chain()) {
                // The chain could not be built: the option stays off rather than lying.
                Some(None) => self.mix.monitor_untuned = false,
                Some(chain) => out.push(Command::SetMonitorChain { chain }),
                None => out.push(Command::SetMonitorChain { chain: None }),
            }
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

    /// The old factory name loads the renamed preset, unless the user has a preset of their own
    /// under that name: then theirs wins.
    #[test]
    fn old_preset_name_resolves_but_never_shadows_a_user_preset() {
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Hard Tune").unwrap();
        assert_eq!(s.preset_name, "Hard Snap");

        s.load_preset("Natural Vocal").unwrap();
        s.save_preset("Hard Tune"); // a user copy under the old name (Natural Vocal's chain)
        s.load_preset("Pop Polish").unwrap();
        s.load_preset("Hard Tune").unwrap();
        assert_eq!(s.preset_name, "Hard Tune");
        assert_eq!(
            s.chain[0].fx, "gate",
            "the user's chain, not the factory one"
        );
        // The renamed factory preset is still there under its new name.
        s.load_preset("Hard Snap").unwrap();
        assert_eq!(s.chain[0].fx, "eq");
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
                        // The old name of "Hard Snap": a saved setlist must still recall it.
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
        assert_eq!(s.preset_name, "Hard Snap", "old preset name must resolve");
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

    // ─── Monitor option "tuned only for the audience" ───────────────────────

    use crate::control::Control;
    use crate::core::{Buses, Core, Ledger};
    use std::time::Instant;

    /// The pitch effects, spelled out: the tests must not share the list they check.
    fn is_pitch(fx: &str) -> bool {
        ["autotune", "harmonizer"].contains(&fx)
    }

    fn first(s: &Session, fx: &str) -> Option<u32> {
        s.chain.iter().find(|i| i.fx == fx).map(|i| i.id)
    }

    /// One thing a user, a remote or a pedal does. Effects are addressed by kind (the first
    /// insert of that effect): insert ids differ between the sessions that are compared.
    #[derive(Clone, Copy, Debug)]
    enum Edit {
        Param(&'static str, &'static str, f32),
        Enable(&'static str, bool),
        Add(&'static str, usize),
        Remove(&'static str),
        Move(&'static str, usize),
        Load(&'static str),
        Goto(usize, usize),
        Next,
        Prev,
        /// A raw MIDI message.
        Midi(&'static [u8]),
        /// A client message (protocol JSON).
        Message(&'static str),
        /// The panic button (mute + reset), then unmute.
        Panic,
        /// The monitor option, through the client message.
        Untuned(bool),
        /// The option off and on again with no audio in between.
        OffOn,
    }

    fn edit(s: &mut Session, e: Edit) -> Vec<Command> {
        let now = Instant::now();
        let untuned = |s: &mut Session, on: bool| {
            let json = format!(r#"{{"type":"set_mix","monitor_untuned":{on}}}"#);
            s.apply_control(serde_json::from_str(&json).unwrap(), now)
                .unwrap()
        };
        match e {
            Edit::Param(fx, param, value) => first(s, fx)
                .map(|id| s.set_param(id, param, value).unwrap())
                .into_iter()
                .collect(),
            Edit::Enable(fx, on) => first(s, fx)
                .map(|id| s.set_enabled(id, on).unwrap())
                .into_iter()
                .collect(),
            Edit::Add(fx, at) => vec![s.add_insert(fx, at).unwrap()],
            Edit::Remove(fx) => first(s, fx)
                .map(|id| s.remove_insert(id).unwrap())
                .into_iter()
                .collect(),
            Edit::Move(fx, to) => first(s, fx)
                .map(|id| s.move_insert(id, to).unwrap())
                .into_iter()
                .collect(),
            Edit::Load(name) => vec![s.load_preset(name).unwrap()],
            Edit::Goto(song, part) => s.goto(song, part).unwrap(),
            Edit::Next => s.next_part().unwrap(),
            Edit::Prev => s.prev_part().unwrap(),
            Edit::Midi(bytes) => s.apply_midi(bytes, now),
            Edit::Message(json) => s
                .apply_control(serde_json::from_str(json).unwrap(), now)
                .unwrap(),
            Edit::Panic => {
                let mut v = s.apply_control(Control::Panic, now).unwrap();
                v.extend(s.set_mix(|m| m.mute = false));
                v
            }
            Edit::Untuned(on) => untuned(s, on),
            Edit::OffOn => {
                let mut v = untuned(s, false);
                v.extend(untuned(s, true));
                v
            }
        }
    }

    /// One block through a core: (main L then R, monitor L then R).
    fn render(core: &mut Core, input: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = input.len();
        let (mut ml, mut mr, mut ol, mut or) =
            (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        core.render(
            input,
            input,
            Buses {
                main_l: &mut ml,
                main_r: &mut mr,
                mon_l: &mut ol,
                mon_r: &mut or,
            },
        );
        ml.extend(mr);
        ol.extend(or);
        (ml, ol)
    }

    /// A sung note (226 Hz, 47 cents sharp of A3, with harmonics) with a 3 Hz tremolo, so
    /// pitch correction, compressors and echoes all have something to do.
    fn signal(from: usize, n: usize) -> Vec<f32> {
        (from..from + n)
            .map(|i| {
                let t = i as f32 / 48000.0;
                let w = core::f32::consts::TAU * 226.0 * t;
                let voice = 0.2 * w.sin() + 0.1 * (2.0 * w).sin() + 0.05 * (3.0 * w).sin();
                (0.6 + 0.4 * (core::f32::consts::TAU * 3.0 * t).sin()) * voice
            })
            .collect()
    }

    /// A chain as (id, effect, enabled, parameter values).
    type Shape = Vec<(u32, String, bool, Vec<f32>)>;

    fn shape(chain: &Chain) -> Shape {
        chain
            .inserts
            .iter()
            .map(|i| {
                let params = (0..i.fx.specs().len()).map(|k| i.fx.param(k)).collect();
                (i.id, i.kind.id().to_string(), i.enabled(), params)
            })
            .collect()
    }

    /// Three engines fed the same audio and the same edits.
    struct Rig {
        /// Under test: the monitor option is used here.
        a: (Session, Core),
        /// The same edits, the option never touched: its main bus is the golden main bus.
        plain: (Session, Core),
        /// The same chain without its pitch effects, as a MAIN chain: its main bus is what the
        /// monitor bus of `a` must carry.
        reference: (Session, Core),
        /// Input gain of the reference: a monitor chain switched on in the middle of a song
        /// gets its input faded in over 10 ms, so the reference gets the same.
        reference_in: live_dsp::Smoothed,
        ledger: Ledger,
        t: usize,
        /// Blocks in which the monitor bus of `a` differed from its main bus.
        untuned_blocks: usize,
    }

    impl Rig {
        /// Blocks of 128 frames rendered and compared after every edit (171 ms).
        const BLOCKS: usize = 64;

        fn new() -> Self {
            let pair = || {
                let mut s = Session::new(48000.0, 128);
                s.load_setlist(setlist());
                (s, Core::new(48000.0, 128))
            };
            let a = pair();
            let ledger = Ledger::for_core(&a.1);
            Self {
                a,
                plain: pair(),
                reference: pair(),
                reference_in: live_dsp::Smoothed::with_ms(1.0, 10.0, 48000.0),
                ledger,
                t: 0,
                untuned_blocks: 0,
            }
        }

        fn send(pair: &mut (Session, Core), e: Edit) {
            for c in edit(&mut pair.0, e) {
                pair.1.apply(c, &mut |_g| {});
            }
        }

        /// The reference starts again, empty, from the chain `a` has now (minus the pitch
        /// effects): what a monitor chain switched on at this moment is.
        fn restart_reference(&mut self) {
            let mut preset = self.a.0.capture("reference");
            preset.chain.retain(|i| !is_pitch(&i.fx));
            let mut s = Session::new(48000.0, 128);
            s.setlist = self.a.0.setlist.clone();
            s.position = self.a.0.position.clone();
            s.midi = self.a.0.midi.clone();
            let mut c = Core::new(48000.0, 128);
            c.apply(s.load(&preset).unwrap(), &mut |_g| {});
            self.reference = (s, c);
            self.reference_in.reset(0.0);
            self.reference_in.set(1.0);
        }

        fn apply(&mut self, e: Edit) {
            let before: Vec<String> = self.a.0.chain.iter().map(|i| i.fx.clone()).collect();
            let moved = match e {
                Edit::Move(fx, _) => first(&self.a.0, fx),
                _ => None,
            };
            for c in edit(&mut self.a.0, e) {
                self.ledger.apply(&mut self.a.1, c);
            }
            if matches!(e, Edit::Untuned(_) | Edit::OffOn) {
                // Only `a` has the option. The reference restarts in `step`, at the block in
                // which the new monitor chain starts.
                return;
            }
            Self::send(&mut self.plain, e);
            // Positions in the reference: the same place among the effects that are not pitch
            // effects.
            let kept = |fx: &[String]| fx.iter().filter(|f| !is_pitch(f)).count();
            let for_reference = match e {
                Edit::Add(fx, _) | Edit::Move(fx, _) if is_pitch(fx) => None,
                Edit::Add(fx, at) => Some(Edit::Add(fx, kept(&before[..at.min(before.len())]))),
                Edit::Move(fx, _) => {
                    let now: Vec<String> = self.a.0.chain.iter().map(|i| i.fx.clone()).collect();
                    let at = self.a.0.chain.iter().position(|i| Some(i.id) == moved);
                    at.map(|at| Edit::Move(fx, kept(&now[..at])))
                }
                other => Some(other),
            };
            if let Some(e) = for_reference {
                Self::send(&mut self.reference, e);
            }
            // Whatever was loaded: the reference never keeps a pitch effect.
            let pitch: Vec<u32> = (self.reference.0.chain.iter())
                .filter(|i| is_pitch(&i.fx))
                .map(|i| i.id)
                .collect();
            for id in pitch {
                let c = self.reference.0.remove_insert(id).unwrap();
                self.reference.1.apply(c, &mut |_g| {});
            }
        }

        /// Apply one edit, check the chains, render `settle + BLOCKS` blocks and compare the
        /// last `BLOCKS`. Returns the largest difference between the monitor bus and what it
        /// must carry: the reference's main bus while the option is on, its own main bus
        /// while it is off.
        fn step(&mut self, e: Edit, settle: usize) -> f32 {
            self.apply(e);
            let on = self.a.0.mix.monitor_untuned;
            // The chains themselves: the main chain is the session's chain, the monitor chain
            // is the same list without the pitch effects — ids, order, enabled, every value.
            let all: Shape = (self.a.0.chain.iter())
                .map(|i| {
                    let params = i.params.iter().map(|p| p.1).collect();
                    (i.id, i.fx.clone(), i.enabled, params)
                })
                .collect();
            assert_eq!(shape(self.a.1.chain()), all, "{e:?}: main chain");
            let want: Shape = all.into_iter().filter(|i| !is_pitch(&i.1)).collect();
            assert_eq!(
                self.a.1.monitor_chain().map(shape),
                on.then_some(want),
                "{e:?}: monitor chain"
            );
            let mut worst = 0.0f32;
            for k in 0..settle + Self::BLOCKS {
                if self.a.1.monitor_fresh() {
                    self.restart_reference();
                }
                let input = signal(self.t, 128);
                self.t += 128;
                let ref_input: Vec<f32> =
                    (input.iter().map(|x| x * self.reference_in.next())).collect();
                let (main, mon) = render(&mut self.a.1, &input);
                let (plain_main, plain_mon) = render(&mut self.plain.1, &input);
                let (ref_main, _) = render(&mut self.reference.1, &ref_input);
                self.ledger.collect(&mut self.a.1);
                assert!(
                    main == plain_main,
                    "{e:?}: the main bus changed (block {k})"
                );
                assert!(plain_main == plain_mon, "{e:?}: plain twin");
                if k < settle {
                    continue;
                }
                self.untuned_blocks += usize::from(mon != main);
                // On: the reference. Off: the main bus.
                let want = if on { &ref_main } else { &main };
                let diff = (mon.iter().zip(want)).map(|(x, y)| (x - y).abs());
                worst = diff.fold(worst, f32::max);
            }
            self.ledger.assert_balanced(&self.a.1);
            worst
        }
    }

    /// Every way the chain can change — a parameter, on/off, add, remove, move, a preset, the
    /// setlist with its song key and tempo, MIDI, the panic button, the option itself — keeps
    /// the monitor chain equal to "the main chain without the pitch effects". After each edit:
    /// the two chains are compared insert by insert, the monitor bus is compared with a
    /// reference engine running that chain as its main chain (sample for sample: both run the
    /// same code on the same input, so they must agree exactly), the main bus is compared with
    /// an engine that never used the option, and every box sent to the audio thread is
    /// accounted for.
    #[test]
    fn untuned_monitor_chain_follows_every_edit() {
        use Edit::*;
        // On in the middle of a song: the old chain fades out first if there is one (4 blocks),
        // the new one runs unheard for 50 ms, then a 10 ms crossfade: 2881 samples, 23 blocks.
        const SWITCH: usize = 4 + 23;
        // Off: 10 ms crossfade back to the main bus (4 blocks).
        const FADE: usize = 4;
        let learn =
            r#"{"type":"midi_learn","target":{"kind":"param","fx":"reverb","param":"mix"}}"#;
        let steps: &[(Edit, usize)] = &[
            (Untuned(true), SWITCH), // on before anything is loaded
            (Load("Pop Polish"), 0), // eq deesser compressor AUTOTUNE doubler delay reverb limiter
            (Param("reverb", "mix", 0.6), 0),
            (Param("delay", "feedback", 0.6), 0),
            (Param("autotune", "retune", 5.0), 0), // a pitch effect: main chain only
            (Enable("compressor", false), 0),
            (Enable("compressor", true), 0),
            (Enable("autotune", false), 0),
            (Enable("autotune", true), 0),
            (Add("chorus", 0), 0),
            (Add("saturator", 4), 0),  // right before the autotune
            (Add("gate", 6), 0),       // right after it
            (Add("harmonizer", 6), 0), // a second pitch effect next to the first
            (Add("chorus", 6), 0),     // between the two pitch effects
            (Add("limiter", 99), 0),   // past the end
            (Remove("doubler"), 0),
            (Remove("harmonizer"), 0),
            (Move("reverb", 0), 0),     // across the autotune to the front
            (Move("saturator", 99), 0), // across it to the end
            (Move("gate", 2), 0),
            (Move("autotune", 0), 0), // the pitch effect itself
            (Move("compressor", 5), 0),
            (Load("Harmony Stack"), 0), // scene change: both chains, both tails
            (Goto(0, 1), 0),            // setlist: Pop Polish, song key (pitch effects), tempo
            (Next, 0),                  // Hard Snap
            (Prev, 0),
            (Message(learn), 0),
            (Midi(&[0xB0, 4, 10]), 0),  // the pedal is learned
            (Midi(&[0xB0, 4, 100]), 0), // the pedal moves the reverb mix
            (Midi(&[0xC0, 1]), 0),      // program change: Natural Vocal
            (Panic, 0),                 // reset
            (Next, 0),
            (Next, 0), // Hard Snap: eq compressor AUTOTUNE delay reverb limiter
            (Untuned(false), FADE),
            (Param("delay", "mix", 0.4), 0), // edits while the option is off ...
            (Add("saturator", 1), 0),
            (Enable("compressor", false), 0),
            (Add("chorus", 2), 0),
            (Untuned(true), SWITCH), // ... are in the chain built when it goes on again
            (Param("reverb", "mix", 0.3), 0),
            (Add("gate", 3), 0),
            (Move("delay", 0), 0),
            (Remove("saturator"), 0),
            // Off and on again inside the fade: the new chain takes over once the old one has
            // faded out.
            (OffOn, SWITCH),
            (Param("delay", "mix", 0.1), 0),
            (Move("chorus", 99), 0),
            (Load("Ballad Hall"), 0),
            (Load("Speech / MC"), 0),
            (Untuned(false), FADE),
        ];
        let mut rig = Rig::new();
        let mut report = Vec::new();
        for (e, settle) in steps {
            let worst = rig.step(*e, *settle);
            report.push(format!("{worst:.1e}  {e:?}"));
            assert!(worst == 0.0, "monitor bus vs reference: {report:#?}");
        }
        assert!(
            rig.untuned_blocks > 1000,
            "the monitor bus hardly ever differed from the main bus: {}",
            rig.untuned_blocks
        );
        // With `-- --nocapture`: the largest difference after each edit.
        println!("monitor bus vs reference, largest difference per edit:\n{report:#?}");
    }

    /// Option never touched: the session sends what it always sent.
    #[test]
    fn untuned_off_sends_the_commands_it_always_sent() {
        let mut s = Session::new(48000.0, 128);
        assert!(!s.mix.monitor_untuned);
        assert!(matches!(
            s.load_preset("Pop Polish").unwrap(),
            Command::SwapChain { .. }
        ));
        assert!(matches!(
            s.add_insert("chorus", 0).unwrap(),
            Command::AddInsert { .. }
        ));
        let cmds = s.set_mix(|m| m.mute = true);
        assert!(matches!(cmds.as_slice(), [Command::Mute(true)]));
        // "Off" when it is off: nothing to send, nothing changed.
        let r0 = s.revision;
        assert!(s.set_mix(|m| m.monitor_untuned = false).is_empty());
        assert_eq!(s.revision, r0);
    }

    /// Option on: a preset load is still ONE command (callers of `load_preset` send exactly
    /// one), and it carries the monitor chain; a new insert comes with its monitor copy unless
    /// it is a pitch effect.
    #[test]
    fn untuned_on_sends_the_monitor_chain_with_each_change() {
        let ids = |c: &Chain| c.inserts.iter().map(|i| i.id).collect::<Vec<_>>();
        let fx = |c: &Chain| c.inserts.iter().map(|i| i.kind.id()).collect::<Vec<_>>();
        let mut s = Session::new(48000.0, 128);
        s.load_preset("Pop Polish").unwrap();
        let r0 = s.revision;
        let cmds = s.set_mix(|m| m.monitor_untuned = true);
        assert!(s.revision > r0, "clients must hear about it");
        match cmds.as_slice() {
            [Command::SetMonitorChain { chain: Some(c) }] => {
                // Pop Polish is ids 1..=8 with the autotune at 4.
                assert_eq!(ids(c), [1, 2, 3, 5, 6, 7, 8]);
                assert!(!fx(c).contains(&"autotune"));
                // Room to add inserts on the audio thread without allocating.
                assert!(c.inserts.capacity() >= live_dsp::chain::MAX_INSERTS);
            }
            _ => panic!("expected one SetMonitorChain"),
        }
        // On when it is on: nothing.
        assert!(s.set_mix(|m| m.monitor_untuned = true).is_empty());
        match s.load_preset("Harmony Stack").unwrap() {
            Command::SwapChains { chain, monitor } => {
                assert_eq!(
                    fx(&chain),
                    [
                        "eq",
                        "compressor",
                        "autotune",
                        "harmonizer",
                        "reverb",
                        "limiter"
                    ]
                );
                assert_eq!(fx(&monitor), ["eq", "compressor", "reverb", "limiter"]);
                assert_eq!(ids(&chain), [9, 10, 11, 12, 13, 14]);
                assert_eq!(ids(&monitor), [9, 10, 13, 14]);
                assert!(monitor.inserts.capacity() >= live_dsp::chain::MAX_INSERTS);
            }
            _ => panic!("expected SwapChains"),
        }
        match s.add_insert("delay", 1).unwrap() {
            Command::AddInsertBoth {
                at,
                insert,
                monitor,
            } => assert_eq!((at, insert.id, monitor.id), (1, 15, 15)),
            _ => panic!("expected AddInsertBoth"),
        }
        assert!(matches!(
            s.add_insert("harmonizer", 0).unwrap(),
            Command::AddInsert { .. }
        ));
        let cmds = s.set_mix(|m| m.monitor_untuned = false);
        assert!(matches!(
            cmds.as_slice(),
            [Command::SetMonitorChain { chain: None }]
        ));
        assert!(matches!(
            s.load_preset("Pop Polish").unwrap(),
            Command::SwapChain { .. }
        ));
    }

    /// `SessionState` carries `mix.monitor_untuned`; a state written before the field existed
    /// still parses (off).
    #[test]
    fn untuned_is_in_the_session_state() {
        let mut s = Session::new(48000.0, 128);
        let v = serde_json::to_value(s.state()).unwrap();
        assert_eq!(v["mix"]["monitor_untuned"], serde_json::json!(false));
        s.set_mix(|m| m.monitor_untuned = true);
        let mut v = serde_json::to_value(s.state()).unwrap();
        assert_eq!(v["mix"]["monitor_untuned"], serde_json::json!(true));
        let back: SessionState = serde_json::from_value(v.clone()).unwrap();
        assert!(back.mix.monitor_untuned);
        v["mix"].as_object_mut().unwrap().remove("monitor_untuned");
        let old: SessionState = serde_json::from_value(v).unwrap();
        assert!(!old.mix.monitor_untuned);
        assert_eq!(MixState::default(), old_mix());
    }

    /// The mix as a client that predates the option writes it.
    fn old_mix() -> MixState {
        serde_json::from_str(
            r#"{"input_db":0.0,"main_db":0.0,"monitor_db":0.0,"monitor_dry":0.0,"bypass":false,"mute":false}"#,
        )
        .unwrap()
    }
}
