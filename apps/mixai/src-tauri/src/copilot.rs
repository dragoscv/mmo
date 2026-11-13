//! Offline co-pilot (WP19-39): Tauri side of `decks-transition`.
//!
//! * `copilot_rank`: next-track suggestions for the playing deck from the loaded library.
//!   With `keyShift: true` (the desktop UI sends it) a clashing track that one or two
//!   semitones of key shift make fit carries that proposal and gets a key term between a clash
//!   and an adjacent key; it never ranks above a track that fits as it is (the crate caps its
//!   score below the lowest-scoring fit of the candidate list, before the cut to `limit`)
//!   (WP19-61). The ranking the native apps get through `decks-ffi` has no such option and is
//!   unchanged.
//! * `copilot_plan`: a phrase-aligned transition plan (editable automation as JSON).
//! * `copilot_run` / `copilot_cancel` / `copilot_status`: play a plan against the engine. One
//!   thread ticks the crate's `TransitionRunner` every 20 ms while a run exists (it sleeps on a
//!   condition variable otherwise) and reports on `copilot://progress` at 10 Hz.
//! * `copilot_safety`: 32-bar look-ahead warnings. `copilot_intent`: RO / EN typed commands.
//!
//! Suggestions and plans are a deterministic heuristic on key, tempo and energy (the crate's
//! weights), not a model: the same input always gives the same answer, offline.
//!
//! Five things differ from the FFI wrapper (`decks-ffi/src/transition.rs`), on purpose:
//!
//! * **Time base.** The runner is not fed the master clock beat: with the clock source on
//!   `auto` the master is the first playing deck, so a B to A mix makes that beat jump to A's
//!   own beat number the moment A starts. The run counts its own beats instead: audio frames
//!   times the outgoing deck's audible tempo (= beats of the outgoing track).
//! * **Level.** Volume lanes are scaled to the outgoing deck's fader level at the start, so a
//!   set mixed at 0.85 neither jumps to 1.0 when a transition begins nor ends louder.
//! * **Sync.** The engine's phase sync matches tempo 1:1. For a half / double time pair
//!   (87 and 174 BPM, which the ranker counts as a match) it would halve the incoming deck's
//!   speed, so there the run sets the half / double tempo itself and skips the sync event. A
//!   sync lock the run switched on is released when the run ends, also when it is cancelled.
//! * **Strip.** When a run ends with the outgoing deck paused by the plan, that deck gets the
//!   values the automation moved (fader, EQ, filter, stem gains) back as they were before the
//!   run: a bass swap would otherwise leave its lows and highs cut for the next track. A
//!   cancelled run restores no value (it only switches off an echo and releases a sync lock it
//!   switched on: the incoming deck must not keep following the other deck's tempo).
//! * **Tracks.** A run belongs to the two tracks its decks held when it started. When either
//!   deck gets another track mid-run (a load from the library, a controller, the remote), the
//!   run ends as cancelled on the next tick: its lanes would otherwise drive the new track and
//!   its end would put the old track's strip values on it.
//!
//! A run is refused while the crossfader holds the incoming deck more than 6 dB below the
//! outgoing one: a plan moves channel faders only, so that set would end quiet or silent. It is
//! also refused when the thread that ticks runs is not there (it would wait for ever).
//!
//! Parent-module items used: `super::EngineState`, `super::parse_deck`. The command names are
//! registered in `lib.rs`.

use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use decks_transition as dt;
use mixai_core::dsp::crossfader_gain;
use mixai_core::{
    BeatFxKind, ClockState, Command, CrossfaderAssign, DeckId, DeckState, Engine, MixerState,
    valid_bpm, valid_sec,
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use super::{EngineState, parse_deck};

/// Event carrying a [`Progress`] while a transition runs (10 Hz, plus one when it ends).
const EVENT: &str = "copilot://progress";
const TICK: Duration = Duration::from_millis(20);
/// One progress event every this many ticks (100 ms).
const EMIT_EVERY: u32 = 5;
/// Ticks without a new audio frame before a run is given up (5 s: the stream stopped).
const STALL_TICKS: u32 = 250;
/// A frame-counter step longer than this is a reopened stream, not playback: resync, no leap.
const MAX_GAP_SEC: f64 = 10.0;
const MAX_CANDIDATES: usize = 10_000;
const MAX_TEXT: usize = 300;
/// Longest key text looked at, in characters (a Camelot key has at most three).
const MAX_KEY_CHARS: usize = 8;
const MAX_PLAN_JSON: usize = 256 * 1024;
const MAX_LANES: usize = 64;
const MAX_KEYS: usize = 512;
const MAX_EVENTS: usize = 128;
const MAX_BARS: u32 = 64;
const MAX_ERRORS: usize = 8;
/// Longest automation: 64 bars plus an echo tail.
const MAX_LENGTH_BEATS: f64 = 64.0 * dt::BEATS_PER_BAR + 16.0;
/// Longest wait for the start (the planner starts on the next 8-bar phrase).
const MAX_WAIT_BEATS: f64 = 64.0 * dt::BEATS_PER_BAR;
/// A plan whose start lies further behind the playhead than this is stale.
const LATE_BEATS: f64 = 1.0;
const ECHO_FEEDBACK: f32 = 0.45;
const DEFAULT_ECHO_BEATS: f64 = 0.75;
/// Below this fader level the outgoing deck is not what the room hears: lanes run at full scale.
const MIN_LEVEL: f32 = 0.05;
/// Least share of the outgoing deck's crossfader gain the incoming deck must get (0.5 = −6 dB).
const MIN_CROSSFADER_SHARE: f32 = 0.5;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why a run ended when a deck got another track (the UI recognises "got another track").
fn track_changed(deck: DeckId) -> String {
    format!(
        "deck {} got another track: the transition was stopped",
        deck_name(deck).to_uppercase()
    )
}

/// Answer of `copilot_run` while the thread that plays transitions is not there (the UI
/// recognises "transition thread").
const NO_RUNNER: &str = "the transition thread is not running: restart the app";

fn deck_name(deck: DeckId) -> &'static str {
    match deck {
        DeckId::A => "a",
        DeckId::B => "b",
        DeckId::C => "c",
        DeckId::D => "d",
    }
}

fn deck_at(index: u8) -> Result<DeckId, String> {
    DeckId::ALL
        .get(usize::from(index))
        .copied()
        .ok_or_else(|| format!("deck index {index} is out of range"))
}

fn clip(s: String) -> String {
    if s.chars().count() > MAX_TEXT {
        s.chars().take(MAX_TEXT).collect()
    } else {
        s
    }
}

/// A key as the crate takes it: canonical Camelot (`8A`), or nothing. Library rows and file
/// tags carry anything here (`A♭`, `Am♭`, full-width `８Ａ`, a whole sentence). Only ASCII
/// letters and digits reach the crate's parser, so a key can never bring the app down, whatever
/// that parser does with text it was not written for (the release build aborts on a panic).
fn camelot_key(raw: &str) -> Option<String> {
    let mut ascii = String::new();
    for (i, c) in raw.trim().chars().enumerate() {
        if i >= MAX_KEY_CHARS {
            return None;
        }
        // Full-width forms (`８`, `Ａ`) are the same characters to a reader.
        let c = match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(u32::from(c) - 0xFEE0)?,
            c => c,
        };
        if !c.is_ascii_alphanumeric() {
            return None;
        }
        ascii.push(c);
    }
    dt::Camelot::parse(&ascii).map(dt::Camelot::label)
}

// ---- requests and answers (camelCase on the wire) -------------------------------------------

/// Track features as the UI sends them. Every field may be left out; unknown tempo, key and
/// energy are `null`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackFeat {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// Tempo of the track itself (not the pitched tempo of a deck).
    pub bpm: Option<f64>,
    /// Camelot (`8A`).
    pub key: Option<String>,
    /// 1..10.
    pub energy: Option<f64>,
    pub duration_sec: f64,
    pub first_beat_sec: f64,
    pub downbeat_offset: u8,
    pub lufs: Option<f64>,
    pub has_stems: bool,
}

impl TrackFeat {
    /// Validated crate form. A tempo outside 20..400 and an energy outside 1..10 count as
    /// unknown, and so does a key that is not Camelot; a number that is not finite, or a
    /// negative time, is refused.
    fn features(self, what: &str) -> Result<dt::TrackFeatures, String> {
        let number = |name: &str, v: f64| {
            if v.is_finite() {
                Ok(v)
            } else {
                Err(format!("{what}.{name} must be a finite number"))
            }
        };
        let time = |name: &str, v: f64| {
            if valid_sec(v) {
                Ok(v)
            } else {
                Err(format!("{what}.{name} must be finite and >= 0"))
            }
        };
        let bpm = self
            .bpm
            .map(|b| number("bpm", b))
            .transpose()?
            .filter(|b| valid_bpm(*b));
        let energy = self
            .energy
            .map(|e| number("energy", e))
            .transpose()?
            .map(f64::round)
            .filter(|e| (1.0..=10.0).contains(e))
            .map(|e| e as u8);
        let lufs = self.lufs.map(|l| number("lufs", l)).transpose()?;
        let duration_sec = time("durationSec", self.duration_sec)?;
        let first_beat_sec = time("firstBeatSec", self.first_beat_sec)?;
        Ok(dt::TrackFeatures {
            id: clip(self.id),
            title: clip(self.title),
            artist: clip(self.artist),
            bpm,
            key: self.key.as_deref().and_then(camelot_key),
            energy,
            duration_sec,
            first_beat_sec,
            downbeat_offset: self.downbeat_offset.min(3),
            lufs,
            has_stems: self.has_stems,
        })
    }
}

/// A library track that could come next.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CandidateIn {
    pub track: TrackFeat,
    /// Minutes since it was last played tonight (`null` = not played).
    pub played_minutes_ago: Option<f64>,
}

/// A ranked suggestion: score parts and reason tags (the UI translates the tags).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedOut {
    pub id: String,
    pub score: f64,
    pub key: f64,
    pub tempo: f64,
    pub energy: f64,
    pub reasons: Vec<String>,
    pub tempo_ratio: Option<f64>,
    /// Proposed key shift of this track in semitones (+1, -1, +2, -2) that makes it fit the
    /// reference key; `null` = none. Always on the wire, so the UI can tell a shell that knows
    /// proposals (field there) from an older one (field absent).
    pub key_shift: Option<i8>,
    /// The track's key after the proposed shift (Camelot); `null` without a proposal.
    pub key_after: Option<String>,
}

fn parse_energy(s: Option<&str>) -> Result<dt::EnergyDirection, String> {
    match s.unwrap_or("hold") {
        "hold" => Ok(dt::EnergyDirection::Hold),
        "up" => Ok(dt::EnergyDirection::Up),
        "down" => Ok(dt::EnergyDirection::Down),
        other => Err(format!("invalid energy direction '{other}'")),
    }
}

fn energy_name(e: dt::EnergyDirection) -> &'static str {
    match e {
        dt::EnergyDirection::Hold => "hold",
        dt::EnergyDirection::Up => "up",
        dt::EnergyDirection::Down => "down",
    }
}

fn rank_impl(
    playing: TrackFeat,
    candidates: Vec<CandidateIn>,
    energy: Option<&str>,
    limit: Option<u32>,
    key_shift: Option<bool>,
) -> Result<Vec<RankedOut>, String> {
    if candidates.len() > MAX_CANDIDATES {
        return Err(format!("at most {MAX_CANDIDATES} candidates"));
    }
    let opts = dt::RankOptions {
        energy: parse_energy(energy)?,
        limit: limit.unwrap_or(8).clamp(1, 200) as usize,
        ..Default::default()
    };
    let playing = playing.features("playing")?;
    let mut list = Vec::with_capacity(candidates.len());
    for (i, c) in candidates.into_iter().enumerate() {
        list.push(dt::Candidate {
            track: c.track.features(&format!("candidates[{i}]"))?,
            played_minutes_ago: c
                .played_minutes_ago
                .filter(|m| m.is_finite())
                .map(|m| m.max(0.0)),
        });
    }
    // Left out (an older UI, another caller) = the plain ranking, as before the option existed.
    let extras = dt::RankExtras {
        key_shift: key_shift.unwrap_or(false),
    };
    Ok(dt::rank_next_with(&playing, &list, &opts, extras)
        .into_iter()
        .map(|r| RankedOut {
            id: r.id,
            score: r.score,
            key: r.key,
            tempo: r.tempo,
            energy: r.energy,
            reasons: r.reasons,
            tempo_ratio: r.tempo_ratio,
            key_shift: r.key_shift,
            key_after: r.key_after,
        })
        .collect())
}

fn parse_style(s: &str) -> Result<dt::Style, String> {
    match s {
        "bass_swap" => Ok(dt::Style::BassSwap),
        "filter_sweep" => Ok(dt::Style::FilterSweep),
        "echo_out" => Ok(dt::Style::EchoOut),
        "stem_swap" => Ok(dt::Style::StemSwap),
        "cut" => Ok(dt::Style::Cut),
        other => Err(format!("unknown transition style '{other}'")),
    }
}

fn style_name(s: dt::Style) -> &'static str {
    match s {
        dt::Style::BassSwap => "bass_swap",
        dt::Style::FilterSweep => "filter_sweep",
        dt::Style::EchoOut => "echo_out",
        dt::Style::StemSwap => "stem_swap",
        dt::Style::Cut => "cut",
    }
}

/// A transition plan (same fields as the FFI `TransitionPlanInfo`, plus the decks and length).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInfo {
    /// `bass_swap` | `filter_sweep` | `echo_out` | `stem_swap` | `cut`.
    pub style: String,
    pub bars: u32,
    /// Start on the outgoing track, in seconds (a phrase boundary when the grid allows).
    pub start_sec: f64,
    pub beats_until_start: f64,
    /// Where the incoming track is cued: its first downbeat.
    pub to_cue_sec: f64,
    /// Track tempo ratio (information; a run reads the live deck tempos).
    pub to_tempo_ratio: f64,
    /// Editable automation (see docs/decks/transitions.md); `copilot_run` takes it back.
    pub automation_json: String,
    pub reasons: Vec<String>,
    pub from_deck: String,
    pub to_deck: String,
    pub length_beats: f64,
}

