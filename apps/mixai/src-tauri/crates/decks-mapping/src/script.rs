//! Sandboxed per-mapping scripts on [`rhai`].
//!
//! Sandbox: rhai has no file / network / process API; the crate is built with `no_module`
//! (no `import`, no module resolver), `eval` is disabled, `print` / `debug` are swallowed, and
//! every call runs under an operation budget, a wall-time budget (checked from the progress
//! callback), call-depth / expression-depth limits and string / array / map size limits.
//!
//! Script API (all a script can touch):
//! * `fn on_midi(ev)` — called per incoming message. `ev` is a map:
//!   `#{ port, time, kind, channel, data1, data2, value, bytes }` (`channel` 1-based, 0 for
//!   system messages; `kind` = `"note_on" | "note_off" | "cc" | "pitch_bend" | "program" |
//!   "pressure" | "poly_pressure" | "sysex" | "clock" | "start" | "stop" | "continue" |
//!   "song_position" | "other"`; `value` = 14-bit for pitch bend / song position).
//!   Return `true` to consume the event (regular bindings are skipped).
//! * `emit(action_map)` — emit an [`Action`] written as its JSON shape, e.g.
//!   `emit(#{ deck: #{ type: "play_pause", deck: 0 } })`.
//! * `note(channel, note, velocity)`, `cc(channel, controller, value)`, `send(bytes_array)` —
//!   queue MIDI out (LEDs); delivered with the next `feedback()`.
//! * `get_state(key)` / `set_state(key, value)` — persistent per-mapping state (script
//!   functions cannot see global `let` variables in rhai).
//! * `fn init()` — optional, called once after the top level ran.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rhai::{
    AST, Array, CallFnOptions, Dynamic, Engine, EvalAltResult, ImmutableString, Map, Scope,
};

use crate::action::Action;
use crate::message::MidiMessage;

pub const DEFAULT_MAX_OPERATIONS: u64 = 100_000;
pub const DEFAULT_MAX_MILLIS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScriptError {
    #[error("script compile error: {0}")]
    Compile(String),
    #[error("script exceeded its operation budget ({0} operations)")]
    TooManyOperations(u64),
    #[error("script exceeded its time budget ({0} ms)")]
    Timeout(u64),
    #[error("script runtime error: {0}")]
    Runtime(String),
}

/// What one script call produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptOutput {
    pub actions: Vec<Action>,
    pub midi: Vec<Vec<u8>>,
    /// The script returned `true`: skip regular bindings for this event.
    pub handled: bool,
}

#[derive(Default)]
struct Sink {
    actions: Vec<Action>,
    midi: Vec<Vec<u8>>,
}

/// A compiled, sandboxed script with its persistent state.
pub struct ScriptRuntime {
    engine: Engine,
    ast: AST,
    scope: Scope<'static>,
    sink: Arc<Mutex<Sink>>,
    deadline: Arc<Mutex<Option<Instant>>>,
    max_ops: u64,
    max_ms: u64,
    has_on_midi: bool,
}

impl std::fmt::Debug for ScriptRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScriptRuntime")
            .field("max_ops", &self.max_ops)
            .field("max_ms", &self.max_ms)
            .field("has_on_midi", &self.has_on_midi)
            .finish()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn clamp7(v: i64) -> u8 {
    v.clamp(0, 127) as u8
}

fn chan(v: i64) -> u8 {
    (v.clamp(1, 16) - 1) as u8
}

