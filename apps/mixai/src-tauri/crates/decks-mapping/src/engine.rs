//! Runtime: raw MIDI in → [`Action`]s, engine state → LED / meter MIDI out.
//!
//! Single-threaded and allocation-light; the host owns threading (call from the MIDI callback
//! thread or forward bytes to a worker). Timestamps are microseconds on the host's clock.

use std::collections::{HashMap, HashSet};

use crate::action::{Action, ClockAction, DeckAction, FxAction, PadMode, SamplerAction};
use crate::clock::{ClockFollower, ClockGenerator, FollowEvent, FollowState, PPQN};
use crate::format::{
    Binding, FeedbackKey, FormatError, InputKind, MappingFile, OutMessage, OutputKind, Trigger,
    parse_sysex_pattern, sysex_matches,
};
use crate::groove::{GroovePattern, GrooveRecorder};
use crate::learn::{LearnProposal, MidiLearn};
use crate::message::{MidiMessage, StreamParser};
use crate::scale::{ScaleMode, scale_lock};
use crate::script::{ScriptError, ScriptRuntime};

/// An action with its source context (for hosts that need timing / provenance).
#[derive(Debug, Clone, PartialEq)]
pub struct ActionEvent {
    pub action: Action,
    pub timestamp_us: u64,
    pub port: String,
}

/// Outgoing MIDI (LEDs, meters, clock).
#[derive(Debug, Clone, PartialEq)]
pub struct MidiOut {
    pub bytes: Vec<u8>,
    /// Exact due time for scheduled messages (clock ticks); `None` = send now.
    pub at_us: Option<f64>,
}

impl MidiOut {
    fn now(bytes: Vec<u8>) -> Self {
        Self { bytes, at_us: None }
    }
}

/// Value of one piece of engine state for feedback.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FeedbackValue {
    On(bool),
    /// 0..=1 (meters, jog ring).
    Level(f32),
    /// Colour index, `None` = off.
    Colour(Option<u8>),
}

/// Source of engine state for [`MappingEngine::feedback`].
pub trait FeedbackProvider {
    fn get(&self, key: &FeedbackKey) -> Option<FeedbackValue>;
}

/// Simple map-backed feedback state.
#[derive(Debug, Clone, Default)]
pub struct FeedbackState(pub HashMap<FeedbackKey, FeedbackValue>);

impl FeedbackState {
    pub fn set(&mut self, key: FeedbackKey, value: FeedbackValue) {
        self.0.insert(key, value);
    }
}