fn plan_impl(
    from: TrackFeat,
    to: TrackFeat,
    from_deck: &str,
    to_deck: &str,
    from_pos_sec: f64,
    bars: Option<u32>,
    style: Option<&str>,
) -> Result<PlanInfo, String> {
    let a = parse_deck(from_deck)?;
    let b = parse_deck(to_deck)?;
    if a == b {
        return Err("the two decks must be different".into());
    }
    if !valid_sec(from_pos_sec) {
        return Err("fromPosSec must be finite and >= 0".into());
    }
    if bars.is_some_and(|n| !(1..=MAX_BARS).contains(&n)) {
        return Err(format!("bars must be within 1..={MAX_BARS}"));
    }
    let req = dt::PlanRequest {
        from: from.features("from")?,
        to: to.features("to")?,
        from_deck: a.index() as u8,
        to_deck: b.index() as u8,
        from_pos_sec,
        bars,
        style: style.map(parse_style).transpose()?,
        not_before_bars: 0,
    };
    let plan = dt::plan_transition(&req).ok_or("the playing track has no tempo or beatgrid")?;
    let automation_json =
        serde_json::to_string(&plan.automation).map_err(|e| format!("automation: {e}"))?;
    Ok(PlanInfo {
        style: style_name(plan.style).to_string(),
        bars: plan.bars,
        start_sec: plan.start_sec,
        beats_until_start: plan.beats_until_start,
        to_cue_sec: plan.to_cue_sec,
        to_tempo_ratio: plan.to_tempo_ratio,
        automation_json,
        reasons: plan.reasons,
        from_deck: deck_name(a).to_string(),
        to_deck: deck_name(b).to_string(),
        length_beats: plan.automation.length_beats,
    })
}

/// One set-safety warning. `code` = `ending_without_next` | `plan_does_not_fit` | `tempo_gap` |
/// `key_clash` | `loudness_jump` | `no_grid`; the numbers a code carries are set, the rest left out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningOut {
    pub code: String,
    /// 2 = act now, 1 = heads-up.
    pub severity: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bars_left: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_lu: Option<f64>,
}

fn warning_out(w: dt::Warning) -> WarningOut {
    let mut out = WarningOut {
        severity: w.severity(),
        ..Default::default()
    };
    match w {
        dt::Warning::EndingWithoutNext { bars_left } => {
            out.code = "ending_without_next".into();
            out.bars_left = Some(bars_left);
        }
        dt::Warning::PlanDoesNotFit { bars_left, needed } => {
            out.code = "plan_does_not_fit".into();
            out.bars_left = Some(bars_left);
            out.needed = Some(needed);
        }
        dt::Warning::TempoGap { percent } => {
            out.code = "tempo_gap".into();
            out.percent = Some(percent);
        }
        dt::Warning::KeyClash { from, to } => {
            out.code = "key_clash".into();
            out.from = Some(from);
            out.to = Some(to);
        }
        dt::Warning::LoudnessJump { delta_lu } => {
            out.code = "loudness_jump".into();
            out.delta_lu = Some(delta_lu);
        }
        dt::Warning::NoGrid => out.code = "no_grid".into(),
    }
    out
}

fn safety_impl(
    playing: TrackFeat,
    position_sec: f64,
    tempo_ratio: f64,
    next: Option<TrackFeat>,
    planned_bars: Option<u32>,
) -> Result<Vec<WarningOut>, String> {
    if !valid_sec(position_sec) {
        return Err("positionSec must be finite and >= 0".into());
    }
    if !(0.25..=4.0).contains(&tempo_ratio) {
        return Err("tempoRatio must be within 0.25..=4".into());
    }
    if planned_bars.is_some_and(|n| !(1..=MAX_BARS).contains(&n)) {
        return Err(format!("plannedBars must be within 1..={MAX_BARS}"));
    }
    let input = dt::SafetyInput {
        playing: playing.features("playing")?,
        position_sec,
        tempo_ratio,
        next: next.map(|n| n.features("next")).transpose()?,
        planned_bars,
    };
    Ok(dt::check_safety(&input)
        .into_iter()
        .map(warning_out)
        .collect())
}

/// A recognised typed command. `action` = `mix_next` | `suggest` | `cancel` | `play` | `pause` |
/// `sync` | `loop`; `deck` is `a`..`d`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentOut {
    pub action: String,
    pub bars: Option<u32>,
    pub style: Option<String>,
    pub energy: Option<String>,
    pub deck: Option<String>,
    pub beats: Option<f64>,
}

fn intent_impl(text: &str) -> Option<IntentOut> {
    let text: String = text.chars().take(MAX_TEXT).collect();
    let i = dt::parse_intent(&text)?;
    let action = match i.action {
        dt::IntentAction::MixNext => "mix_next",
        dt::IntentAction::Suggest => "suggest",
        dt::IntentAction::Cancel => "cancel",
        dt::IntentAction::Play => "play",
        dt::IntentAction::Pause => "pause",
        dt::IntentAction::Sync => "sync",
        dt::IntentAction::Loop => "loop",
    };
    Some(IntentOut {
        action: action.to_string(),
        bars: i.bars,
        style: i.style.map(|s| style_name(s).to_string()),
        energy: i.energy.map(|e| energy_name(e).to_string()),
        deck: i
            .deck
            .and_then(|d| deck_at(d).ok())
            .map(|d| deck_name(d).to_string()),
        beats: i.beats,
    })
}

// ---- the plan a run is started with ---------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunPlanIn {
    automation_json: String,
    #[serde(default)]
    start_sec: Option<f64>,
    #[serde(default)]
    beats_until_start: Option<f64>,
    #[serde(default)]
    to_cue_sec: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
struct RunPlan {
    automation: dt::Automation,
    /// Start on the outgoing track (seconds); the wait is measured from the live playhead.
    start_sec: Option<f64>,
    /// Wait in beats, used when `start_sec` is absent (a bare automation starts at once).
    beats_until_start: Option<f64>,
    to_cue_sec: Option<f64>,
}

fn checked(
    name: &str,
    value: Option<f64>,
    ok: impl Fn(f64) -> bool,
) -> Result<Option<f64>, String> {
    match value {
        Some(v) if !ok(v) => Err(format!("{name} is out of range")),
        other => Ok(other),
    }
}

fn event_deck(event: dt::Event) -> u8 {
    match event {
        dt::Event::Play { deck }
        | dt::Event::Pause { deck }
        | dt::Event::Sync { deck }
        | dt::Event::Stems { deck, .. } => deck,
    }
}

/// Sizes, ranges and decks of an automation, then the crate's `normalise`. Only the two decks
/// of the transition may be driven.
fn validate_automation(
    mut a: dt::Automation,
    from: DeckId,
    to: DeckId,
) -> Result<dt::Automation, String> {
    if a.lanes.len() > MAX_LANES || a.events.len() > MAX_EVENTS {
        return Err(format!(
            "automation: at most {MAX_LANES} lanes and {MAX_EVENTS} events"
        ));
    }
    let part = |deck: u8| usize::from(deck) == from.index() || usize::from(deck) == to.index();
    let foreign =
        |deck: u8| format!("automation: deck index {deck} is not part of this transition");
    for lane in &a.lanes {
        if lane.keys.len() > MAX_KEYS {
            return Err(format!("automation: at most {MAX_KEYS} keyframes per lane"));
        }
        if !part(lane.target.deck()) {
            return Err(foreign(lane.target.deck()));
        }
        match lane.target {
            dt::Target::Eq { band, .. } if band > 2 => {
                return Err(format!("automation: EQ band {band} (0 low, 1 mid, 2 high)"));
            }
            dt::Target::Stem { stem, .. } if stem > 3 => {
                return Err(format!("automation: stem {stem} (0..3)"));
            }
            _ => {}
        }
    }
    for e in &a.events {
        if !part(event_deck(e.event)) {
            return Err(foreign(event_deck(e.event)));
        }
    }
    if !a.length_beats.is_finite() || a.length_beats < 0.0 {
        return Err("automation: length_beats must be finite and >= 0".into());
    }
    if !(1.0 / 32.0..=8.0).contains(&a.echo_beats) {
        return Err("automation: echo_beats must be within 1/32..=8".into());
    }
    a.normalise();
    if a.lanes.is_empty() && a.events.is_empty() {
        return Err("automation: nothing to play".into());
    }
    if !(a.length_beats > 0.0 && a.length_beats <= MAX_LENGTH_BEATS) {
        return Err(format!(
            "automation: length must be within 0..={MAX_LENGTH_BEATS} beats"
        ));
    }
    Ok(a)
}

/// `json` is a [`PlanInfo`] (as `copilot_plan` returned it, the automation possibly edited) or
/// a bare automation (starts at once, the incoming deck is left where it is).
fn parse_run_plan(json: &str, from: DeckId, to: DeckId) -> Result<RunPlan, String> {
    if json.len() > MAX_PLAN_JSON {
        return Err("the plan is too large".into());
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("plan: {e}"))?;
    let (automation, meta) = if value.get("automationJson").is_some() {
        let p: RunPlanIn = serde_json::from_value(value).map_err(|e| format!("plan: {e}"))?;
        let a: dt::Automation =
            serde_json::from_str(&p.automation_json).map_err(|e| format!("automation: {e}"))?;
        (a, Some(p))
    } else {
        let a: dt::Automation =
            serde_json::from_value(value).map_err(|e| format!("automation: {e}"))?;
        (a, None)
    };
    let automation = validate_automation(automation, from, to)?;
    let Some(p) = meta else {
        return Ok(RunPlan {
            automation,
            start_sec: None,
            beats_until_start: None,
            to_cue_sec: None,
        });
    };
    Ok(RunPlan {
        automation,
        start_sec: checked("startSec", p.start_sec, valid_sec)?,
        beats_until_start: checked("beatsUntilStart", p.beats_until_start, |v| {
            (0.0..=MAX_WAIT_BEATS).contains(&v)
        })?,
        to_cue_sec: checked("toCueSec", p.to_cue_sec, valid_sec)?,
    })
}

// ---- automation -> engine -------------------------------------------------------------------

/// The engine calls a transition needs. `mixai_core::Engine` implements it by doing what the
/// deck commands in `lib.rs` do (UI mirror + `Command`); tests record the calls.
pub(crate) trait EngineLike {
    fn volume(&self, deck: DeckId, value: f32);
    /// `band` = `low` | `mid` | `high`.
    fn eq(&self, deck: DeckId, band: &'static str, db: f32);
    fn filter(&self, deck: DeckId, value: f32);
    fn stem_gain(&self, deck: DeckId, stem: usize, gain: f32);
    /// Beat FX echo with `beats` of delay at `wet`.
    fn echo(&self, deck: DeckId, wet: f32, beats: f64);
    fn echo_off(&self, deck: DeckId);
    fn play(&self, deck: DeckId);
    fn pause(&self, deck: DeckId);
    /// Phase sync to the master and stay locked.
    fn sync(&self, deck: DeckId);
    /// Release the sync lock (the tempo stays).
    fn unlock(&self, deck: DeckId);
    fn stems(&self, deck: DeckId, on: bool);
    /// Last transport command the app sent for the deck was "play".
    fn play_intent(&self, deck: DeckId) -> bool;
    /// The audio thread reports the deck as playing (lags a command by one buffer).
    fn is_playing(&self, deck: DeckId) -> bool;
    /// Identity of what the deck holds (see [`deck_tag`]): another value = another track.
    fn track_tag(&self, deck: DeckId) -> u64;
}

/// One number for "which track is on this deck": loaded or not, track id, title, artist and
/// length as the loader wrote them. It does not change while a track plays, is tweaked or is
/// seeked; it changes when the deck gets another track (files without a library id differ by
/// title and length). Loading the very same track again gives the same number.
fn deck_tag(d: &DeckState) -> u64 {
    let mut h = DefaultHasher::new();
    d.loaded.hash(&mut h);
    d.track_id.hash(&mut h);
    d.title.hash(&mut h);
    d.artist.hash(&mut h);
    d.duration.to_bits().hash(&mut h);
    h.finish()
}

fn mirror_deck(engine: &Engine, deck: DeckId, f: impl FnOnce(&mut DeckState)) {
    if let Some(d) = engine.mirror().decks.iter_mut().find(|d| d.id == deck) {
        f(d);
    }
}

impl EngineLike for Engine {
    fn volume(&self, deck: DeckId, value: f32) {
        mirror_deck(self, deck, |d| d.volume = value);
        self.send(Command::Volume(deck, value));
    }

    fn eq(&self, deck: DeckId, band: &'static str, db: f32) {
        mirror_deck(self, deck, |d| match band {
            "low" => d.eq_low = db,
            "mid" => d.eq_mid = db,
            _ => d.eq_high = db,
        });
        self.send(Command::Eq(deck, band.to_string(), db));
    }

    fn filter(&self, deck: DeckId, value: f32) {
        mirror_deck(self, deck, |d| d.filter = value);
        self.send(Command::Filter(deck, value));
    }

    fn stem_gain(&self, deck: DeckId, stem: usize, gain: f32) {
        self.set_stem_gain(deck, stem, gain);
    }

    fn echo(&self, deck: DeckId, wet: f32, beats: f64) {
        self.set_beat_fx(deck, BeatFxKind::Echo, wet, beats, ECHO_FEEDBACK);
    }

    fn echo_off(&self, deck: DeckId) {
        self.set_beat_fx(
            deck,
            BeatFxKind::None,
            0.0,
            DEFAULT_ECHO_BEATS,
            ECHO_FEEDBACK,
        );
    }

    fn play(&self, deck: DeckId) {
        mirror_deck(self, deck, |d| d.playing = true);
        self.send(Command::Play(deck));
    }

    fn pause(&self, deck: DeckId) {
        mirror_deck(self, deck, |d| d.playing = false);
        self.send(Command::Pause(deck));
    }

    fn sync(&self, deck: DeckId) {
        self.phase_sync(deck, true);
    }

    fn unlock(&self, deck: DeckId) {
        self.set_sync_lock(deck, false);
    }

    fn stems(&self, deck: DeckId, on: bool) {
        self.set_stems_active(deck, on);
    }

    fn play_intent(&self, deck: DeckId) -> bool {
        self.mirror()
            .decks
            .iter()
            .find(|d| d.id == deck)
            .is_some_and(|d| d.playing)
    }

    fn is_playing(&self, deck: DeckId) -> bool {
        self.snapshot_state()
            .decks
            .iter()
            .find(|d| d.id == deck)
            .is_some_and(|d| d.playing)
    }

    fn track_tag(&self, deck: DeckId) -> u64 {
        // The mirror, not the snapshot: the loader writes the new track there before the audio
        // thread has it, and the snapshot's length comes from the audio thread.
        self.mirror()
            .decks
            .iter()
            .find(|d| d.id == deck)
            .map_or(0, deck_tag)
    }
}

fn eq_band(band: u8) -> Result<&'static str, String> {
    match band {
        0 => Ok("low"),
        1 => Ok("mid"),
        2 => Ok("high"),
        other => Err(format!("EQ band {other} is out of range")),
    }
}