impl ScriptRuntime {
    /// Compile `source`, run its top level and `init()` under the budgets.
    pub fn new(
        source: &str,
        max_operations: Option<u64>,
        max_millis: Option<u64>,
    ) -> Result<Self, ScriptError> {
        let max_ops = max_operations.unwrap_or(DEFAULT_MAX_OPERATIONS).max(1);
        let max_ms = max_millis.unwrap_or(DEFAULT_MAX_MILLIS).max(1);
        let sink = Arc::new(Mutex::new(Sink::default()));
        let state = Arc::new(Mutex::new(Map::new()));
        let deadline: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

        let mut engine = Engine::new();
        engine
            .set_max_operations(max_ops)
            .set_max_call_levels(32)
            .set_max_expr_depths(64, 32)
            .set_max_string_size(4096)
            .set_max_array_size(1024)
            .set_max_map_size(256)
            .set_max_variables(256)
            .set_max_functions(64);
        engine.disable_symbol("eval");
        engine.on_print(|_| {});
        engine.on_debug(|_, _, _| {});
        {
            let dl = deadline.clone();
            engine.on_progress(move |ops| {
                if ops % 128 == 0 {
                    if let Some(d) = *lock(&dl) {
                        if Instant::now() > d {
                            return Some(Dynamic::from("timeout"));
                        }
                    }
                }
                None
            });
        }
        {
            let s = sink.clone();
            engine.register_fn("emit", move |m: Map| -> Result<(), Box<EvalAltResult>> {
                let a: Action = rhai::serde::from_dynamic(&Dynamic::from_map(m))?;
                lock(&s).actions.push(a);
                Ok(())
            });
        }
        {
            let s = sink.clone();
            engine.register_fn("note", move |c: i64, n: i64, v: i64| {
                lock(&s)
                    .midi
                    .push(vec![0x90 | chan(c), clamp7(n), clamp7(v)]);
            });
        }
        {
            let s = sink.clone();
            engine.register_fn("cc", move |c: i64, n: i64, v: i64| {
                lock(&s)
                    .midi
                    .push(vec![0xB0 | chan(c), clamp7(n), clamp7(v)]);
            });
        }
        {
            let s = sink.clone();
            engine.register_fn("send", move |a: Array| -> Result<(), Box<EvalAltResult>> {
                let mut bytes = Vec::with_capacity(a.len());
                for d in a {
                    let v = d
                        .as_int()
                        .map_err(|t| format!("send: byte must be int, got {t}"))?;
                    bytes.push(v.clamp(0, 255) as u8);
                }
                lock(&s).midi.push(bytes);
                Ok(())
            });
        }
        {
            let st = state.clone();
            engine.register_fn("get_state", move |k: ImmutableString| -> Dynamic {
                lock(&st).get(k.as_str()).cloned().unwrap_or(Dynamic::UNIT)
            });
        }
        {
            let st = state.clone();
            engine.register_fn("set_state", move |k: ImmutableString, v: Dynamic| {
                lock(&st).insert(k.as_str().into(), v);
            });
        }

        let ast = engine
            .compile(source)
            .map_err(|e| ScriptError::Compile(e.to_string()))?;
        let has_on_midi = ast
            .iter_functions()
            .any(|f| f.name == "on_midi" && f.params.len() == 1);
        let has_init = ast
            .iter_functions()
            .any(|f| f.name == "init" && f.params.is_empty());

        let mut rt = Self {
            engine,
            ast,
            scope: Scope::new(),
            sink,
            deadline,
            max_ops,
            max_ms,
            has_on_midi,
        };
        rt.arm();
        let r = rt.engine.run_ast_with_scope(&mut rt.scope, &rt.ast);
        rt.disarm();
        r.map_err(|e| rt.classify(&e))?;
        if has_init {
            let _ = rt.call("init", ())?;
        }
        lock(&rt.sink).actions.clear();
        Ok(rt)
    }

    pub fn has_on_midi(&self) -> bool {
        self.has_on_midi
    }

    fn arm(&self) {
        *lock(&self.deadline) = Some(Instant::now() + Duration::from_millis(self.max_ms));
    }

    fn disarm(&self) {
        *lock(&self.deadline) = None;
    }