impl FeedbackProvider for FeedbackState {
    fn get(&self, key: &FeedbackKey) -> Option<FeedbackValue> {
        self.0.get(key).copied()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error(transparent)]
    Format(#[from] FormatError),
    #[error(transparent)]
    Script(#[from] ScriptError),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Ev {
    Button {
        pressed: bool,
        velocity: f32,
        note: Option<u8>,
    },
    Absolute(f32),
    Relative(f32),
    Program(u8),
    Fire,
}

#[derive(Debug, Clone, Copy, Default)]
struct NrpnState {
    param_msb: Option<u8>,
    param_lsb: Option<u8>,
    data_msb: u8,
}

#[derive(Debug, Clone, Copy)]
struct Takeover {
    engine_value: f32,
    picked_up: bool,
    last_hw: Option<f32>,
}

/// Soft-takeover pickup window in output units, as a fraction of the binding's range span.
const TAKEOVER_WINDOW: f32 = 0.03;

/// The mapping runtime for one connected device.
#[derive(Debug)]
pub struct MappingEngine {
    mapping: MappingFile,
    input_index: HashMap<String, usize>,
    sysex_patterns: HashMap<usize, Vec<Option<u8>>>,
    bindings_by_input: HashMap<String, Vec<usize>>,
    modifier_inputs: HashMap<String, Vec<usize>>,
    layer_inputs: HashMap<String, usize>,
    modifiers: HashSet<String>,
    layer_pos: HashMap<u8, usize>,
    pad_modes: HashMap<u8, PadMode>,
    jog_touched: HashSet<u8>,
    cc14_msb: HashMap<(u8, u8), u8>,
    nrpn: [NrpnState; 16],
    abs_button: HashMap<String, bool>,
    rel_accum: HashMap<String, f32>,
    takeover: HashMap<String, Takeover>,
    track_key: Option<(u8, ScaleMode)>,
    parser: StreamParser,
    script: Option<ScriptRuntime>,
    script_errors: Vec<ScriptError>,
    pending_out: Vec<MidiOut>,
    last_sent: HashMap<String, Vec<u8>>,
    learn: Option<(MidiLearn, Option<Action>)>,
    learned: Option<LearnProposal>,
    learned_target: Option<Action>,
    follower: ClockFollower,
    last_bpm: Option<f64>,
    generator: Option<ClockGenerator>,
    groove: Option<GrooveRecorder>,
    groove_armed: bool,
    beat_position: f64,
}

impl MappingEngine {
    /// Validate the mapping and compile it (including its script, if any).
    pub fn new(mapping: MappingFile) -> Result<Self, EngineError> {
        mapping.validate()?;
        let script = match &mapping.script {
            Some(s) => Some(ScriptRuntime::new(
                &s.source,
                s.max_operations,
                s.max_millis,
            )?),
            None => None,
        };
        let groove = mapping
            .groove
            .as_ref()
            .map(|g| GrooveRecorder::new(g.bars, g.quantize_ticks, g.channels.clone()));
        let generator = mapping
            .clock
            .filter(|c| c.send)
            .map(|_| ClockGenerator::new(120.0));
        let mut e = Self {
            mapping,
            input_index: HashMap::new(),
            sysex_patterns: HashMap::new(),
            bindings_by_input: HashMap::new(),
            modifier_inputs: HashMap::new(),
            layer_inputs: HashMap::new(),
            modifiers: HashSet::new(),
            layer_pos: HashMap::new(),
            pad_modes: HashMap::new(),
            jog_touched: HashSet::new(),
            cc14_msb: HashMap::new(),
            nrpn: [NrpnState::default(); 16],
            abs_button: HashMap::new(),
            rel_accum: HashMap::new(),
            takeover: HashMap::new(),
            track_key: None,
            parser: StreamParser::new(),
            script,
            script_errors: Vec::new(),
            pending_out: Vec::new(),
            last_sent: HashMap::new(),
            learn: None,
            learned: None,
            learned_target: None,
            follower: ClockFollower::default(),
            last_bpm: None,
            generator,
            groove,
            groove_armed: false,
            beat_position: 0.0,
        };
        e.reindex();
        Ok(e)
    }

    fn reindex(&mut self) {
        self.input_index.clear();
        self.sysex_patterns.clear();
        self.bindings_by_input.clear();
        self.modifier_inputs.clear();
        self.layer_inputs.clear();
        for (i, inp) in self.mapping.inputs.iter().enumerate() {
            self.input_index.insert(inp.id.clone(), i);
            if let InputKind::Sysex { pattern } = &inp.kind {
                if let Some(p) = parse_sysex_pattern(pattern) {
                    self.sysex_patterns.insert(i, p);
                }
            }
        }
        for (i, b) in self.mapping.bindings.iter().enumerate() {
            self.bindings_by_input
                .entry(b.input.clone())
                .or_default()
                .push(i);
        }
        for (i, m) in self.mapping.modifiers.iter().enumerate() {
            if let Some(inp) = &m.input {
                self.modifier_inputs.entry(inp.clone()).or_default().push(i);
            }
        }
        for (i, l) in self.mapping.deck_layers.iter().enumerate() {
            if let Some(inp) = &l.input {
                self.layer_inputs.insert(inp.clone(), i);
            }
        }
    }

    pub fn mapping(&self) -> &MappingFile {
        &self.mapping
    }

    // ---- host-side state -----------------------------------------------------------------

    /// Set / clear a modifier (virtual modifiers, or forcing a hardware one).
    pub fn set_modifier(&mut self, id: &str, on: bool) {
        if on {
            self.modifiers.insert(id.to_string());
        } else {
            self.modifiers.remove(id);
        }
    }

    pub fn modifier(&self, id: &str) -> bool {
        self.modifiers.contains(id)
    }

    /// Current deck targeted by a physical side.
    pub fn side_deck(&self, side: u8) -> Option<u8> {
        let layer = self.mapping.deck_layers.iter().find(|l| l.side == side)?;
        let pos = self.layer_pos.get(&side).copied().unwrap_or(0);
        layer.decks.get(pos % layer.decks.len()).copied()
    }

    /// Point a physical side at one of its layer's decks.
    pub fn set_side_deck(&mut self, side: u8, deck: u8) {
        if let Some(layer) = self.mapping.deck_layers.iter().find(|l| l.side == side) {
            if let Some(pos) = layer.decks.iter().position(|&d| d == deck) {
                self.layer_pos.insert(side, pos);
            }
        }
    }

    pub fn pad_mode(&self, deck: u8) -> Option<PadMode> {
        self.pad_modes.get(&deck).copied()
    }

    pub fn set_pad_mode(&mut self, deck: u8, mode: PadMode) {
        self.pad_modes.insert(deck, mode);
    }

    /// Key of the playing track for scale-locked bindings that follow it.
    pub fn set_track_key(&mut self, key_pitchclass: u8, mode: ScaleMode) {
        self.track_key = Some((key_pitchclass % 12, mode));
    }

    pub fn clear_track_key(&mut self) {
        self.track_key = None;
    }

    /// Tell soft takeover the engine's current value of a target (deck switch, UI change, …).
    /// `action` carries the value (e.g. `Mixer(Volume{channel:0, value:0.8})`).
    pub fn sync_value(&mut self, action: &Action) {
        let mut a = action.clone();
        let Some(v) = a.value_mut().map(|v| *v) else {
            return;
        };
        let key = action.target_key();
        let t = self.takeover.entry(key).or_insert(Takeover {
            engine_value: v,
            picked_up: false,
            last_hw: None,
        });
        if (t.engine_value - v).abs() > f32::EPSILON {
            t.picked_up = false;
        }
        t.engine_value = v;
    }

    /// Host beat position (beats since the groove pattern start) for groove recording when the
    /// device is not the clock source.
    pub fn set_beat_position(&mut self, beats: f64) {
        self.beat_position = beats;
    }

    /// Arm / disarm groove recording.
    pub fn set_groove_recording(&mut self, on: bool) {
        self.groove_armed = on && self.groove.is_some();
    }

    pub fn groove_pattern(&self) -> Option<&GroovePattern> {
        self.groove.as_ref().map(|g| g.pattern())
    }

    /// Finish recording: sorted pattern, recorder cleared.
    pub fn take_groove_pattern(&mut self) -> Option<GroovePattern> {
        let g = self.groove.as_mut()?;
        g.sort();
        let p = g.pattern().clone();
        g.clear();
        Some(p)
    }

    pub fn clock_follower(&self) -> &ClockFollower {
        &self.follower
    }

    /// Clock generator (present when the mapping's `clock.send` is true).
    pub fn clock_generator_mut(&mut self) -> Option<&mut ClockGenerator> {
        self.generator.as_mut()
    }

    /// Due clock messages to send to the device.
    pub fn clock_out(&mut self, now_us: f64) -> Vec<MidiOut> {
        let Some(g) = self.generator.as_mut() else {
            return Vec::new();
        };
        g.poll(now_us)
            .into_iter()
            .map(|e| MidiOut {
                bytes: e.message.to_bytes(),
                at_us: Some(e.at_us),
            })
            .collect()
    }

    /// Script errors since the last call (the script keeps running for later events).
    pub fn take_script_errors(&mut self) -> Vec<ScriptError> {
        std::mem::take(&mut self.script_errors)
    }

    // ---- MIDI learn ----------------------------------------------------------------------

    /// Capture the next control; `target` is the action to bind it to (or `None` to only
    /// identify the control). While learning, `on_midi` returns no actions.
    pub fn start_learn(&mut self, target: Option<Action>) {
        self.learn = Some((MidiLearn::new(), target));
        self.learned = None;
    }

    pub fn cancel_learn(&mut self) {
        self.learn = None;
    }

    pub fn is_learning(&self) -> bool {
        self.learn.is_some()
    }

    /// Finish a quiet gesture (call periodically while learning).
    pub fn poll_learn(&mut self, now_us: u64) -> Option<LearnProposal> {
        let (l, _) = self.learn.as_mut()?;
        let p = l.poll(now_us)?;
        self.complete_learn(p.clone());
        Some(p)
    }

    fn complete_learn(&mut self, p: LearnProposal) {
        let target = self.learn.take().and_then(|(_, t)| t);
        self.learned = Some(p);
        self.learned_target = target;
    }

    /// The proposed binding for the last learned control (`None` without a target).
    pub fn learned_binding(&self) -> Option<(crate::format::InputDef, Binding)> {
        let p = self.learned.as_ref()?;
        let target = self.learned_target.clone()?;
        let mut id = p.id.clone();
        let mut n = 2;
        while self.input_index.contains_key(&id) {
            id = format!("{}#{n}", p.id);
            n += 1;
        }
        let input = crate::format::InputDef {
            id: id.clone(),
            channel: p.channel,
            kind: p.kind.clone(),
        };
        let mut b = Binding::new(id, target);
        // Absolute controls picked up mid-range should not jump the engine value.
        b.soft_takeover = matches!(
            p.kind,
            InputKind::Cc { relative: None, .. } | InputKind::Cc14 { .. } | InputKind::PitchBend
        ) && b.action.clone().value_mut().is_some();
        Some((input, b))
    }

    /// Add a learned (or any) input + binding to the live mapping.
    pub fn add_binding(
        &mut self,
        input: crate::format::InputDef,
        binding: Binding,
    ) -> Result<(), FormatError> {
        let mut m = self.mapping.clone();
        if !m.inputs.iter().any(|i| i.id == input.id) {
            m.inputs.push(input);
        }
        m.bindings.push(binding);
        m.validate()?;
        self.mapping = m;
        self.reindex();
        Ok(())
    }

    // ---- input path ----------------------------------------------------------------------

    /// Feed raw bytes from `port` (one or more complete or partial messages).
    pub fn on_midi(&mut self, port: &str, bytes: &[u8], timestamp_us: u64) -> Vec<Action> {
        self.on_midi_events(port, bytes, timestamp_us)
            .into_iter()
            .map(|e| e.action)
            .collect()
    }

    /// Like [`Self::on_midi`] but with provenance.
    pub fn on_midi_events(&mut self, port: &str, bytes: &[u8], ts: u64) -> Vec<ActionEvent> {
        let msgs = self.parser.feed(bytes);
        let mut out = Vec::new();
        for m in msgs {
            for action in self.on_message(port, &m, ts) {
                out.push(ActionEvent {
                    action,
                    timestamp_us: ts,
                    port: port.to_string(),
                });
            }
        }
        out
    }

    /// Process one decoded message (e.g. from the BLE decoder).
    pub fn on_message(&mut self, port: &str, msg: &MidiMessage, ts: u64) -> Vec<Action> {
        if let Some((learn, _)) = self.learn.as_mut() {
            if let Some(p) = learn.push(msg, ts) {
                self.complete_learn(p);
            }
            return Vec::new();
        }
        let mut out = Vec::new();

        // Clock follower.
        if self.mapping.clock.is_some_and(|c| c.receive) {
            if let Some(ev) = self.follower.on_message(msg, ts as f64) {
                match ev {
                    FollowEvent::Started => out.push(Action::Clock(ClockAction::Start)),
                    FollowEvent::Stopped => out.push(Action::Clock(ClockAction::Stop)),
                    FollowEvent::Continued => out.push(Action::Clock(ClockAction::Continue)),
                    FollowEvent::SongPosition(p) => {
                        out.push(Action::Clock(ClockAction::SongPosition { sixteenths: p }))
                    }
                    FollowEvent::Tick { bpm: Some(bpm) } => {
                        if self.last_bpm.is_none_or(|b| (b - bpm).abs() >= 0.05) {
                            self.last_bpm = Some(bpm);
                            out.push(Action::Clock(ClockAction::Tempo { bpm: bpm as f32 }));
                        }
                    }
                    FollowEvent::Tick { bpm: None } => {}
                }
            }
        }

        // Groove lane.
        if self.groove_armed {
            let pos = if self.follower.state() == FollowState::Running {
                self.follower.ticks_since_start() as f64 / f64::from(PPQN)
            } else {
                self.beat_position
            };
            if let Some(g) = self.groove.as_mut() {
                match *msg {
                    MidiMessage::NoteOn {
                        channel,
                        note,
                        velocity,
                    } => g.note_on(channel + 1, note, velocity, pos),
                    MidiMessage::NoteOff { channel, note, .. } => {
                        g.note_off(channel + 1, note, pos)
                    }
                    _ => {}
                }
            }
        }

        // Script hook.
        if let Some(s) = self.script.as_mut() {
            match s.on_midi(port, msg, ts) {
                Ok(o) => {
                    out.extend(o.actions);
                    self.pending_out
                        .extend(o.midi.into_iter().map(MidiOut::now));
                    if o.handled {
                        self.track_state(&out);
                        return out;
                    }
                }
                Err(e) => self.script_errors.push(e),
            }
        }

        // Regular bindings.
        for idx in 0..self.mapping.inputs.len() {
            let Some(ev) = self.match_input(idx, msg) else {
                continue;
            };
            let id = self.mapping.inputs[idx].id.clone();
            self.apply_modifiers_and_layers(&id, ev);
            let actions = self.fire_bindings(&id, idx, ev);
            self.track_state(&actions);
            out.extend(actions);
        }
        out
    }

    fn match_input(&mut self, idx: usize, msg: &MidiMessage) -> Option<Ev> {
        let inp = &self.mapping.inputs[idx];
        let want_ch = inp.channel.map(|c| c - 1);
        if let (Some(w), Some(c)) = (want_ch, msg.channel()) {
            if w != c {
                return None;
            }
        }
        match (&inp.kind, msg) {
            (
                InputKind::Note { note },
                MidiMessage::NoteOn {
                    note: n, velocity, ..
                },
            ) if n == note => Some(Ev::Button {
                pressed: true,
                velocity: f32::from(*velocity) / 127.0,
                note: Some(*n),
            }),
            (InputKind::Note { note }, MidiMessage::NoteOff { note: n, .. }) if n == note => {
                Some(Ev::Button {
                    pressed: false,
                    velocity: 0.0,
                    note: Some(*n),
                })
            }
            (
                InputKind::NoteRange { first, last },
                MidiMessage::NoteOn {
                    note: n, velocity, ..
                },
            ) if (*first..=*last).contains(n) => Some(Ev::Button {
                pressed: true,
                velocity: f32::from(*velocity) / 127.0,
                note: Some(*n),
            }),
            (InputKind::NoteRange { first, last }, MidiMessage::NoteOff { note: n, .. })
                if (*first..=*last).contains(n) =>
            {
                Some(Ev::Button {
                    pressed: false,
                    velocity: 0.0,
                    note: Some(*n),
                })
            }
            (
                InputKind::Cc { cc, relative },
                MidiMessage::ControlChange {
                    controller, value, ..
                },
            ) if controller == cc => Some(match relative {
                Some(enc) => Ev::Relative(enc.decode(*value) as f32),
                None => Ev::Absolute(f32::from(*value) / 127.0),
            }),
            (
                InputKind::Jog { cc, encoding },
                MidiMessage::ControlChange {
                    controller, value, ..
                },
            ) if controller == cc => Some(Ev::Relative(encoding.decode(*value) as f32)),
            (
                InputKind::Cc14 { msb, lsb },
                MidiMessage::ControlChange {
                    channel,
                    controller,
                    value,
                },
            ) => {
                if controller == msb {
                    self.cc14_msb.insert((*channel, *msb), *value);
                    None
                } else if controller == lsb {
                    let hi = self.cc14_msb.get(&(*channel, *msb)).copied().unwrap_or(0);
                    let v = (u16::from(hi) << 7) | u16::from(*value);
                    Some(Ev::Absolute(f32::from(v) / 16383.0))
                } else {
                    None
                }
            }
            (
                InputKind::Nrpn { param, high_res },
                MidiMessage::ControlChange {
                    channel,
                    controller,
                    value,
                },
            ) => {
                let (param, high_res) = (*param, *high_res);
                let st = &mut self.nrpn[usize::from(*channel & 0x0F)];
                match controller {
                    99 => st.param_msb = Some(*value),
                    98 => st.param_lsb = Some(*value),
                    _ => {}
                }
                let current = match (st.param_msb, st.param_lsb) {
                    (Some(m), Some(l)) => Some((u16::from(m) << 7) | u16::from(l)),
                    _ => None,
                };
                if current != Some(param) {
                    return None;
                }
                match controller {
                    6 => {
                        st.data_msb = *value;
                        (!high_res).then_some(Ev::Absolute(f32::from(*value) / 127.0))
                    }
                    38 if high_res => {
                        let v = (u16::from(st.data_msb) << 7) | u16::from(*value);
                        Some(Ev::Absolute(f32::from(v) / 16383.0))
                    }
                    96 => Some(Ev::Relative(1.0)),
                    97 => Some(Ev::Relative(-1.0)),
                    _ => None,
                }
            }
            (InputKind::PitchBend, MidiMessage::PitchBend { value, .. }) => {
                Some(Ev::Absolute(f32::from(*value) / 16383.0))
            }
            (
                InputKind::ProgramChange { first, last },
                MidiMessage::ProgramChange { program, .. },
            ) if (*first..=*last).contains(program) => Some(Ev::Program(program - first)),
            (InputKind::Sysex { .. }, MidiMessage::SysEx(bytes)) => self
                .sysex_patterns
                .get(&idx)
                .filter(|p| sysex_matches(p, bytes))
                .map(|_| Ev::Fire),
            _ => None,
        }
    }

    fn apply_modifiers_and_layers(&mut self, input_id: &str, ev: Ev) {
        let pressed = match ev {
            Ev::Button { pressed, .. } => Some(pressed),
            Ev::Absolute(v) => Some(v >= 0.5),
            _ => None,
        };
        let Some(pressed) = pressed else { return };
        if let Some(mods) = self.modifier_inputs.get(input_id).cloned() {
            for mi in mods {
                let (id, toggle) = {
                    let m = &self.mapping.modifiers[mi];
                    (m.id.clone(), m.toggle)
                };
                if toggle {
                    if pressed {
                        let on = !self.modifiers.contains(&id);
                        self.set_modifier(&id, on);
                    }
                } else {
                    self.set_modifier(&id, pressed);
                }
            }
        }
        if pressed {
            if let Some(&li) = self.layer_inputs.get(input_id) {
                let side = self.mapping.deck_layers[li].side;
                let n = self.mapping.deck_layers[li].decks.len();
                let pos = self.layer_pos.entry(side).or_insert(0);
                *pos = (*pos + 1) % n.max(1);
            }
        }
    }

    fn condition_holds(&self, b: &Binding, action: &Action) -> bool {
        if !b.when.modifiers.iter().all(|m| self.modifiers.contains(m)) {
            return false;
        }
        if b.when.exact && self.modifiers.len() != b.when.modifiers.len() {
            return false;
        }
        if let Some(mode) = b.when.pad_mode {
            let mut a = action.clone();
            let deck = a.deck_mut().map(|d| *d);
            if deck.and_then(|d| self.pad_modes.get(&d)).copied() != Some(mode) {
                return false;
            }
        }
        true
    }

    fn resolve_side(&self, b: &Binding, action: &mut Action) {
        if let Some(side) = b.side {
            if let Some(deck) = self.side_deck(side) {
                if let Some(d) = action.deck_mut() {
                    *d = deck;
                }
            }
        }
    }

    fn fire_bindings(&mut self, input_id: &str, idx: usize, ev: Ev) -> Vec<Action> {
        let Some(list) = self.bindings_by_input.get(input_id).cloned() else {
            return Vec::new();
        };
        let mut candidates: Vec<(usize, Action)> = Vec::new();
        for bi in list {
            let b = &self.mapping.bindings[bi];
            let mut action = b.action.clone();
            self.resolve_side(b, &mut action);
            if self.condition_holds(b, &action) {
                candidates.push((bi, action));
            }
        }
        let best = candidates
            .iter()
            .map(|(bi, _)| self.mapping.bindings[*bi].when.modifiers.len())
            .max()
            .unwrap_or(0);
        let first_note = match self.mapping.inputs[idx].kind {
            InputKind::NoteRange { first, .. } => Some(first),
            _ => None,
        };
        let mut out = Vec::new();
        for (bi, action) in candidates {
            let b = self.mapping.bindings[bi].clone();
            if b.when.modifiers.len() != best {
                continue;
            }
            if let Some(a) = self.build_action(&b, action, ev, first_note) {
                out.push(a);
            }
        }
        out
    }

    fn build_action(
        &mut self,
        b: &Binding,
        mut action: Action,
        ev: Ev,
        first_note: Option<u8>,
    ) -> Option<Action> {
        let t = b.transform;
        match ev {
            Ev::Button {
                pressed,
                velocity,
                note,
            } => {
                let momentary = action.is_momentary();
                let fire = match b.trigger {
                    Trigger::Auto => pressed || momentary || action.clone().value_mut().is_some(),
                    Trigger::Press => pressed,
                    Trigger::Release => !pressed,
                    Trigger::Both => true,
                };
                if !fire {
                    return None;
                }
                if let Some(p) = action.pressed_mut() {
                    *p = pressed;
                }
                if let Some(v) = action.value_mut() {
                    *v = t.absolute(velocity);
                }
                if let (Some(n), Some(first)) = (note, first_note) {
                    let offset = n.saturating_sub(first);
                    match &mut action {
                        Action::Sampler(SamplerAction::Trigger { slot, .. })
                        | Action::Deck(DeckAction::HotCue { slot, .. }) => {
                            *slot = slot.saturating_add(offset);
                        }
                        _ => {}
                    }
                }
                if let (Some(n), Some(slot)) = (note, action.note_mut()) {
                    *slot = match b.scale_lock {
                        Some(sl) => {
                            let (key, mode) = if sl.follow_track_key {
                                self.track_key.unwrap_or((sl.key % 12, sl.mode))
                            } else {
                                (sl.key % 12, sl.mode)
                            };
                            scale_lock(n, key, mode)
                        }
                        None => n,
                    };
                }
                Some(action)
            }
            Ev::Absolute(x) => {
                let key = action.target_key();
                if action.clone().value_mut().is_some() {
                    let y = t.absolute(x);
                    if b.soft_takeover && !self.takeover_allows(&key, y, t.range) {
                        return None;
                    }
                    if let Some(v) = action.value_mut() {
                        *v = y;
                    }
                    return Some(action);
                }
                // Value-less action on an absolute control: edge-triggered switch.
                let pressed = x >= 0.5;
                let prev = self
                    .abs_button
                    .insert(format!("{}|{key}", b.input), pressed);
                if prev == Some(pressed) {
                    return None;
                }
                if let Some(p) = action.pressed_mut() {
                    *p = pressed;
                    return Some(action);
                }
                pressed.then_some(action)
            }
            Ev::Relative(d) => {
                if d == 0.0 {
                    return None;
                }
                if let Some(slot) = action.delta_mut() {
                    *slot = t.relative(d);
                    if let Action::Deck(DeckAction::JogScratch { deck, delta }) = action {
                        if !self.jog_touched.contains(&deck) {
                            action = Action::Deck(DeckAction::JogBend { deck, delta });
                        }
                    }
                    return Some(action);
                }
                if action.clone().value_mut().is_some() {
                    // Relative encoder driving an absolute target: accumulate in 0..1.
                    let key = action.target_key();
                    let start = self
                        .takeover
                        .get(&key)
                        .map(|tk| normalise(tk.engine_value, t.range))
                        .unwrap_or(0.5);
                    let acc = self.rel_accum.entry(key).or_insert(start);
                    *acc = (*acc + t.relative(d) / 128.0).clamp(0.0, 1.0);
                    let y = t.range[0] + (t.range[1] - t.range[0]) * t.curve.apply(*acc);
                    if let Some(v) = action.value_mut() {
                        *v = y;
                    }
                    return Some(action);
                }
                Some(action)
            }
            Ev::Program(i) => {
                if let Some(slot) = action.index_mut() {
                    *slot = i;
                }
                Some(action)
            }
            Ev::Fire => Some(action),
        }
    }

    fn takeover_allows(&mut self, key: &str, y: f32, range: [f32; 2]) -> bool {
        let Some(t) = self.takeover.get_mut(key) else {
            return true;
        };
        if t.picked_up {
            t.engine_value = y;
            t.last_hw = Some(y);
            return true;
        }
        let window = (range[1] - range[0]).abs() * TAKEOVER_WINDOW;
        let close = (y - t.engine_value).abs() <= window;
        let crossed = t
            .last_hw
            .is_some_and(|prev| (prev - t.engine_value).signum() != (y - t.engine_value).signum());
        t.last_hw = Some(y);
        if close || crossed {
            t.picked_up = true;
            t.engine_value = y;
            true
        } else {
            false
        }
    }

    /// Track engine-relevant state implied by emitted actions (pad mode, jog touch,
    /// soft-takeover values).
    fn track_state(&mut self, actions: &[Action]) {
        for a in actions {
            match a {
                Action::Deck(DeckAction::PadMode { deck, mode }) => {
                    self.pad_modes.insert(*deck, *mode);
                }
                Action::Deck(DeckAction::JogTouch { deck, pressed }) => {
                    if *pressed {
                        self.jog_touched.insert(*deck);
                    } else {
                        self.jog_touched.remove(deck);
                    }
                }
                Action::Fx(FxAction::Level { .. } | FxAction::Param { .. })
                | Action::Mixer(_)
                | Action::Deck(DeckAction::Tempo { .. }) => {
                    let mut c = a.clone();
                    if let Some(v) = c.value_mut().map(|v| *v) {
                        if let Some(t) = self.takeover.get_mut(&a.target_key()) {
                            t.engine_value = v;
                        }
                    }
                }
                _ => {}
            }
        }
    }

    // ---- output path ---------------------------------------------------------------------

    /// LED / meter messages for state that changed since the last call, plus script output.
    pub fn feedback(&mut self, state: &dyn FeedbackProvider) -> Vec<MidiOut> {
        self.feedback_inner(state, false)
    }

    /// Like [`Self::feedback`] but resends every output (after connect / deck switch).
    pub fn feedback_all(&mut self, state: &dyn FeedbackProvider) -> Vec<MidiOut> {
        self.feedback_inner(state, true)
    }

    fn feedback_inner(&mut self, state: &dyn FeedbackProvider, force: bool) -> Vec<MidiOut> {
        let mut out = std::mem::take(&mut self.pending_out);
        for o in &self.mapping.outputs {
            let mut key = o.source.clone();
            if let Some(side) = o.side {
                if let Some(deck) = self.side_deck(side) {
                    set_feedback_deck(&mut key, deck);
                }
            }
            let value = state.get(&key);
            let data2 = match (&o.kind, value) {
                (OutputKind::Led { on, off }, v) => {
                    if is_on(v) {
                        *on
                    } else {
                        *off
                    }
                }
                (OutputKind::Colour { .. }, Some(FeedbackValue::Colour(Some(c)))) => c & 0x7F,
                (OutputKind::Colour { off }, v) => {
                    if is_on(v) {
                        127
                    } else {
                        *off
                    }
                }
                (OutputKind::Meter { min, max }, v) => {
                    let lvl = match v {
                        Some(FeedbackValue::Level(l)) => l.clamp(0.0, 1.0),
                        v if is_on(v) => 1.0,
                        _ => 0.0,
                    };
                    let span = f32::from(*max) - f32::from(*min);
                    (f32::from(*min) + span * lvl).round().clamp(0.0, 127.0) as u8
                }
            };
            let status = match o.message {
                OutMessage::Note => 0x90,
                OutMessage::Cc => 0xB0,
            } | ((o.channel - 1) & 0x0F);
            let bytes = vec![status, o.number & 0x7F, data2];
            if force || self.last_sent.get(&o.id) != Some(&bytes) {
                self.last_sent.insert(o.id.clone(), bytes.clone());
                out.push(MidiOut::now(bytes));
            }
        }
        out
    }
}

fn is_on(v: Option<FeedbackValue>) -> bool {
    match v {
        Some(FeedbackValue::On(b)) => b,
        Some(FeedbackValue::Level(l)) => l > 0.0,
        Some(FeedbackValue::Colour(c)) => c.is_some(),
        None => false,
    }
}

fn normalise(v: f32, range: [f32; 2]) -> f32 {
    let span = range[1] - range[0];
    if span.abs() < f32::EPSILON {
        0.0
    } else {
        ((v - range[0]) / span).clamp(0.0, 1.0)
    }
}

fn set_feedback_deck(key: &mut FeedbackKey, new_deck: u8) {
    match key {
        FeedbackKey::Playing { deck }
        | FeedbackKey::CueIndicator { deck }
        | FeedbackKey::Sync { deck }
        | FeedbackKey::LoopActive { deck }
        | FeedbackKey::HotCueSet { deck, .. }
        | FeedbackKey::HotCueColour { deck, .. }
        | FeedbackKey::PadMode { deck, .. }
        | FeedbackKey::VinylMode { deck }
        | FeedbackKey::Loaded { deck }
        | FeedbackKey::JogPosition { deck } => *deck = new_deck,
        FeedbackKey::ChannelCue { channel } | FeedbackKey::Vu { channel } => *channel = new_deck,
        _ => {}
    }
}