/// Send one runner command to the engine. `echo_beats[deck]` remembers the echo length set by
/// `EchoSetup` (0 = none yet) for the wet lane that follows. A deck, band or stem out of range
/// and a value that is not finite are refused; values are clamped to the target's range.
pub(crate) fn apply_auto<E: EngineLike + ?Sized>(
    engine: &E,
    cmd: &dt::AutoCmd,
    echo_beats: &mut [f64; 4],
) -> Result<(), String> {
    match *cmd {
        dt::AutoCmd::Set { target, value } => {
            if !value.is_finite() {
                return Err("an automation value is not finite".into());
            }
            let deck = deck_at(target.deck())?;
            let (lo, hi) = target.range();
            let value = value.clamp(lo, hi);
            match target {
                dt::Target::Volume { .. } => engine.volume(deck, value),
                dt::Target::Eq { band, .. } => engine.eq(deck, eq_band(band)?, value),
                dt::Target::Filter { .. } => engine.filter(deck, value),
                dt::Target::Stem { stem, .. } => {
                    if stem > 3 {
                        return Err(format!("stem {stem} is out of range"));
                    }
                    engine.stem_gain(deck, usize::from(stem), value);
                }
                dt::Target::EchoWet { .. } => {
                    let beats = echo_beats[deck.index()];
                    let beats = if beats > 0.0 {
                        beats
                    } else {
                        DEFAULT_ECHO_BEATS
                    };
                    engine.echo(deck, value, beats);
                }
            }
        }
        dt::AutoCmd::EchoSetup { deck, beats } => {
            let deck = deck_at(deck)?;
            if !(1.0 / 32.0..=8.0).contains(&beats) {
                return Err("the echo length must be within 1/32..=8 beats".into());
            }
            echo_beats[deck.index()] = beats;
            engine.echo(deck, 0.0, beats);
        }
        dt::AutoCmd::Event { event } => match event {
            dt::Event::Play { deck } => engine.play(deck_at(deck)?),
            dt::Event::Pause { deck } => engine.pause(deck_at(deck)?),
            dt::Event::Sync { deck } => engine.sync(deck_at(deck)?),
            dt::Event::Stems { deck, on } => engine.stems(deck_at(deck)?, on),
        },
        dt::AutoCmd::Done => {}
    }
    Ok(())
}

// ---- a running transition -------------------------------------------------------------------

/// What the engine clock says at one tick.
#[derive(Debug, Clone, Copy)]
struct ClockSample {
    /// Output frames rendered so far.
    frame: u64,
    sample_rate: u32,
    /// Audible tempo of the outgoing deck (0 = unknown).
    deck_bpm: f64,
    /// Master clock tempo, used when the deck's is unknown.
    master_bpm: f64,
}

fn clock_sample(clock: &ClockState, from: DeckId) -> ClockSample {
    ClockSample {
        frame: clock.frame,
        sample_rate: clock.sample_rate,
        deck_bpm: clock
            .decks
            .iter()
            .find(|d| d.id == from)
            .map_or(0.0, |d| d.bpm),
        master_bpm: clock.bpm,
    }
}

/// Beats since the run was created: audio frames times tempo. Independent of which deck drives
/// the master clock and of jumps on either deck.
#[derive(Debug, Clone)]
struct BeatClock {
    pos: f64,
    bpm: f64,
    last_frame: Option<u64>,
}

impl BeatClock {
    /// Returns false when no audio was rendered since the previous sample.
    fn advance(&mut self, s: ClockSample) -> bool {
        if valid_bpm(s.deck_bpm) {
            self.bpm = s.deck_bpm;
        } else if valid_bpm(s.master_bpm) {
            self.bpm = s.master_bpm;
        }
        let Some(prev) = self.last_frame.replace(s.frame) else {
            return true;
        };
        let frames = s.frame.wrapping_sub(prev);
        if frames == 0 || s.sample_rate == 0 {
            return false;
        }
        let sec = frames as f64 / f64::from(s.sample_rate);
        if sec <= MAX_GAP_SEC {
            self.pos += sec * self.bpm / 60.0;
        }
        true
    }
}

/// State of the run, sent as `copilot://progress` and returned by `copilot_run` / `copilot_status`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    /// 0..1 of the automation length (0 while waiting for the start).
    pub progress: f64,
    pub done: bool,
    /// Ended by `copilot_cancel` or because the audio engine stopped.
    pub cancelled: bool,
    /// The start (next phrase) has not been reached yet.
    pub waiting: bool,
    pub beats_until_start: f64,
    pub length_beats: f64,
    pub from_deck: String,
    pub to_deck: String,
    /// Commands the engine refused (at most the first eight).
    pub errors: Vec<String>,
}

/// The decks before the run.
#[derive(Debug, Clone, PartialEq)]
struct Before {
    /// Scale of the volume lanes (the outgoing deck's fader level).
    level: f32,
    /// What the automation moves on the outgoing deck, as it was.
    restore: Vec<dt::AutoCmd>,
    /// Stem playback state of the outgoing deck, when the plan switches it.
    stems: Option<bool>,
    /// Sync lock per deck (a lock the run adds is released at the end).
    locked: [bool; 4],
}

fn before_run(deck: &DeckState, a: &dt::Automation, from: DeckId, locked: [bool; 4]) -> Before {
    let mine = |index: u8| usize::from(index) == from.index();
    let mut restore = Vec::new();
    for lane in a.lanes.iter().filter(|l| mine(l.target.deck())) {
        let value = match lane.target {
            dt::Target::Volume { .. } => deck.volume,
            dt::Target::Eq { band, .. } => match band {
                0 => deck.eq_low,
                1 => deck.eq_mid,
                _ => deck.eq_high,
            },
            dt::Target::Filter { .. } => deck.filter,
            dt::Target::Stem { stem, .. } => deck
                .stem_gains
                .get(usize::from(stem))
                .copied()
                .unwrap_or(1.0),
            // The echo is switched off when the run ends, whatever happens to the deck.
            dt::Target::EchoWet { .. } => continue,
        };
        restore.push(dt::AutoCmd::Set {
            target: lane.target,
            value,
        });
    }
    let stems = a
        .events
        .iter()
        .any(|e| matches!(e.event, dt::Event::Stems { deck, .. } if mine(deck)))
        .then_some(deck.stems_active);
    let level = if deck.volume.is_finite() && deck.volume >= MIN_LEVEL {
        deck.volume.min(1.0)
    } else {
        1.0
    };
    Before {
        level,
        restore,
        stems,
        locked,
    }
}

struct TickOut {
    done: bool,
    emit: Option<Progress>,
}

struct Run {
    runner: dt::TransitionRunner,
    from: DeckId,
    to: DeckId,
    clock: BeatClock,
    before: Before,
    /// The engine's phase sync fits this pair (false = half / double time: tempo set by hand).
    engine_sync: bool,
    /// Decks the run synced (and so locked).
    synced: [bool; 4],
    echo_beats: [f64; 4],
    /// [`EngineLike::track_tag`] of the outgoing and the incoming deck when the run started.
    tracks: [u64; 2],
    /// Tick at which the plan paused the outgoing deck.
    from_paused: Option<u32>,
    errors: Vec<String>,
    ticks: u32,
    idle_ticks: u32,
    last: Progress,
}

impl Run {
    /// `start_beat` = beats to wait before the automation starts; `bpm` = tempo until the first
    /// clock sample.
    fn new(
        automation: dt::Automation,
        from: DeckId,
        to: DeckId,
        start_beat: f64,
        bpm: f64,
        before: Before,
        engine_sync: bool,
    ) -> Self {
        let mut run = Run {
            runner: dt::TransitionRunner::new(automation, start_beat),
            from,
            to,
            clock: BeatClock {
                pos: 0.0,
                bpm,
                last_frame: None,
            },
            before,
            engine_sync,
            synced: [false; 4],
            echo_beats: [0.0; 4],
            tracks: [0; 2],
            from_paused: None,
            errors: Vec::new(),
            ticks: 0,
            idle_ticks: 0,
            last: Progress::default(),
        };
        run.last = run.progress(false, false);
        run
    }

    fn note(&mut self, error: String) {
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(error);
        }
    }

    fn progress(&self, done: bool, cancelled: bool) -> Progress {
        let length = self.runner.automation.length_beats.max(1e-9);
        let rel = self.clock.pos - self.runner.start_beat;
        Progress {
            running: !done,
            progress: if done && !cancelled {
                1.0
            } else {
                (rel / length).clamp(0.0, 1.0)
            },
            done,
            cancelled,
            waiting: !done && rel < 0.0,
            beats_until_start: (-rel).max(0.0),
            length_beats: length,
            from_deck: deck_name(self.from).to_string(),
            to_deck: deck_name(self.to).to_string(),
            errors: self.errors.clone(),
        }
    }

    fn apply<E: EngineLike>(&mut self, engine: &E, cmd: dt::AutoCmd) {
        let cmd = match cmd {
            dt::AutoCmd::Set {
                target: target @ dt::Target::Volume { .. },
                value,
            } => dt::AutoCmd::Set {
                target,
                value: value * self.before.level,
            },
            other => other,
        };
        if let dt::AutoCmd::Event { event } = cmd {
            match event {
                dt::Event::Pause { deck } if usize::from(deck) == self.from.index() => {
                    self.from_paused = Some(self.ticks);
                }
                dt::Event::Sync { deck } => {
                    if !self.engine_sync {
                        return;
                    }
                    if let Some(flag) = self.synced.get_mut(usize::from(deck)) {
                        *flag = true;
                    }
                }
                _ => {}
            }
        }
        if let Err(e) = apply_auto(engine, &cmd, &mut self.echo_beats) {
            self.note(e);
        }
    }

    /// Switch off the echoes the run switched on.
    fn echoes_off<E: EngineLike>(&self, engine: &E) {
        for (deck, beats) in DeckId::ALL.into_iter().zip(self.echo_beats) {
            if beats > 0.0 {
                engine.echo_off(deck);
            }
        }
    }

    /// Release the sync lock on every deck the run locked (a deck locked before the run stays
    /// locked).
    fn unlock_synced<E: EngineLike>(&self, engine: &E) {
        for (i, deck) in DeckId::ALL.into_iter().enumerate() {
            if self.synced[i] && !self.before.locked[i] {
                engine.unlock(deck);
            }
        }
    }

    /// The run ends early (cancelled, or a deck got another track): the mixer keeps the values
    /// it has, but what the run SWITCHED ON goes off: its echoes and its sync lock. A lock left
    /// behind would keep the incoming deck following the other deck's tempo.
    fn release<E: EngineLike>(&self, engine: &E) {
        self.echoes_off(engine);
        self.unlock_synced(engine);
    }

    /// The automation is over: echoes off, the sync lock the run added released, and the
    /// outgoing deck (when the plan paused it and nobody started it again) gets its strip back.
    fn finish<E: EngineLike>(&mut self, engine: &E) {
        self.echoes_off(engine);
        self.unlock_synced(engine);
        let Some(paused_at) = self.from_paused else {
            return;
        };
        // The audio thread's flag lags a command by one buffer: it only counts for a pause
        // sent in an earlier tick.
        let live = paused_at != self.ticks && engine.is_playing(self.from);
        if live || engine.play_intent(self.from) {
            return;
        }
        for cmd in std::mem::take(&mut self.before.restore) {
            if let Err(e) = apply_auto(engine, &cmd, &mut self.echo_beats) {
                self.note(e);
            }
        }
        if let Some(on) = self.before.stems {
            engine.stems(self.from, on);
        }
    }

    /// Give the run up (engine gone or stalled): reported as cancelled, nothing restored.
    fn abort(&mut self, why: &str) -> TickOut {
        self.note(why.to_string());
        self.last = self.progress(true, true);
        TickOut {
            done: true,
            emit: Some(self.last.clone()),
        }
    }

    /// Take the two decks' tracks as the ones this run belongs to.
    fn bind_tracks<E: EngineLike>(&mut self, engine: &E) {
        self.tracks = [engine.track_tag(self.from), engine.track_tag(self.to)];
    }

    /// The deck that no longer holds the track the run started with, if any.
    fn changed_deck<E: EngineLike>(&self, engine: &E) -> Option<DeckId> {
        [self.from, self.to]
            .into_iter()
            .zip(self.tracks)
            .find(|(deck, tag)| engine.track_tag(*deck) != *tag)
            .map(|(deck, _)| deck)
    }

    fn tick<E: EngineLike>(&mut self, engine: &E, sample: ClockSample) -> TickOut {
        // Another track on either deck: the lanes were written for the two tracks the run
        // started with. Stop before anything else reaches the new track; like a cancel, only
        // what the run switched on (echo, sync lock) is switched off, and nothing of the old
        // track is put back.
        if let Some(deck) = self.changed_deck(engine) {
            self.release(engine);
            return self.abort(&track_changed(deck));
        }
        if self.clock.advance(sample) {
            self.idle_ticks = 0;
        } else {
            self.idle_ticks += 1;
            if self.idle_ticks >= STALL_TICKS {
                // The same engine comes back when the output device does: what the run
                // switched on must not be waiting there.
                self.release(engine);
                return self.abort("the audio engine stopped");
            }
        }
        for cmd in self.runner.tick(self.clock.pos) {
            self.apply(engine, cmd);
        }
        let done = self.runner.is_done();
        if done {
            self.finish(engine);
        }
        let emit = done || self.ticks.is_multiple_of(EMIT_EVERY);
        self.ticks = self.ticks.wrapping_add(1);
        self.last = self.progress(done, false);
        TickOut {
            done,
            emit: emit.then(|| self.last.clone()),
        }
    }
}

/// What starting a run does to the decks first.
#[derive(Debug, Clone, PartialEq)]
struct Prep {
    /// Beats until the automation starts.
    until: f64,
    /// Seek the incoming deck here (it is not playing yet).
    cue: Option<f64>,
    /// Tempo ratio for the incoming deck (plans that beat-match only).
    tempo: Option<f64>,
    /// Let the engine phase-sync the incoming deck on the plan's sync event.
    engine_sync: bool,
}