    fn classify(&self, e: &EvalAltResult) -> ScriptError {
        match e {
            EvalAltResult::ErrorInFunctionCall(_, _, inner, _) => self.classify(inner),
            EvalAltResult::ErrorTooManyOperations(_) => {
                ScriptError::TooManyOperations(self.max_ops)
            }
            EvalAltResult::ErrorTerminated(_, _) => ScriptError::Timeout(self.max_ms),
            other => ScriptError::Runtime(other.to_string()),
        }
    }

    fn call(&mut self, name: &str, args: impl rhai::FuncArgs) -> Result<Dynamic, ScriptError> {
        self.arm();
        let opts = CallFnOptions::new().eval_ast(false).rewind_scope(true);
        let r = self.engine.call_fn_with_options::<Dynamic>(
            opts,
            &mut self.scope,
            &self.ast,
            name,
            args,
        );
        self.disarm();
        r.map_err(|e| {
            let mut s = lock(&self.sink);
            s.actions.clear();
            s.midi.clear();
            drop(s);
            self.classify(&e)
        })
    }

    /// Run `on_midi(ev)` for one message.
    pub fn on_midi(
        &mut self,
        port: &str,
        msg: &MidiMessage,
        timestamp_us: u64,
    ) -> Result<ScriptOutput, ScriptError> {
        if !self.has_on_midi {
            return Ok(ScriptOutput::default());
        }
        let ev = event_map(port, msg, timestamp_us);
        let r = self.call("on_midi", (Dynamic::from_map(ev),))?;
        let mut s = lock(&self.sink);
        Ok(ScriptOutput {
            actions: std::mem::take(&mut s.actions),
            midi: std::mem::take(&mut s.midi),
            handled: r.as_bool().unwrap_or(false),
        })
    }
}

