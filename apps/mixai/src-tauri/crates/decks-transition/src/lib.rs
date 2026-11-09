//! # decks-transition — MixAI Decks AI Transition Designer (WP19-20, ADR-0014)
//!
//! Pure, deterministic and engine-agnostic (the app feeds track features and the master beat, and
//! sends the resulting commands to `DecksEngine`):
//!
//! * [`rank_next`] — next-track suggestions from key (Camelot wheel), tempo (incl. half / double
//!   time), energy direction and repetition, each with human-readable reasons.
//! * [`plan_transition`] — picks a style (bass swap, filter sweep, echo out, stem swap, cut) and a
//!   phrase-aligned start, and writes it as editable [`Automation`] lanes (volume, EQ, filter, stem
//!   gains, beat FX, play events) keyed in beats.
//! * [`TransitionRunner`] — plays a plan against the master beat and emits only changed values.
//! * [`check_safety`] — 32-bar look-ahead: track ending without a next track, tempo gap, key clash,
//!   loudness jump, plan not fitting.
//! * [`parse_intent`] — RO / EN voice or typed commands ("mix next in 16 bars with a bass swap",
//!   "fă tranziția în 32 de măsuri cu ecou"); [`LLM_INTENT_SCHEMA`] is the same intent as a JSON
//!   Schema for codai structured output when the local parser is not sure.
//! * [`render_riser`] — a noise + saw riser in the key of the incoming track, N bars long.
//!
//! Documentation: `docs/decks/transitions.md`.

mod automation;
mod camelot;
mod intent;
mod plan;
mod rank;
mod riser;
mod safety;

pub use automation::{
    AutoCmd, Automation, Curve, Event, Keyframe, Lane, Target, TimedEvent, TransitionRunner,
};
pub use camelot::{Camelot, key_score, root_pitch_class};
pub use intent::{Intent, IntentAction, LLM_INTENT_SCHEMA, parse_intent, parse_llm_intent};
pub use plan::{PlanRequest, Style, TransitionPlan, plan_transition};
pub use rank::{Candidate, EnergyDirection, RankOptions, Ranked, rank_next, tempo_score};
pub use riser::{RiserSpec, render_riser, riser_root_hz};
pub use safety::{SafetyInput, Warning, check_safety};

use serde::{Deserialize, Serialize};

/// Beats per bar (4/4; the analyser only models 4/4 downbeats).
pub const BEATS_PER_BAR: f64 = 4.0;

/// What the designer knows about a track (from `decks-analysis` / `decks-library`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackFeatures {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub bpm: Option<f64>,
    /// Camelot (`8A`); Open Key / musical names are not parsed here.
    pub key: Option<String>,
    /// 1..10.
    pub energy: Option<u8>,
    pub duration_sec: f64,
    /// Time of the first beat.
    pub first_beat_sec: f64,
    /// 0..3: beat index of the first downbeat counted from `first_beat_sec`.
    pub downbeat_offset: u8,
    pub lufs: Option<f64>,
    pub has_stems: bool,
}

impl TrackFeatures {
    /// Seconds per beat (`None` without a tempo).
    pub fn beat_sec(&self) -> Option<f64> {
        self.bpm.filter(|b| *b > 0.0).map(|b| 60.0 / b)
    }

    /// Beat index (from the first beat) at `pos_sec`.
    pub fn beat_at(&self, pos_sec: f64) -> Option<f64> {
        self.beat_sec().map(|b| (pos_sec - self.first_beat_sec) / b)
    }

    /// Time of beat index `beat`.
    pub fn time_of_beat(&self, beat: f64) -> Option<f64> {
        self.beat_sec().map(|b| self.first_beat_sec + beat * b)
    }

    /// Beats in the whole track (from the first beat).
    pub fn total_beats(&self) -> Option<f64> {
        self.beat_at(self.duration_sec)
    }
}