fn prepare(from: &DeckState, to: &DeckState, plan: &RunPlan) -> Result<Prep, String> {
    let name = |d: &DeckState| deck_name(d.id).to_uppercase();
    if !from.loaded || !to.loaded {
        let empty = if from.loaded { to } else { from };
        return Err(format!("deck {} has no track", name(empty)));
    }
    if !from.playing {
        return Err(format!("deck {} is not playing", name(from)));
    }
    let until = match plan.start_sec {
        Some(start) => {
            if !valid_bpm(from.bpm) {
                return Err(format!("deck {} has no tempo", name(from)));
            }
            let beats = (start - from.position) * from.bpm / 60.0;
            if beats < -LATE_BEATS {
                return Err("the planned start has passed: plan again".into());
            }
            beats.max(0.0)
        }
        None => plan.beats_until_start.unwrap_or(0.0),
    };
    if !(0.0..=MAX_WAIT_BEATS).contains(&until) {
        return Err("the planned start is too far away: plan again".into());
    }
    // Tempo of the incoming deck that matches what the outgoing one sounds like now, in the
    // nearest of straight, half and double time.
    let wants_sync =
        plan.automation.events.iter().any(
            |e| matches!(e.event, dt::Event::Sync { deck } if usize::from(deck) == to.id.index()),
        );
    let audible = from.bpm * from.tempo;
    let (ratio, engine_sync) = if valid_bpm(audible) && valid_bpm(to.bpm) {
        let straight = audible / to.bpm;
        let best = [straight, straight * 2.0, straight / 2.0]
            .into_iter()
            .min_by(|p, q| (p - 1.0).abs().total_cmp(&(q - 1.0).abs()))
            .unwrap_or(straight);
        (Some(best.clamp(0.5, 1.5)), best == straight)
    } else {
        (None, true)
    };
    Ok(Prep {
        until,
        cue: if to.playing {
            None
        } else {
            plan.to_cue_sec.map(|c| c.min(to.duration.max(0.0)))
        },
        tempo: ratio.filter(|_| wants_sync && !to.playing),
        engine_sync,
    })
}

/// What the crossfader lets through of a deck (0..1; a deck on THRU is not affected).
fn crossfader_share(mixer: &MixerState, deck: &DeckState) -> f32 {
    let law = mixer.crossfader_curve.law();
    match deck.crossfader_assign {
        CrossfaderAssign::Thru => 1.0,
        CrossfaderAssign::A => crossfader_gain(mixer.crossfader, true, law),
        CrossfaderAssign::B => crossfader_gain(mixer.crossfader, false, law),
    }
}

/// A plan moves channel faders, never the crossfader: with the crossfader over on the outgoing
/// deck's side the transition would end quiet or silent. Refused while the incoming deck gets
/// less than half (−6 dB) of what the outgoing deck gets.
fn check_crossfader(mixer: &MixerState, from: &DeckState, to: &DeckState) -> Result<(), String> {
    let out = crossfader_share(mixer, from);
    let inc = crossfader_share(mixer, to);
    if inc.is_finite() && out.is_finite() && inc >= MIN_CROSSFADER_SHARE * out {
        return Ok(());
    }
    Err(format!(
        "the crossfader cuts deck {}: centre it first",
        deck_name(to.id).to_uppercase()
    ))
}

fn start_run(engine: &Engine, plan: RunPlan, from: DeckId, to: DeckId) -> Result<Run, String> {
    let snap = engine.snapshot_state();
    let deck = |id: DeckId| {
        snap.decks
            .iter()
            .find(|d| d.id == id)
            .ok_or_else(|| format!("deck {} is missing", deck_name(id)))
    };
    let (f, t) = (deck(from)?, deck(to)?);
    let prep = prepare(f, t, &plan)?;
    check_crossfader(&snap, f, t)?;
    let sample = clock_sample(&engine.clock_state(), from);
    let bpm = [sample.deck_bpm, sample.master_bpm, f.bpm * f.tempo]
        .into_iter()
        .find(|b| valid_bpm(*b))
        .ok_or("there is no tempo to run the transition on")?;
    if let Some(cue) = prep.cue {
        engine.send(Command::Seek(to, cue));
    }
    if let Some(ratio) = prep.tempo {
        mirror_deck(engine, to, |d| d.tempo = ratio);
        engine.send(Command::Tempo(to, ratio));
    }
    let locked = engine.perf().sync_lock;
    let before = before_run(f, &plan.automation, from, locked);
    let mut run = Run::new(
        plan.automation,
        from,
        to,
        prep.until,
        bpm,
        before,
        prep.engine_sync,
    );
    // The wait is measured from now, not from the runner thread's first tick.
    run.clock.last_frame = Some(sample.frame);
    // The run belongs to the two tracks the decks hold now.
    run.bind_tracks(engine);
    Ok(run)
}

// ---- managed state + runner thread ----------------------------------------------------------

#[derive(Default)]
struct Shared {
    run: Mutex<Option<Run>>,
    wake: Condvar,
    /// The thread that ticks runs exists. False until `init` started it, when it could not be
    /// started, and after it ended: a run accepted then would wait for ever.
    alive: AtomicBool,
}

impl Shared {
    /// Refuse a run nobody would tick.
    fn runner_ready(&self) -> Result<(), String> {
        if self.alive.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(NO_RUNNER.into())
        }
    }
}

/// Clears `alive` when the runner thread ends, however it ends.
struct AliveGuard(Arc<Shared>);

impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.alive.store(false, Ordering::Release);
    }
}

/// Start the thread that plays transitions; `body` is its whole life. `alive` is true from
/// before the thread exists (a run accepted right after this returns is ticked) until `body`
/// returns or the thread could not be started.
fn spawn_runner(
    shared: &Arc<Shared>,
    body: impl FnOnce(&Shared) + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    shared.alive.store(true, Ordering::Release);
    let guard = AliveGuard(shared.clone());
    let spawned = std::thread::Builder::new()
        .name("copilot-run".into())
        .spawn(move || {
            // The whole guard lives in the thread: `alive` falls when the thread ends.
            let guard = guard;
            let shared: &Shared = &guard.0;
            body(shared);
        });
    if spawned.is_err() {
        // The closure (and its guard) was dropped with the failed spawn; say it here too.
        shared.alive.store(false, Ordering::Release);
    }
    spawned
}

/// Hand a new run to the runner thread. Refused before `make` is called (it cues and
/// tempo-matches the incoming deck) when no thread would tick the run or one is running.
/// Lock order: the run slot, then whatever `make` locks (the engine).
fn accept_run(
    shared: &Shared,
    make: impl FnOnce() -> Result<Run, String>,
) -> Result<Progress, String> {
    shared.runner_ready()?;
    let mut slot = lock(&shared.run);
    if slot.is_some() {
        return Err("a transition is already running".into());
    }
    let run = make()?;
    let first = run.last.clone();
    *slot = Some(run);
    drop(slot);
    shared.wake.notify_all();
    Ok(first)
}

/// Managed state of the co-pilot (keep the type name: `lib.rs` manages `CopilotCtl::default()`).
/// Lock order everywhere: the run first, then the engine.
#[derive(Default)]
pub struct CopilotCtl(Arc<Shared>);

fn run_loop(app: &tauri::AppHandle, shared: &Shared) {
    loop {
        {
            let slot = lock(&shared.run);
            let mut slot = shared
                .wake
                .wait_while(slot, |run| run.is_none())
                .unwrap_or_else(PoisonError::into_inner);
            let Some(run) = slot.as_mut() else {
                continue;
            };
            let out = {
                let engines = app.state::<EngineState>();
                let guard = lock(&engines.0);
                match guard.as_ref() {
                    Some(engine) => {
                        let sample = clock_sample(&engine.clock_state(), run.from);
                        run.tick(engine, sample)
                    }
                    None => run.abort("the audio engine is not running"),
                }
            };
            if out.done {
                *slot = None;
            }
            // Emitted while the run slot is held: `copilot_cancel` emits under the same lock,
            // so its "cancelled" can never be overtaken by a "running" event of this tick.
            if let Some(progress) = out.emit {
                let _ = app.emit(EVENT, progress);
            }
        }
        std::thread::sleep(TICK);
    }
}

/// Called once from the app setup: starts the thread that plays transitions.
pub fn init(app: &tauri::AppHandle) {
    let shared = app.state::<CopilotCtl>().0.clone();
    let handle = app.clone();
    if let Err(e) = spawn_runner(&shared, move |shared| run_loop(&handle, shared)) {
        // `copilot_run` answers with an error from now on (see `Shared::runner_ready`).
        log::error!("co-pilot: could not start the transition thread: {e}");
    }
}

// ---- commands -------------------------------------------------------------------------------

/// Rank `candidates` as the next track after `playing`. `energy` = `hold` (default) | `up` |
/// `down`; `limit` 1..200 (default 8). `key_shift` = true: propose a key shift of one or two
/// semitones for a clashing track that it makes fit, and rank that track by the proposal
/// (never above a candidate that fits as it is; default false: the plain ranking).
/// `playing.key` is the reference key as the UI gives it: the desktop sends the key the deck
/// sounds in (its whole key shift applied).
#[tauri::command]
pub fn copilot_rank(
    playing: TrackFeat,
    candidates: Vec<CandidateIn>,
    energy: Option<String>,
    limit: Option<u32>,
    key_shift: Option<bool>,
) -> Result<Vec<RankedOut>, String> {
    rank_impl(playing, candidates, energy.as_deref(), limit, key_shift)
}

/// Plan a transition from `from` (on `from_deck`, playhead at `from_pos_sec`) to `to` (on
/// `to_deck`). `bars` 1..64 and `style` are optional (automatic when left out).
#[tauri::command]
pub fn copilot_plan(
    from: TrackFeat,
    to: TrackFeat,
    from_deck: String,
    to_deck: String,
    from_pos_sec: f64,
    bars: Option<u32>,
    style: Option<String>,
) -> Result<PlanInfo, String> {
    plan_impl(
        from,
        to,
        &from_deck,
        &to_deck,
        from_pos_sec,
        bars,
        style.as_deref(),
    )
}

/// Run a plan: `plan_json` is the object `copilot_plan` returned (or a bare automation). The
/// outgoing deck must be playing and the incoming one loaded; an incoming deck that is not
/// playing is cued on its first downbeat and, for plans that beat-match, tempo-matched.
/// Progress arrives on `copilot://progress`.
#[tauri::command]
pub fn copilot_run(
    plan_json: String,
    from_deck: String,
    to_deck: String,
    ctl: State<'_, CopilotCtl>,
    engines: State<'_, EngineState>,
) -> Result<Progress, String> {
    let from = parse_deck(&from_deck)?;
    let to = parse_deck(&to_deck)?;
    if from == to {
        return Err("the two decks must be different".into());
    }
    let plan = parse_run_plan(&plan_json, from, to)?;
    accept_run(&ctl.0, || {
        let guard = lock(&engines.0);
        let engine = guard.as_ref().ok_or("engine not running")?;
        start_run(engine, plan, from, to)
    })
}

/// Stop the running transition. The decks keep the values they have now; an echo and a sync
/// lock the run switched on are switched off. Returns whether one ran.
#[tauri::command]
pub fn copilot_cancel(
    app: tauri::AppHandle,
    ctl: State<'_, CopilotCtl>,
    engines: State<'_, EngineState>,
) -> bool {
    // The slot stays locked until the event is out (see `run_loop`). Order: run, then engine.
    let mut slot = lock(&ctl.0.run);
    let Some(run) = slot.take() else {
        return false;
    };
    if let Some(engine) = lock(&engines.0).as_ref() {
        run.release(engine);
    }
    let _ = app.emit(EVENT, run.progress(true, true));
    drop(slot);
    true
}

/// The running transition, if any (for a UI that was reloaded mid-run).
#[tauri::command]
pub fn copilot_status(ctl: State<'_, CopilotCtl>) -> Option<Progress> {
    lock(&ctl.0.run).as_ref().map(|run| run.last.clone())
}

/// 32-bar look-ahead for the playing deck: the track ending with nothing ready, a plan that no
/// longer fits, tempo gap, key clash, loudness jump, missing beatgrid. Most severe first.
#[tauri::command]
pub fn copilot_safety(
    playing: TrackFeat,
    position_sec: f64,
    tempo_ratio: f64,
    next: Option<TrackFeat>,
    planned_bars: Option<u32>,
) -> Result<Vec<WarningOut>, String> {
    safety_impl(playing, position_sec, tempo_ratio, next, planned_bars)
}

/// Parse a typed RO / EN command offline; `null` = not a command.
#[tauri::command]
pub fn copilot_intent(text: String) -> Option<IntentOut> {
    intent_impl(&text)
}