fn event_map(port: &str, msg: &MidiMessage, ts: u64) -> Map {
    let (kind, ch, d1, d2, value): (&str, i64, i64, i64, i64) = match *msg {
        MidiMessage::NoteOn {
            channel,
            note,
            velocity,
        } => (
            "note_on",
            i64::from(channel) + 1,
            note.into(),
            velocity.into(),
            velocity.into(),
        ),
        MidiMessage::NoteOff {
            channel,
            note,
            velocity,
        } => (
            "note_off",
            i64::from(channel) + 1,
            note.into(),
            velocity.into(),
            0,
        ),
        MidiMessage::ControlChange {
            channel,
            controller,
            value,
        } => (
            "cc",
            i64::from(channel) + 1,
            controller.into(),
            value.into(),
            value.into(),
        ),
        MidiMessage::PitchBend { channel, value } => (
            "pitch_bend",
            i64::from(channel) + 1,
            i64::from(value & 0x7F),
            i64::from(value >> 7),
            value.into(),
        ),
        MidiMessage::ProgramChange { channel, program } => (
            "program",
            i64::from(channel) + 1,
            program.into(),
            0,
            program.into(),
        ),
        MidiMessage::ChannelPressure { channel, pressure } => (
            "pressure",
            i64::from(channel) + 1,
            pressure.into(),
            0,
            pressure.into(),
        ),
        MidiMessage::PolyPressure {
            channel,
            note,
            pressure,
        } => (
            "poly_pressure",
            i64::from(channel) + 1,
            note.into(),
            pressure.into(),
            pressure.into(),
        ),
        MidiMessage::SysEx(_) => ("sysex", 0, 0, 0, 0),
        MidiMessage::TimingClock => ("clock", 0, 0, 0, 0),
        MidiMessage::Start => ("start", 0, 0, 0, 0),
        MidiMessage::Stop => ("stop", 0, 0, 0, 0),
        MidiMessage::Continue => ("continue", 0, 0, 0, 0),
        MidiMessage::SongPosition(p) => ("song_position", 0, 0, 0, p.into()),
        _ => ("other", 0, 0, 0, 0),
    };
    let mut m = Map::new();
    m.insert("port".into(), Dynamic::from(port.to_string()));
    m.insert("time".into(), Dynamic::from(ts as i64));
    m.insert("kind".into(), Dynamic::from(kind.to_string()));
    m.insert("channel".into(), Dynamic::from(ch));
    m.insert("data1".into(), Dynamic::from(d1));
    m.insert("data2".into(), Dynamic::from(d2));
    m.insert("value".into(), Dynamic::from(value));
    let bytes: Array = msg
        .to_bytes()
        .into_iter()
        .map(|b| Dynamic::from(i64::from(b)))
        .collect();
    m.insert("bytes".into(), Dynamic::from_array(bytes));
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::DeckAction;

    #[test]
    fn op_limit_stops_infinite_loop() {
        let mut rt =
            ScriptRuntime::new("fn on_midi(ev) { loop { } }", Some(10_000), Some(1_000)).unwrap();
        let err = rt.on_midi("p", &MidiMessage::TimingClock, 0).unwrap_err();
        assert_eq!(err, ScriptError::TooManyOperations(10_000));
        // The runtime survives and can be called again.
        assert!(rt.on_midi("p", &MidiMessage::TimingClock, 0).is_err());
    }

    #[test]
    fn top_level_infinite_loop_is_rejected() {
        // Generous wall-time budget so the op limit (not machine speed) is what stops the loop.
        let err = ScriptRuntime::new(
            "let x = 0; while true { x += 1; }",
            Some(5_000),
            Some(10_000),
        )
        .unwrap_err();
        assert_eq!(err, ScriptError::TooManyOperations(5_000));
    }

    #[test]
    fn time_limit_stops_long_script() {
        // Huge op budget, 1 ms wall-time budget.
        let mut rt =
            ScriptRuntime::new("fn on_midi(ev) { loop { } }", Some(u64::MAX / 2), Some(1)).unwrap();
        let err = rt.on_midi("p", &MidiMessage::Start, 0).unwrap_err();
        assert_eq!(err, ScriptError::Timeout(1));
    }

    #[test]
    fn emits_actions_leds_and_keeps_state() {
        let src = r#"
            fn on_midi(ev) {
                if ev.kind == "note_on" && ev.data1 == 11 {
                    let n = get_state("presses") ?? 0;
                    set_state("presses", n + 1);
                    if n >= 1 { cc(16, 1, n + 1); }
                    emit(#{ deck: #{ type: "play_pause", deck: ev.channel - 1 } });
                    note(ev.channel, 11, 127);
                    return true;
                }
                false
            }
        "#;
        let mut rt = ScriptRuntime::new(src, None, None).unwrap();
        let msg = MidiMessage::NoteOn {
            channel: 1,
            note: 11,
            velocity: 127,
        };
        let out = rt.on_midi("FLX4", &msg, 5).unwrap();
        assert!(out.handled);
        assert_eq!(
            out.actions,
            vec![Action::Deck(DeckAction::PlayPause { deck: 1 })]
        );
        assert_eq!(out.midi, vec![vec![0x91, 11, 127]]);
        let out = rt.on_midi("FLX4", &msg, 6).unwrap();
        // State persisted: second press saw presses == 1.
        assert_eq!(out.midi, vec![vec![0xBF, 1, 2], vec![0x91, 11, 127]]);
        let out = rt
            .on_midi(
                "FLX4",
                &MidiMessage::NoteOn {
                    channel: 0,
                    note: 1,
                    velocity: 1,
                },
                7,
            )
            .unwrap();
        assert!(!out.handled);
    }

    #[test]
    fn no_filesystem_or_eval() {
        assert!(matches!(
            ScriptRuntime::new(r#"import "x" as y;"#, None, None),
            Err(ScriptError::Compile(_))
        ));
        assert!(ScriptRuntime::new(r#"eval("1")"#, None, None).is_err());
        assert!(matches!(
            ScriptRuntime::new(r#"open_file("C:/x")"#, None, None),
            Err(ScriptError::Runtime(_))
        ));
    }
}