/// JSON Schema of an intent, for a structured-output request to codai (not called here).
#[tauri::command]
pub fn copilot_intent_schema() -> String {
    dt::LLM_INTENT_SCHEMA.to_string()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::json;

    use super::*;

    const A: DeckId = DeckId::A;
    const B: DeckId = DeckId::B;

    fn feat(id: &str, bpm: f64, key: &str) -> TrackFeat {
        TrackFeat {
            id: id.into(),
            title: id.into(),
            artist: format!("artist {id}"),
            bpm: Some(bpm),
            key: Some(key.into()),
            energy: Some(6.0),
            duration_sec: 360.0,
            ..Default::default()
        }
    }

    fn cand(track: TrackFeat) -> CandidateIn {
        CandidateIn {
            track,
            played_minutes_ago: None,
        }
    }

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Volume(DeckId, f32),
        Eq(DeckId, &'static str, f32),
        Filter(DeckId, f32),
        Stem(DeckId, usize, f32),
        Echo(DeckId, f32, f64),
        EchoOff(DeckId),
        Play(DeckId),
        Pause(DeckId),
        Sync(DeckId),
        Unlock(DeckId),
        Stems(DeckId, bool),
    }

    /// Records every call; `intent` is the transport state per deck.
    #[derive(Default)]
    struct Mock {
        calls: RefCell<Vec<Call>>,
        intent: RefCell<[bool; 4]>,
        /// What `track_tag` answers per deck (a load changes it).
        tags: RefCell<[u64; 4]>,
    }

    impl Mock {
        fn playing(deck: DeckId) -> Self {
            let m = Mock::default();
            m.intent.borrow_mut()[deck.index()] = true;
            m
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.borrow().clone()
        }

        fn push(&self, c: Call) {
            self.calls.borrow_mut().push(c);
        }
    }

    impl EngineLike for Mock {
        fn volume(&self, deck: DeckId, value: f32) {
            self.push(Call::Volume(deck, value));
        }
        fn eq(&self, deck: DeckId, band: &'static str, db: f32) {
            self.push(Call::Eq(deck, band, db));
        }
        fn filter(&self, deck: DeckId, value: f32) {
            self.push(Call::Filter(deck, value));
        }
        fn stem_gain(&self, deck: DeckId, stem: usize, gain: f32) {
            self.push(Call::Stem(deck, stem, gain));
        }
        fn echo(&self, deck: DeckId, wet: f32, beats: f64) {
            self.push(Call::Echo(deck, wet, beats));
        }
        fn echo_off(&self, deck: DeckId) {
            self.push(Call::EchoOff(deck));
        }
        fn play(&self, deck: DeckId) {
            self.intent.borrow_mut()[deck.index()] = true;
            self.push(Call::Play(deck));
        }
        fn pause(&self, deck: DeckId) {
            self.intent.borrow_mut()[deck.index()] = false;
            self.push(Call::Pause(deck));
        }
        fn sync(&self, deck: DeckId) {
            self.push(Call::Sync(deck));
        }
        fn unlock(&self, deck: DeckId) {
            self.push(Call::Unlock(deck));
        }
        fn stems(&self, deck: DeckId, on: bool) {
            self.push(Call::Stems(deck, on));
        }
        fn play_intent(&self, deck: DeckId) -> bool {
            self.intent.borrow()[deck.index()]
        }
        fn is_playing(&self, deck: DeckId) -> bool {
            self.intent.borrow()[deck.index()]
        }
        fn track_tag(&self, deck: DeckId) -> u64 {
            self.tags.borrow()[deck.index()]
        }
    }

    /// Deck A as it is before a run: playing at fader 0.8 with the highs at −3 dB.
    fn deck_a() -> DeckState {
        let mut d = DeckState::empty(A);
        d.loaded = true;
        d.playing = true;
        d.volume = 0.8;
        d.eq_high = -3.0;
        d.bpm = 128.0;
        d.duration = 360.0;
        d
    }

    /// Deck B as it is before a run: loaded, not playing.
    fn deck_b() -> DeckState {
        let mut d = DeckState::empty(B);
        d.loaded = true;
        d.bpm = 128.0;
        d.duration = 360.0;
        d
    }

    /// 128 BPM on both sides, the playhead of A at `pos` seconds.
    fn plan_at(style: &str, bars: u32, pos: f64) -> PlanInfo {
        plan_impl(
            feat("a", 128.0, "8A"),
            feat("b", 128.0, "8A"),
            "a",
            "b",
            pos,
            Some(bars),
            Some(style),
        )
        .unwrap()
    }

    fn plan(style: &str, bars: u32) -> PlanInfo {
        plan_at(style, bars, 60.0)
    }

    fn run_plan(plan: &PlanInfo) -> RunPlan {
        parse_run_plan(&serde_json::to_string(plan).unwrap(), A, B).unwrap()
    }

    /// A run of `plan` from A (as `deck`) to B that starts after `wait` beats.
    fn run_from(deck: &DeckState, plan: &PlanInfo, wait: f64, engine_sync: bool) -> Run {
        let automation = run_plan(plan).automation;
        let before = before_run(deck, &automation, A, [false; 4]);
        Run::new(automation, A, B, wait, 128.0, before, engine_sync)
    }

    fn run_of(plan: &PlanInfo, wait: f64) -> Run {
        run_from(&deck_a(), plan, wait, true)
    }

    /// Feed 20 ms clock samples (48 kHz, 128 BPM) until the run ends. `each` runs after every
    /// tick. Returns the progress events and the number of ticks.
    fn drive(run: &mut Run, mock: &Mock, mut each: impl FnMut(&Mock)) -> (Vec<Progress>, u32) {
        let mut frame = 0u64;
        let mut events = Vec::new();
        for tick in 1..=5000u32 {
            frame += 960;
            let out = run.tick(
                mock,
                ClockSample {
                    frame,
                    sample_rate: 48_000,
                    deck_bpm: 128.0,
                    master_bpm: 128.0,
                },
            );
            events.extend(out.emit);
            each(mock);
            if out.done {
                return (events, tick);
            }
        }
        panic!("the run never finished");
    }

    fn first(calls: &[Call], wanted: &Call) -> usize {
        calls
            .iter()
            .position(|c| c == wanted)
            .unwrap_or_else(|| panic!("{wanted:?} was never called"))
    }

    fn last(calls: &[Call], wanted: &Call) -> usize {
        calls
            .iter()
            .rposition(|c| c == wanted)
            .unwrap_or_else(|| panic!("{wanted:?} was never called"))
    }

    fn fader(calls: &[Call], deck: DeckId) -> Vec<f32> {
        calls
            .iter()
            .filter_map(|c| match c {
                Call::Volume(d, v) if *d == deck => Some(*v),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn track_features_come_from_camel_case_json() {
        let f: TrackFeat = serde_json::from_value(json!({
            "id": "7", "title": "T", "artist": "A", "bpm": 129.2, "key": " 8A ", "energy": null,
            "durationSec": 200.5, "firstBeatSec": 0.12, "downbeatOffset": 0, "lufs": null,
            "hasStems": true
        }))
        .unwrap();
        let t = f.features("playing").unwrap();
        assert_eq!(t.id, "7");
        assert_eq!(t.bpm, Some(129.2));
        assert_eq!(t.key.as_deref(), Some("8A"));
        assert_eq!(t.energy, None);
        assert_eq!((t.duration_sec, t.first_beat_sec), (200.5, 0.12));
        assert!(t.has_stems);
        // A library row may carry the id only.
        let bare: TrackFeat = serde_json::from_value(json!({ "id": "9" })).unwrap();
        let t = bare.features("x").unwrap();
        assert_eq!(t.id, "9");
        assert_eq!((t.bpm, t.key, t.energy), (None, None, None));
        assert_eq!((t.duration_sec, t.has_stems), (0.0, false));
    }

    #[test]
    fn unknown_values_are_dropped_and_bad_numbers_refused() {
        let with = |edit: fn(&mut TrackFeat)| {
            let mut f = feat("x", 124.0, "8A");
            edit(&mut f);
            f.features("t")
        };
        assert_eq!(with(|f| f.bpm = Some(0.0)).unwrap().bpm, None);
        assert_eq!(with(|f| f.bpm = Some(999.0)).unwrap().bpm, None);
        assert_eq!(with(|f| f.energy = Some(6.4)).unwrap().energy, Some(6));
        assert_eq!(with(|f| f.energy = Some(0.0)).unwrap().energy, None);
        assert_eq!(with(|f| f.energy = Some(11.0)).unwrap().energy, None);
        assert_eq!(with(|f| f.key = Some("   ".into())).unwrap().key, None);
        assert_eq!(with(|f| f.downbeat_offset = 9).unwrap().downbeat_offset, 3);
        let long = with(|f| f.title = "ț".repeat(5000)).unwrap();
        assert_eq!(long.title.chars().count(), MAX_TEXT);
        for bad in [
            with(|f| f.bpm = Some(f64::NAN)),
            with(|f| f.energy = Some(f64::INFINITY)),
            with(|f| f.lufs = Some(f64::NAN)),
            with(|f| f.duration_sec = f64::NAN),
            with(|f| f.duration_sec = -1.0),
            with(|f| f.first_beat_sec = f64::NEG_INFINITY),
        ] {
            let e = bad.unwrap_err();
            assert!(e.starts_with("t."), "{e}");
        }
    }

    #[test]
    fn a_key_that_is_not_camelot_is_unknown_and_cannot_crash_the_ranking() {
        let key = |raw: &str| {
            let mut f = feat("x", 124.0, "8A");
            f.key = Some(raw.into());
            f.features("t").unwrap().key
        };
        let long = "♭".repeat(200);
        // Tags as files and other tools write them: musical names, a multibyte last character,
        // full-width text that is no key, nothing, far too much.
        for bad in [
            "",
            " ",
            "\u{3000}",
            "A",
            "8",
            "♭",
            "A♭",
            "Am♭",
            "8♭",
            "8♯",
            "F♯m",
            "é",
            "8é",
            "🎧",
            "8A🎧",
            "13A",
            "0B",
            "8C",
            "８Ｃ",
            "8 A",
            "+8A",
            "8A\u{200b}",
            "A minor",
            "000000008A",
            long.as_str(),
        ] {
            assert_eq!(key(bad), None, "{bad:?}");
        }
        for (raw, want) in [
            ("8A", "8A"),
            (" 12b ", "12B"),
            ("８Ａ", "8A"),
            ("8Ａ", "8A"),
            ("\u{3000}１２ｂ", "12B"),
            ("08a", "8A"),
        ] {
            assert_eq!(key(raw).as_deref(), Some(want), "{raw:?}");
        }

        // End to end: such rows in the pool, on the playing deck and as the next track.
        let hostile = ["A♭", "8Ａ", "Am♭", "♭", "8♭", long.as_str()];
        let mut pool: Vec<CandidateIn> = hostile
            .iter()
            .enumerate()
            .map(|(i, k)| cand(feat(&format!("h{i}"), 124.0, k)))
            .collect();
        pool.push(cand(feat("ok", 124.0, "9A")));
        let r = rank_impl(feat("now", 124.0, "8A"), pool.clone(), None, Some(50), None).unwrap();
        assert_eq!(r.len(), 7, "every row is ranked");
        let reason = |id: &str| r.iter().find(|x| x.id == id).unwrap().reasons[0].clone();
        assert_eq!(reason("h0"), "key_unknown");
        assert_eq!(reason("h1"), "key_same", "a full-width 8A is 8A");
        assert_eq!(reason("h2"), "key_unknown");
        assert_eq!(reason("ok"), "key_adjacent");
        for k in hostile {
            assert!(rank_impl(feat("now", 124.0, k), pool.clone(), None, None, None).is_ok());
            // With proposals asked for, a key that is not Camelot is still just unknown.
            let on = rank_impl(feat("now", 124.0, k), pool.clone(), None, None, Some(true));
            assert!(on.is_ok(), "{k:?}");
            let p = plan_impl(
                feat("a", 128.0, k),
                feat("b", 128.0, k),
                "a",
                "b",
                60.0,
                None,
                None,
            );
            assert!(p.is_ok(), "{k:?}: {p:?}");
            let mut playing = feat("a", 120.0, k);
            playing.duration_sec = 300.0;
            let w = safety_impl(playing, 280.0, 1.0, Some(feat("b", 120.0, k)), Some(4)).unwrap();
            assert!(!w.iter().any(|x| x.code == "key_clash"), "{k:?}: {w:?}");
        }
    }

    #[test]
    fn the_deck_tag_follows_the_track_not_what_is_done_with_it() {
        let a = deck_a();
        let tag = deck_tag(&a);
        let mut same = a.clone();
        same.playing = false;
        same.position = 123.0;
        same.volume = 0.1;
        same.eq_low = -26.0;
        same.filter = 0.7;
        same.tempo = 1.08;
        same.bpm = 127.5;
        same.stems_active = true;
        assert_eq!(deck_tag(&same), tag, "playing and mixing a track keeps it");
        let changed = |edit: fn(&mut DeckState)| {
            let mut d = deck_a();
            edit(&mut d);
            deck_tag(&d)
        };
        assert_ne!(changed(|d| d.track_id = Some("42".into())), tag);
        assert_ne!(changed(|d| d.title = Some("another file".into())), tag);
        assert_ne!(changed(|d| d.artist = Some("someone".into())), tag);
        assert_ne!(changed(|d| d.duration = 201.5), tag);
        assert_ne!(changed(|d| d.loaded = false), tag);
    }

    #[test]
    fn a_deck_that_gets_another_track_ends_the_run_and_nothing_is_put_on_it() {
        let sample = |frame: u64| ClockSample {
            frame,
            sample_rate: 48_000,
            deck_bpm: 128.0,
            master_bpm: 128.0,
        };
        // An echo out, two seconds in, then a load on the outgoing or on the incoming deck.
        for (deck, name) in [(A, "A"), (B, "B")] {
            let mut run = run_of(&plan("echo_out", 4), 0.0);
            let mock = Mock::playing(A);
            *mock.tags.borrow_mut() = [11, 22, 33, 44];
            run.bind_tracks(&mock);
            let mut frame = 0;
            for _ in 0..120 {
                frame += 960;
                assert!(!run.tick(&mock, sample(frame)).done);
            }
            // Another deck (C) loading something is none of the run's business.
            mock.tags.borrow_mut()[2] = 99;
            frame += 960;
            assert!(!run.tick(&mock, sample(frame)).done);
            let so_far = mock.calls().len();
            mock.tags.borrow_mut()[deck.index()] = 99;
            frame += 960;
            let out = run.tick(&mock, sample(frame));
            let p = out.emit.expect("the end is reported");
            assert!(out.done && p.done && p.cancelled && !p.running, "{p:?}");
            assert_eq!(
                p.errors,
                vec![format!(
                    "deck {name} got another track: the transition was stopped"
                )]
            );
            assert!(p.progress > 0.2 && p.progress < 0.4, "{}", p.progress);
            // Only the echo the run switched on is switched off: no lane value, no pause.
            assert_eq!(mock.calls()[so_far..], [Call::EchoOff(A)], "deck {name}");
        }

        // The worst moment: one tick before a bass swap ends and hands the outgoing strip back
        // (fader 0.8, highs -3 dB of the OLD track). With the new track there, nothing is sent.
        let mut run = run_of(&plan("bass_swap", 4), 0.0);
        let mock = Mock::playing(A);
        *mock.tags.borrow_mut() = [11, 22, 0, 0];
        run.bind_tracks(&mock);
        let mut frame = 0;
        while run.last.progress < 0.99 {
            frame += 960;
            assert!(!run.tick(&mock, sample(frame)).done);
        }
        let so_far = mock.calls().len();
        assert!(so_far > 50 && !mock.calls().contains(&Call::Pause(A)));
        mock.tags.borrow_mut()[A.index()] = 12;
        let mut ended = None;
        for _ in 0..20 {
            frame += 960;
            let out = run.tick(&mock, sample(frame));
            if out.done {
                ended = out.emit;
                break;
            }
        }
        let p = ended.expect("the run ends on the next tick");
        assert!(p.cancelled && p.errors[0].starts_with("deck A got another track"));
        // No lane value and no pause; only the sync lock the run put on deck B comes off.
        assert_eq!(mock.calls()[so_far..], [Call::Unlock(B)]);

        // During the wait for the phrase: ended before anything was sent at all.
        let mut run = run_of(&plan("bass_swap", 4), 32.0);
        let mock = Mock::playing(A);
        run.bind_tracks(&mock);
        assert!(!run.tick(&mock, sample(960)).done);
        mock.tags.borrow_mut()[B.index()] = 5;
        let out = run.tick(&mock, sample(1920));
        assert!(out.done && out.emit.unwrap().cancelled);
        assert!(mock.calls().is_empty());

        // The same two tracks to the end: a normal run.
        let mut run = run_of(&plan("bass_swap", 4), 0.0);
        let mock = Mock::playing(A);
        *mock.tags.borrow_mut() = [11, 22, 0, 0];
        run.bind_tracks(&mock);
        let (events, _) = drive(&mut run, &mock, |_| {});
        let end = events.last().unwrap();
        assert!(end.done && !end.cancelled && end.errors.is_empty());
        assert_eq!(mock.calls().last(), Some(&Call::Volume(A, 0.8)));
    }

    #[test]
    fn a_run_is_refused_while_no_thread_would_tick_it() {
        use std::cell::Cell;
        let shared = Arc::new(Shared::default());
        let made = Cell::new(0u32);
        let make = || {
            made.set(made.get() + 1);
            Ok(run_of(&plan("cut", 1), 0.0))
        };
        // `init` never ran, or the thread could not be started.
        assert_eq!(accept_run(&shared, make).unwrap_err(), NO_RUNNER);
        assert_eq!(
            made.get(),
            0,
            "refused before a deck is cued or tempo-matched"
        );
        assert!(lock(&shared.run).is_none(), "nothing waits for ever");

        // A thread that is there: the run is taken, a second one is not.
        let (stop, wait) = std::sync::mpsc::channel::<()>();
        let runner = spawn_runner(&shared, move |_| {
            let _ = wait.recv();
        })
        .unwrap();
        let first = accept_run(&shared, make).unwrap();
        assert!(first.running && !first.done);
        assert_eq!(made.get(), 1);
        assert!(lock(&shared.run).is_some());
        assert_eq!(
            accept_run(&shared, make).unwrap_err(),
            "a transition is already running"
        );
        assert_eq!(made.get(), 1);
        // A start the engine refuses leaves the slot free.
        lock(&shared.run).take();
        let refused = accept_run(&shared, || Err("deck A is not playing".to_string()));
        assert_eq!(refused.unwrap_err(), "deck A is not playing");
        assert!(lock(&shared.run).is_none());

        // The thread ended: refused again.
        drop(stop);
        runner.join().unwrap();
        assert_eq!(accept_run(&shared, make).unwrap_err(), NO_RUNNER);
        assert_eq!(made.get(), 1);
    }

    #[test]
    fn rank_follows_the_energy_direction_and_limits() {
        let mut playing = feat("now", 124.0, "8A");
        playing.energy = Some(5.0);
        let list = || {
            let mut up = feat("up", 124.0, "8A");
            up.energy = Some(7.0);
            let mut down = feat("down", 124.0, "8A");
            down.energy = Some(3.0);
            vec![cand(up), cand(down), cand(feat("now", 124.0, "8A"))]
        };
        let r = rank_impl(playing.clone(), list(), Some("up"), None, None).unwrap();
        assert_eq!(r.len(), 2, "the playing track is not suggested");
        assert_eq!(r[0].id, "up");
        assert!(r[0].reasons.contains(&"energy_up".to_string()));
        let r = rank_impl(playing.clone(), list(), Some("down"), None, None).unwrap();
        assert_eq!(r[0].id, "down");
        let r = rank_impl(playing.clone(), list(), None, Some(0), None).unwrap();
        assert_eq!(r.len(), 1, "limit is clamped to 1..=200");
        let wire = serde_json::to_value(&r[0]).unwrap();
        assert!(wire.get("tempoRatio").is_some(), "{wire}");
        assert!(rank_impl(playing.clone(), list(), Some("sideways"), None, None).is_err());
        let many = vec![CandidateIn::default(); MAX_CANDIDATES + 1];
        assert!(rank_impl(playing.clone(), many, None, None, None).is_err());
        let mut bad = list();
        bad[1].track.duration_sec = f64::NAN;
        let e = rank_impl(playing, bad, None, None, None).unwrap_err();
        assert!(e.contains("candidates[1]"), "{e}");
    }

    #[test]
    fn recently_played_minutes_reach_the_ranking() {
        let fresh = cand(feat("fresh", 124.0, "8A"));
        let recent = CandidateIn {
            track: feat("recent", 124.0, "8A"),
            played_minutes_ago: Some(5.0),
        };
        let r = rank_impl(
            feat("now", 124.0, "8A"),
            vec![recent, fresh],
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(r[0].id, "fresh");
        assert!(r[1].reasons.contains(&"recently_played".to_string()));
    }

    /// A pool with every kind of key relation to 8A (see the names).
    fn key_pool() -> Vec<CandidateIn> {
        [
            ("same", "8A"),
            ("adjacent", "9A"),
            ("boost", "10A"),
            ("diagonal", "9B"),
            ("one-up", "1A"),
            ("one-down", "3A"),
            ("two-up", "5A"),
            ("two-down", "11A"),
            ("relative-by-one", "1B"),
            ("hopeless", "2B"),
            ("no-key", "A minor"),
        ]
        .iter()
        .map(|(id, key)| cand(feat(id, 124.0, key)))
        .collect()
    }

    #[test]
    fn the_key_shift_proposal_is_asked_for_and_off_by_default() {
        let now = || feat("now", 124.0, "8A");
        // Left out, null and false: the plain ranking, and it is the crate's `rank_next`.
        let plain = rank_impl(now(), key_pool(), None, Some(50), None).unwrap();
        let off = rank_impl(now(), key_pool(), None, Some(50), Some(false)).unwrap();
        assert_eq!(plain, off);
        assert_eq!(plain.len(), 11);
        assert!(
            plain
                .iter()
                .all(|r| r.key_shift.is_none() && r.key_after.is_none())
        );
        assert!(plain.iter().all(|r| r.reasons[0] != "key_shiftable"));
        let opts = dt::RankOptions {
            limit: 50,
            ..Default::default()
        };
        let list: Vec<dt::Candidate> = key_pool()
            .into_iter()
            .map(|c| dt::Candidate {
                track: c.track.features("c").unwrap(),
                played_minutes_ago: None,
            })
            .collect();
        let crate_plain = dt::rank_next(&now().features("p").unwrap(), &list, &opts);
        let same = |a: &RankedOut, b: &dt::Ranked| {
            a.id == b.id && a.score == b.score && a.key == b.key && a.reasons == b.reasons
        };
        assert_eq!(plain.len(), crate_plain.len());
        assert!(plain.iter().zip(&crate_plain).all(|(a, b)| same(a, b)));

        // Asked for: the five clashes a shift fixes carry it, nothing else does.
        let on = rank_impl(now(), key_pool(), None, Some(50), Some(true)).unwrap();
        let of = |list: &[RankedOut], id: &str| list.iter().find(|r| r.id == id).unwrap().clone();
        for (id, shift, after) in [
            ("one-up", 1i8, "8A"),
            ("one-down", -1, "8A"),
            ("two-up", 2, "7A"),
            ("two-down", -2, "9A"),
            ("relative-by-one", 1, "8B"),
        ] {
            let r = of(&on, id);
            assert_eq!(
                (r.key_shift, r.key_after.as_deref()),
                (Some(shift), Some(after)),
                "{id}"
            );
            assert_eq!(r.reasons[0], "key_shiftable", "{id}");
            let was = of(&plain, id);
            assert_eq!(was.reasons[0], "key_clash", "{id}");
            assert!(was.key < r.key && r.key < of(&on, "adjacent").key, "{id}");
            assert!(r.score > was.score, "{id}");
        }
        for id in [
            "same", "adjacent", "boost", "diagonal", "hopeless", "no-key",
        ] {
            assert_eq!(of(&on, id), of(&plain, id), "{id}");
        }
        assert!(
            of(&on, "one-up").key > of(&on, "two-up").key,
            "one semitone ranks above two"
        );
        // Never above a pair that fits as it is, everything else equal.
        let order: Vec<&str> = on.iter().map(|r| r.id.as_str()).collect();
        let at = |id: &str| order.iter().position(|x| *x == id).unwrap();
        assert!(at("adjacent") < at("one-up") && at("one-up") < at("boost"));
        assert!(at("boost") < at("two-up") && at("two-up") < at("diagonal"));
        assert!(at("diagonal") < at("hopeless"));
    }

    #[test]
    fn a_proposal_reaches_the_ui_below_every_track_that_fits_as_it_is() {
        // Nine adjacent-key tracks 3 BPM off and one clash dead on tempo that one semitone
        // fixes: by key, tempo and energy alone the clash would be first (0.88 against 0.871).
        let now = || feat("now", 124.0, "8A");
        let pool = || {
            let mut list: Vec<CandidateIn> = (0..9)
                .map(|i| cand(feat(&format!("fit{i}"), 127.0, "9A")))
                .collect();
            list.push(cand(feat("shift", 124.0, "1A")));
            list
        };
        let on = rank_impl(now(), pool(), None, Some(50), Some(true)).unwrap();
        assert_eq!(on.len(), 10);
        assert_eq!(on[9].id, "shift");
        assert_eq!(
            (on[9].key_shift, on[9].key_after.as_deref()),
            (Some(1), Some("8A"))
        );
        assert!(
            on[9].score < on[8].score,
            "the score on the wire is the capped one"
        );
        // The default list of the popover (8 rows): the proposal is not among them.
        let top = rank_impl(now(), pool(), None, None, Some(true)).unwrap();
        assert_eq!(top.len(), 8);
        assert!(top.iter().all(|r| r.id != "shift" && r.key_shift.is_none()));
        // Without the option the same track is a plain clash, last as before.
        let off = rank_impl(now(), pool(), None, Some(50), None).unwrap();
        assert_eq!(
            (off[9].id.as_str(), off[9].reasons[0].as_str()),
            ("shift", "key_clash")
        );
    }

    #[test]
    fn the_proposal_fields_are_always_on_the_wire_in_camel_case() {
        let now = || feat("now", 124.0, "8A");
        let on = rank_impl(now(), key_pool(), None, Some(50), Some(true)).unwrap();
        let wire = serde_json::to_value(&on).unwrap();
        let row = |id: &str| {
            wire.as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(row("one-down")["keyShift"], json!(-1));
        assert_eq!(row("one-down")["keyAfter"], json!("8A"));
        // No proposal: the two fields are there and null (a shell that knows proposals says so).
        let none = row("adjacent");
        let fields = none.as_object().unwrap();
        assert!(fields.contains_key("keyShift") && fields.contains_key("keyAfter"));
        assert_eq!(
            (&none["keyShift"], &none["keyAfter"]),
            (&json!(null), &json!(null))
        );
        // The same on the plain ranking.
        let plain = rank_impl(now(), key_pool(), None, Some(50), None).unwrap();
        let wire = serde_json::to_value(&plain[0]).unwrap();
        assert_eq!(wire["keyShift"], json!(null));
        assert!(wire.as_object().unwrap().contains_key("keyAfter"));
    }

    #[test]
    fn the_reference_key_is_the_sounding_key_the_ui_sends() {
        // Deck on 8A with its key shifted +1 sounds 3A: the UI sends 3A as `playing.key`.
        let sounding = feat("now", 124.0, "3A");
        let r = rank_impl(sounding, key_pool(), None, Some(50), Some(true)).unwrap();
        let of = |id: &str| r.iter().find(|x| x.id == id).unwrap().clone();
        // 3A itself now fits as it is; 8A (the deck's own printed key) needs +1 to 3A.
        assert_eq!(of("one-down").reasons[0], "key_same");
        assert_eq!(of("one-down").key_shift, None);
        assert_eq!(
            (of("same").key_shift, of("same").key_after),
            (Some(1), Some("3A".into()))
        );
        // The plan and the safety check read the same features: a plan made after the DJ
        // applied a proposal (incoming 1A shifted +1 sounds 8A, the UI sends 8A) is no clash.
        let clash = plan_impl(
            feat("a", 128.0, "8A"),
            feat("b", 128.0, "1A"),
            "a",
            "b",
            60.0,
            None,
            None,
        )
        .unwrap();
        assert!(
            clash.reasons.contains(&"key_clash_echo".to_string()),
            "{:?}",
            clash.reasons
        );
        let fixed = plan_impl(
            feat("a", 128.0, "8A"),
            feat("b", 128.0, "8A"),
            "a",
            "b",
            60.0,
            None,
            None,
        )
        .unwrap();
        assert!(
            !fixed.reasons.contains(&"key_clash_echo".to_string()),
            "{:?}",
            fixed.reasons
        );
        let mut playing = feat("a", 120.0, "8A");
        playing.duration_sec = 300.0;
        let w = safety_impl(
            playing.clone(),
            280.0,
            1.0,
            Some(feat("b", 120.0, "1A")),
            None,
        )
        .unwrap();
        assert!(w.iter().any(|x| x.code == "key_clash"), "{w:?}");
        let w = safety_impl(playing, 280.0, 1.0, Some(feat("b", 120.0, "8A")), None).unwrap();
        assert!(!w.iter().any(|x| x.code == "key_clash"), "{w:?}");
    }

    #[test]
    fn plan_checks_decks_bars_and_style() {
        let p = plan("bass_swap", 4);
        assert_eq!((p.style.as_str(), p.bars), ("bass_swap", 4));
        assert_eq!((p.from_deck.as_str(), p.to_deck.as_str()), ("a", "b"));
        assert_eq!(p.length_beats, 16.0);
        let a: dt::Automation = serde_json::from_str(&p.automation_json).unwrap();
        assert_eq!(a.length_beats, 16.0);
        let wire = serde_json::to_value(&p).unwrap();
        for key in [
            "startSec",
            "beatsUntilStart",
            "toCueSec",
            "toTempoRatio",
            "automationJson",
            "lengthBeats",
        ] {
            assert!(wire.get(key).is_some(), "{key} missing in {wire}");
        }
        assert_eq!(plan("cut", 8).bars, 1, "a cut is one bar");

        let go = |from: &str, to: &str, pos: f64, bars: Option<u32>, style: Option<&str>| {
            plan_impl(
                feat("a", 128.0, "8A"),
                feat("b", 128.0, "8A"),
                from,
                to,
                pos,
                bars,
                style,
            )
        };
        assert!(go("a", "b", 60.0, None, None).is_ok());
        assert!(go("a", "a", 60.0, None, None).is_err());
        assert!(go("a", "x", 60.0, None, None).is_err());
        assert!(go("a", "b", f64::NAN, None, None).is_err());
        assert!(go("a", "b", -1.0, None, None).is_err());
        assert!(go("a", "b", 60.0, Some(0), None).is_err());
        assert!(go("a", "b", 60.0, Some(65), None).is_err());
        assert!(go("a", "b", 60.0, None, Some("wobble")).is_err());
        let mut silent = feat("a", 128.0, "8A");
        silent.bpm = None;
        let e = plan_impl(silent, feat("b", 128.0, "8A"), "a", "b", 60.0, None, None).unwrap_err();
        assert!(e.contains("tempo"), "{e}");
    }

    #[test]
    fn run_plan_accepts_a_plan_or_a_bare_automation_and_refuses_the_rest() {
        let p = plan("bass_swap", 4);
        let full = run_plan(&p);
        assert_eq!(full.start_sec, Some(p.start_sec));
        assert_eq!(full.to_cue_sec, Some(p.to_cue_sec));
        assert_eq!(full.automation.length_beats, 16.0);

        // The documented format (docs/decks/transitions.md).
        let bare = r#"{"length_beats":4,
            "lanes":[{"target":{"kind":"volume","deck":1},"keys":[{"beat":0,"value":0},{"beat":4,"value":7}]}],
            "events":[{"beat":0,"event":"play","deck":1}]}"#;
        let b = parse_run_plan(bare, A, B).unwrap();
        assert_eq!(
            (b.start_sec, b.beats_until_start, b.to_cue_sec),
            (None, None, None)
        );
        assert_eq!(
            b.automation.lanes[0].keys[1].value, 1.0,
            "clamped to the fader range"
        );

        let err =
            |json: &str, from: DeckId, to: DeckId| parse_run_plan(json, from, to).unwrap_err();
        assert!(err("{not json", A, B).starts_with("plan:"));
        assert!(err(r#"{"automationJson":5}"#, A, B).starts_with("plan:"));
        assert!(err(r#"{"automationJson":"nope"}"#, A, B).starts_with("automation:"));
        assert!(err(bare, DeckId::C, DeckId::D).contains("not part of this transition"));
        let other_event = bare.replace(r#""event":"play","deck":1"#, r#""event":"play","deck":3"#);
        assert!(err(&other_event, A, B).contains("not part of this transition"));
        // A lane on a third deck, with every event on a deck of the transition.
        let other_lane = bare.replace(r#""kind":"volume","deck":1"#, r#""kind":"volume","deck":2"#);
        assert_eq!(
            err(&other_lane, A, B),
            "automation: deck index 2 is not part of this transition"
        );
        let band = bare.replace(
            r#""kind":"volume","deck":1"#,
            r#""kind":"eq","deck":1,"band":5"#,
        );
        assert!(err(&band, A, B).contains("EQ band 5"));
        let empty = r#"{"lanes":[],"events":[],"length_beats":4}"#;
        assert!(err(empty, A, B).contains("nothing to play"));
        let negative = bare.replace(r#""length_beats":4"#, r#""length_beats":-4"#);
        assert!(err(&negative, A, B).contains("length_beats"));
        let long = bare.replace(r#""beat":4,"value":7"#, r#""beat":4000,"value":7"#);
        assert!(err(&long, A, B).contains("length must be"));
        let echo = bare.replace(r#""length_beats":4"#, r#""length_beats":4,"echo_beats":99"#);
        assert!(err(&echo, A, B).contains("echo_beats"));
        let lanes =
            vec![json!({"target": {"kind": "filter", "deck": 0}, "keys": []}); MAX_LANES + 1];
        let many = json!({"lanes": lanes, "events": [], "length_beats": 4}).to_string();
        assert!(err(&many, A, B).contains("at most"));
        assert!(err(&" ".repeat(MAX_PLAN_JSON + 1), A, B).contains("too large"));

        let mut late = serde_json::to_value(&p).unwrap();
        late["startSec"] = json!(-5.0);
        assert!(err(&late.to_string(), A, B).contains("startSec"));
        let mut cue = serde_json::to_value(&p).unwrap();
        cue["toCueSec"] = json!(-1.0);
        assert!(err(&cue.to_string(), A, B).contains("toCueSec"));
    }

    #[test]
    fn apply_auto_refuses_what_is_out_of_range_and_clamps_values() {
        let mock = Mock::default();
        let mut echo = [0.0; 4];
        let set = |target: dt::Target, value: f32| dt::AutoCmd::Set { target, value };
        let event = |event: dt::Event| dt::AutoCmd::Event { event };
        for bad in [
            set(dt::Target::Volume { deck: 9 }, 1.0),
            set(dt::Target::Eq { deck: 0, band: 7 }, 0.0),
            set(dt::Target::Stem { deck: 0, stem: 4 }, 1.0),
            set(dt::Target::Filter { deck: 0 }, f32::NAN),
            dt::AutoCmd::EchoSetup {
                deck: 0,
                beats: f64::NAN,
            },
            dt::AutoCmd::EchoSetup {
                deck: 0,
                beats: 64.0,
            },
            dt::AutoCmd::EchoSetup {
                deck: 4,
                beats: 0.5,
            },
            event(dt::Event::Play { deck: 200 }),
        ] {
            assert!(apply_auto(&mock, &bad, &mut echo).is_err(), "{bad:?}");
        }
        assert!(mock.calls().is_empty(), "a refused command reaches nothing");

        for good in [
            set(dt::Target::Volume { deck: 0 }, 7.0),
            set(dt::Target::Eq { deck: 1, band: 1 }, -90.0),
            set(dt::Target::Stem { deck: 3, stem: 2 }, 0.5),
            set(dt::Target::EchoWet { deck: 1 }, 0.4),
            dt::AutoCmd::EchoSetup {
                deck: 1,
                beats: 0.5,
            },
            set(dt::Target::EchoWet { deck: 1 }, 0.4),
            event(dt::Event::Stems { deck: 2, on: true }),
            dt::AutoCmd::Done,
        ] {
            apply_auto(&mock, &good, &mut echo).unwrap();
        }
        assert_eq!(
            mock.calls(),
            vec![
                Call::Volume(A, 1.0),
                Call::Eq(B, "mid", -26.0),
                Call::Stem(DeckId::D, 2, 0.5),
                Call::Echo(B, 0.4, DEFAULT_ECHO_BEATS),
                Call::Echo(B, 0.0, 0.5),
                Call::Echo(B, 0.4, 0.5),
                Call::Stems(DeckId::C, true),
            ]
        );
    }

    #[test]
    fn a_bass_swap_drives_the_engine_in_order_and_hands_the_strip_back() {
        let mut run = run_of(&plan("bass_swap", 4), 2.0);
        let mock = Mock::playing(A);
        let mut seen = Vec::new();
        let (events, ticks) = drive(&mut run, &mock, |m| seen.push(m.calls.borrow().len()));
        // 2 beats of waiting + 16 of automation at 128 BPM = 8.44 s of 20 ms ticks.
        assert!((418..=428).contains(&ticks), "{ticks} ticks");
        assert_eq!(seen[45], 0, "nothing happens before the start");
        assert!(seen[49] > 0, "the first tick past the start acts");

        let calls = mock.calls();
        assert_eq!(
            calls[..2],
            [Call::Sync(B), Call::Play(B)],
            "synced, then started"
        );
        // The incoming fader rises to the level the set runs at (0.8), never above.
        let b = fader(&calls, B);
        assert!(b[0] < 0.01 && b.windows(2).all(|w| w[0] <= w[1]), "{b:?}");
        assert_eq!(b.last(), Some(&0.8));
        // The outgoing fader starts where it was (no jump to 1.0), falls to zero, then comes back.
        let a = fader(&calls, A);
        assert_eq!(a[0], 0.8);
        assert_eq!(a[a.len() - 2..], [0.0, 0.8]);
        assert!(a[..a.len() - 1].windows(2).all(|w| w[0] >= w[1]), "{a:?}");
        // Basses swapped half way, the outgoing deck paused at the end, then its strip as before.
        let b_low_up = first(&calls, &Call::Eq(B, "low", 0.0));
        let a_low_cut = first(&calls, &Call::Eq(A, "low", -26.0));
        let paused = first(&calls, &Call::Pause(A));
        let silent = first(&calls, &Call::Volume(A, 0.0));
        assert!(first(&calls, &Call::Eq(B, "low", -26.0)) < b_low_up);
        assert!(b_low_up < paused && a_low_cut < paused && paused < silent);
        assert_eq!(
            calls[calls.len() - 4..],
            [
                Call::Unlock(B),
                Call::Eq(A, "low", 0.0),
                Call::Eq(A, "high", -3.0),
                Call::Volume(A, 0.8)
            ]
        );
        assert!(
            !calls
                .iter()
                .any(|c| matches!(c, Call::EchoOff(_) | Call::Stems(..) | Call::Filter(..)))
        );

        assert!(events[0].waiting && events[0].running && events[0].progress == 0.0);
        assert!((events[0].beats_until_start - 2.0).abs() < 0.05);
        let end = events.last().unwrap();
        assert!(end.done && !end.running && !end.cancelled && !end.waiting);
        assert_eq!((end.progress, end.length_beats), (1.0, 16.0));
        assert_eq!((end.from_deck.as_str(), end.to_deck.as_str()), ("a", "b"));
        assert!(end.errors.is_empty());
        assert!(events.windows(2).all(|w| w[0].progress <= w[1].progress));
        // 10 Hz: one event per five ticks, plus the last one.
        let per_five = ticks / EMIT_EVERY;
        assert!((per_five..=per_five + 2).contains(&(events.len() as u32)));
    }

    #[test]
    fn a_deck_the_user_restarted_keeps_its_values() {
        // A cut pauses the outgoing deck on the first beat; the run ends a bar later.
        let cut = plan("cut", 1);
        let mut run = run_of(&cut, 0.0);
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |_| {});
        let calls = mock.calls();
        assert_eq!(
            calls.last(),
            Some(&Call::Volume(A, 0.8)),
            "paused deck: fader back"
        );
        assert!(
            calls.contains(&Call::Volume(B, 0.8)),
            "incoming deck at the set level"
        );

        let mut run = run_of(&cut, 0.0);
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |m| {
            if m.calls.borrow().contains(&Call::Pause(A)) {
                m.intent.borrow_mut()[A.index()] = true; // the user pressed play again
            }
        });
        assert_eq!(
            fader(&mock.calls(), A).last(),
            Some(&0.0),
            "a playing deck is left alone"
        );
    }

    #[test]
    fn a_half_time_pair_is_not_handed_to_the_engine_sync() {
        let mut run = run_from(&deck_a(), &plan("bass_swap", 4), 0.0, false);
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |_| {});
        let calls = mock.calls();
        assert_eq!(calls[0], Call::Play(B));
        assert!(
            !calls
                .iter()
                .any(|c| matches!(c, Call::Sync(_) | Call::Unlock(_)))
        );

        // A deck that was locked before the run stays locked after it.
        let automation = run_plan(&plan("bass_swap", 4)).automation;
        let mut locked = [false; 4];
        locked[B.index()] = true;
        let before = before_run(&deck_a(), &automation, A, locked);
        let mut run = Run::new(automation, A, B, 0.0, 128.0, before, true);
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |_| {});
        let calls = mock.calls();
        assert!(calls.contains(&Call::Sync(B)));
        assert!(!calls.contains(&Call::Unlock(B)));
    }

    #[test]
    fn a_cancelled_run_releases_the_sync_lock_it_switched_on() {
        let half_way = |run: &mut Run, mock: &Mock| {
            let mut frame = 0;
            for _ in 0..120 {
                frame += 960;
                let sample = ClockSample {
                    frame,
                    sample_rate: 48_000,
                    deck_bpm: 128.0,
                    master_bpm: 128.0,
                };
                assert!(!run.tick(mock, sample).done);
            }
        };
        // A bass swap syncs (and so locks) the incoming deck. Cancelled half way, the lock goes:
        // deck B must not keep following deck A's tempo. No value is put back.
        let mut run = run_of(&plan("bass_swap", 4), 0.0);
        let mock = Mock::playing(A);
        half_way(&mut run, &mock);
        assert!(mock.calls().contains(&Call::Sync(B)));
        let so_far = mock.calls().len();
        run.release(&mock);
        assert_eq!(mock.calls()[so_far..], [Call::Unlock(B)]);

        // A deck the DJ had locked before the run stays locked.
        let automation = run_plan(&plan("bass_swap", 4)).automation;
        let mut locked = [false; 4];
        locked[B.index()] = true;
        let before = before_run(&deck_a(), &automation, A, locked);
        let mut run = Run::new(automation, A, B, 0.0, 128.0, before, true);
        let mock = Mock::playing(A);
        half_way(&mut run, &mock);
        let so_far = mock.calls().len();
        run.release(&mock);
        assert!(mock.calls()[so_far..].is_empty());

        // Cancelled while it still waits for the phrase: nothing was switched on.
        let run = run_of(&plan("bass_swap", 4), 32.0);
        let mock = Mock::playing(A);
        run.release(&mock);
        assert!(mock.calls().is_empty());

        // The audio stops mid-run (device unplugged) and the run gives up. The same engine comes
        // back with the device: the lock must not be waiting there.
        let mut run = run_of(&plan("bass_swap", 4), 0.0);
        let mock = Mock::playing(A);
        half_way(&mut run, &mock);
        let so_far = mock.calls().len();
        let still = ClockSample {
            frame: 120 * 960,
            sample_rate: 48_000,
            deck_bpm: 128.0,
            master_bpm: 128.0,
        };
        let mut ended = false;
        for _ in 0..=STALL_TICKS {
            if run.tick(&mock, still).done {
                ended = true;
                break;
            }
        }
        assert!(ended, "the run gives up");
        let calls = mock.calls();
        assert_eq!(calls.last(), Some(&Call::Unlock(B)));
        assert!(!calls[so_far..].iter().any(|c| matches!(c, Call::Pause(_))));
    }

    #[test]
    fn the_cancel_command_releases_what_the_run_switched_on() {
        // `copilot_cancel` needs an app handle, so it is checked in the source: it must end the
        // run through `release` (echo AND sync lock), not through `echoes_off` alone.
        let src = include_str!("copilot.rs").replace("\r\n", "\n");
        let start = src
            .find("\npub fn copilot_cancel(")
            .expect("copilot_cancel in copilot.rs");
        let body = &src[start..];
        let body = &body[..body.find("\n}\n").expect("end of copilot_cancel")];
        assert!(body.contains("run.release(engine);"), "{body}");
        assert!(!body.contains("echoes_off"), "{body}");
    }

    #[test]
    fn an_echo_out_sets_the_echo_up_and_switches_it_off() {
        let mut run = run_of(&plan("echo_out", 4), 0.0);
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |_| {});
        let calls = mock.calls();
        assert_eq!(
            calls[0],
            Call::Echo(A, 0.0, 0.75),
            "set up dry before the wet lane"
        );
        assert!(
            calls
                .iter()
                .any(|c| matches!(c, Call::Echo(DeckId::A, w, b) if *w > 0.6 && *b == 0.75))
        );
        assert!(
            !calls
                .iter()
                .any(|c| matches!(c, Call::Sync(_) | Call::Unlock(_)))
        );
        assert_eq!(calls.iter().filter(|c| **c == Call::Play(B)).count(), 1);
        let paused = first(&calls, &Call::Pause(A));
        assert!(first(&calls, &Call::Play(B)) < paused);
        assert!(paused < first(&calls, &Call::EchoOff(A)));
        assert_eq!(calls.last(), Some(&Call::Volume(A, 0.8)));

        // Cancelled half way: the echo the run switched on is switched off, nothing else.
        let mut run = run_of(&plan("echo_out", 4), 0.0);
        let mock = Mock::playing(A);
        let mut frame = 0;
        for _ in 0..120 {
            frame += 960;
            let sample = ClockSample {
                frame,
                sample_rate: 48_000,
                deck_bpm: 128.0,
                master_bpm: 128.0,
            };
            assert!(!run.tick(&mock, sample).done);
        }
        let so_far = mock.calls().len();
        run.release(&mock);
        assert_eq!(mock.calls()[so_far..], [Call::EchoOff(A)]);
        let p = run.progress(true, true);
        assert!(p.done && p.cancelled && !p.running);
        assert!(p.progress > 0.2 && p.progress < 0.4, "{}", p.progress);
    }

    #[test]
    fn a_stem_swap_restores_gains_and_stem_playback() {
        let mut a = deck_a();
        a.stems_active = false;
        a.stem_gains = vec![1.0, 0.5, 1.0, 1.0];
        let mut run = run_from(&a, &plan("stem_swap", 4), 0.0, true);
        assert_eq!(run.before.stems, Some(false));
        assert!(run.before.restore.contains(&dt::AutoCmd::Set {
            target: dt::Target::Stem { deck: 0, stem: 1 },
            value: 0.5
        }));
        let mock = Mock::playing(A);
        drive(&mut run, &mock, |_| {});
        let calls = mock.calls();
        assert!(first(&calls, &Call::Stems(A, true)) < first(&calls, &Call::Play(B)));
        assert_eq!(calls.last(), Some(&Call::Stems(A, false)));
        assert!(last(&calls, &Call::Stem(A, 1, 0.5)) > first(&calls, &Call::Pause(A)));
    }

    #[test]
    fn the_beat_clock_counts_audio_frames_at_the_deck_tempo() {
        let s = |frame: u64, deck_bpm: f64, master_bpm: f64| ClockSample {
            frame,
            sample_rate: 48_000,
            deck_bpm,
            master_bpm,
        };
        let mut c = BeatClock {
            pos: 0.0,
            bpm: 100.0,
            last_frame: None,
        };
        assert!(
            c.advance(s(1_000, 120.0, 90.0)),
            "the first sample only sets the origin"
        );
        assert_eq!(c.pos, 0.0);
        assert!(c.advance(s(49_000, 120.0, 90.0)));
        assert!((c.pos - 2.0).abs() < 1e-12, "1 s at the deck's 120 BPM");
        assert!(!c.advance(s(49_000, 120.0, 90.0)), "no new audio");
        assert!(c.advance(s(97_000, 0.0, 90.0)));
        assert!(
            (c.pos - 3.5).abs() < 1e-12,
            "deck tempo unknown: the master's"
        );
        assert!(c.advance(s(145_000, f64::NAN, 1e9)));
        assert!((c.pos - 5.0).abs() < 1e-12, "no usable tempo: the last one");
        // A counter that jumps (stream reopened) or runs backwards moves nothing.
        assert!(c.advance(s(145_000 + 48_000 * 60, 120.0, 120.0)));
        assert!(c.advance(s(10, 120.0, 120.0)));
        assert!((c.pos - 5.0).abs() < 1e-12);
        assert!(c.advance(s(48_010, 120.0, 120.0)));
        assert!((c.pos - 7.0).abs() < 1e-12);
        let mut zero = s(96_010, 120.0, 120.0);
        zero.sample_rate = 0;
        assert!(!c.advance(zero));
    }

    #[test]
    fn a_stalled_engine_ends_the_run_as_cancelled() {
        let mut run = run_of(&plan("bass_swap", 4), 0.0);
        let mock = Mock::playing(A);
        let still = ClockSample {
            frame: 4_800,
            sample_rate: 48_000,
            deck_bpm: 128.0,
            master_bpm: 128.0,
        };
        let mut ended = None;
        for tick in 0..=STALL_TICKS {
            let out = run.tick(&mock, still);
            if out.done {
                ended = Some((tick, out.emit.unwrap()));
                break;
            }
        }
        let (tick, p) = ended.expect("the run gives up");
        assert_eq!(tick, STALL_TICKS, "after 5 s without audio");
        assert!(p.done && p.cancelled && !p.running);
        assert_eq!(p.errors, vec!["the audio engine stopped".to_string()]);
        assert!(!mock.calls().iter().any(|c| matches!(c, Call::Pause(_))));
    }

    #[test]
    fn prepare_measures_the_wait_from_the_live_playhead() {
        // 128 BPM, playhead at 70 s: the next 8-bar phrase is beat 160 = 75 s.
        let p = plan_at("bass_swap", 4, 70.0);
        assert_eq!(p.start_sec, 75.0);
        let plan = run_plan(&p);
        let mut a = deck_a();
        let mut b = deck_b();
        a.position = 75.0 - 5.0 * 60.0 / 128.0;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert!((prep.until - 5.0).abs() < 1e-9);
        assert_eq!(prep.cue, Some(0.0), "cued on the first downbeat");
        assert_eq!((prep.tempo, prep.engine_sync), (Some(1.0), true));
        // Half a beat late still starts at once; later than a beat is a stale plan.
        a.position = 75.2;
        assert_eq!(prepare(&a, &b, &plan).unwrap().until, 0.0);
        a.position = 80.0;
        assert!(prepare(&a, &b, &plan).unwrap_err().contains("plan again"));
        a.position = 60.0;
        assert!((prepare(&a, &b, &plan).unwrap().until - 32.0).abs() < 1e-9);

        // The tempo follows what the outgoing deck sounds like (its fader included).
        a.tempo = 1.05;
        b.bpm = 126.0;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert!((prep.tempo.unwrap() - 128.0 * 1.05 / 126.0).abs() < 1e-12);
        assert!(prep.engine_sync);
        a.tempo = 1.0;
        // Half / double time: the nearest ratio, and the engine's 1:1 sync is not used.
        b.bpm = 64.0;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert_eq!((prep.tempo, prep.engine_sync), (Some(1.0), false));
        b.bpm = 250.0;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert_eq!((prep.tempo, prep.engine_sync), (Some(1.024), false));
        // Outside the engine's range even in double time: clamped.
        b.bpm = 40.0;
        assert_eq!(prepare(&a, &b, &plan).unwrap().tempo, Some(1.5));
        // No tempo on the incoming deck: nothing to set, the engine decides.
        b.bpm = 0.0;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert_eq!((prep.tempo, prep.engine_sync), (None, true));
        b.bpm = 128.0;

        // An incoming deck that already plays is not moved.
        b.playing = true;
        let prep = prepare(&a, &b, &plan).unwrap();
        assert_eq!((prep.cue, prep.tempo), (None, None));
        b.playing = false;
        // The cue never lands past the end of the track.
        let mut far = plan.clone();
        far.to_cue_sec = Some(30.0);
        b.duration = 0.1;
        assert_eq!(prepare(&a, &b, &far).unwrap().cue, Some(0.1));
        b.duration = 360.0;
        // An echo out does not beat-match: the incoming deck keeps its tempo.
        let echo = run_plan(&plan_at("echo_out", 4, 70.0));
        b.bpm = 140.0;
        assert_eq!(prepare(&a, &b, &echo).unwrap().tempo, None);
        b.bpm = 128.0;
        // A bare automation waits as long as it says.
        let mut bare = plan.clone();
        bare.start_sec = None;
        bare.beats_until_start = Some(3.0);
        assert_eq!(prepare(&a, &b, &bare).unwrap().until, 3.0);
        bare.beats_until_start = None;
        assert_eq!(prepare(&a, &b, &bare).unwrap().until, 0.0);

        a.playing = false;
        assert_eq!(prepare(&a, &b, &plan).unwrap_err(), "deck A is not playing");
        a.playing = true;
        b.loaded = false;
        assert_eq!(prepare(&a, &b, &plan).unwrap_err(), "deck B has no track");
        b.loaded = true;
        a.bpm = 0.0;
        assert_eq!(prepare(&a, &b, &plan).unwrap_err(), "deck A has no tempo");
    }

    #[test]
    fn a_fader_that_is_down_runs_the_lanes_at_full_scale() {
        let automation = run_plan(&plan("bass_swap", 4)).automation;
        let mut deck = deck_a();
        deck.volume = 0.0;
        assert_eq!(before_run(&deck, &automation, A, [false; 4]).level, 1.0);
        deck.volume = 0.5;
        let before = before_run(&deck, &automation, A, [false; 4]);
        assert_eq!(before.level, 0.5);
        assert_eq!(before.stems, None, "a bass swap does not switch stems");
        // Lanes of the other deck are not part of the strip.
        assert_eq!(before.restore.len(), 3);
        assert!(before.restore.iter().all(|c| matches!(c,
            dt::AutoCmd::Set { target, .. } if target.deck() == 0)));
    }

    #[test]
    fn a_crossfader_that_cuts_the_incoming_deck_refuses_the_run() {
        use mixai_core::CrossfaderCurve;
        let (a, mut b) = (deck_a(), deck_b());
        let mut mixer = MixerState::initial(48_000);
        let check =
            |m: &MixerState, from: &DeckState, to: &DeckState| check_crossfader(m, from, to);
        // Centre: both decks get the same share, on every curve.
        for curve in [
            CrossfaderCurve::Linear,
            CrossfaderCurve::Smooth,
            CrossfaderCurve::Sharp,
        ] {
            mixer.crossfader_curve = curve;
            mixer.crossfader = 0.0;
            assert!(check(&mixer, &a, &b).is_ok(), "{curve:?} centre");
            // Hard over on the outgoing deck's side: the incoming deck would never be heard.
            mixer.crossfader = -1.0;
            let e = check(&mixer, &a, &b).unwrap_err();
            assert_eq!(
                e, "the crossfader cuts deck B: centre it first",
                "{curve:?}"
            );
            // Hard over on the incoming deck's side is fine (it only gets louder).
            mixer.crossfader = 1.0;
            assert!(
                check(&mixer, &a, &b).is_ok(),
                "{curve:?} on the incoming side"
            );
            // The other direction (B to A) mirrors it.
            assert_eq!(
                check(&mixer, &b, &a).unwrap_err(),
                "the crossfader cuts deck A: centre it first"
            );
        }
        // Equal power: a little off centre still passes, three quarters over does not
        // (the set would end 7.7 dB quieter).
        mixer.crossfader_curve = CrossfaderCurve::Smooth;
        mixer.crossfader = -0.2;
        assert!(check(&mixer, &a, &b).is_ok());
        mixer.crossfader = -0.5;
        assert!(check(&mixer, &a, &b).is_err());
        // A deck on THRU ignores the crossfader.
        mixer.crossfader = -1.0;
        b.crossfader_assign = CrossfaderAssign::Thru;
        assert!(check(&mixer, &a, &b).is_ok());
        // Both decks on the same side move together.
        b.crossfader_assign = CrossfaderAssign::A;
        mixer.crossfader = 1.0;
        assert!(
            check(&mixer, &a, &b).is_ok(),
            "both silent is the user's choice, not a cut"
        );
    }

    #[test]
    fn safety_warnings_keep_their_numbers() {
        let mut playing = feat("a", 120.0, "8A");
        playing.duration_sec = 300.0;
        // 120 BPM: 2 s per bar, 40 s left = 20 bars, nothing ready.
        let w = safety_impl(playing.clone(), 260.0, 1.0, None, None).unwrap();
        assert_eq!(w.len(), 1);
        let wire = serde_json::to_value(&w[0]).unwrap();
        assert_eq!(
            wire,
            json!({"code": "ending_without_next", "severity": 1, "barsLeft": 20.0})
        );

        let next = feat("b", 140.0, "2B");
        let w = safety_impl(playing.clone(), 280.0, 1.0, Some(next), Some(16)).unwrap();
        assert_eq!(w[0].code, "plan_does_not_fit");
        assert_eq!(
            (w[0].severity, w[0].needed, w[0].bars_left),
            (2, Some(16), Some(10.0))
        );
        let clash = w.iter().find(|x| x.code == "key_clash").unwrap();
        assert_eq!(
            (clash.from.as_deref(), clash.to.as_deref()),
            (Some("8A"), Some("2B"))
        );
        assert!(
            w.iter()
                .any(|x| x.code == "tempo_gap" && x.percent.is_some())
        );

        let mut silent = playing.clone();
        silent.bpm = None;
        assert_eq!(
            safety_impl(silent, 0.0, 1.0, None, None).unwrap()[0].code,
            "no_grid"
        );
        assert!(safety_impl(playing.clone(), f64::NAN, 1.0, None, None).is_err());
        assert!(safety_impl(playing.clone(), 0.0, 0.0, None, None).is_err());
        assert!(safety_impl(playing.clone(), 0.0, f64::NAN, None, None).is_err());
        assert!(safety_impl(playing, 0.0, 1.0, None, Some(99)).is_err());
    }

    #[test]
    fn intents_are_parsed_offline_in_both_languages() {
        let i = intent_impl("mix next in 8 bars with echo").unwrap();
        assert_eq!(
            (i.action.as_str(), i.bars, i.style.as_deref()),
            ("mix_next", Some(8), Some("echo_out"))
        );
        let i = intent_impl("pune o buclă de 8 bătăi pe deck B").unwrap();
        assert_eq!(
            (i.action.as_str(), i.beats, i.deck.as_deref()),
            ("loop", Some(8.0), Some("b"))
        );
        let i = intent_impl("Ce urmează? Vreau mai multă energie").unwrap();
        assert_eq!(
            (i.action.as_str(), i.energy.as_deref()),
            ("suggest", Some("up"))
        );
        assert_eq!(intent_impl("anulează tranziția").unwrap().action, "cancel");
        assert_eq!(
            intent_impl("sync deck a").unwrap().deck.as_deref(),
            Some("a")
        );
        assert_eq!(intent_impl("90s hip-hop 95-105 BPM harmonic"), None);
        assert_eq!(
            intent_impl("mai multă energie"),
            None,
            "a direction alone is no command"
        );
        assert_eq!(intent_impl(&"ș".repeat(100_000)), None);
        let wire = serde_json::to_value(intent_impl("loop the right deck").unwrap()).unwrap();
        assert_eq!(wire["deck"], json!("b"));
        assert_eq!(wire["beats"], json!(4.0));
        assert!(copilot_intent_schema().contains("DecksIntent"));
    }
}
