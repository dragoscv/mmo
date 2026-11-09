//! AI Transition Designer over FFI (`decks-transition`, WP19-20): next-track ranking, transition
//! plans (editable automation as JSON), a runner driven from the UI tick, set-safety warnings,
//! RO/EN intents and in-key risers.

use std::sync::Mutex;

use decks_transition as dt;

use crate::{BeatFx, DecksEngine, DecksError, EqBand, lock};

/// Track features the designer needs (fill from `LibraryTrack` + `TrackInfo` / `BeatGridInfo`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TransitionTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub bpm: Option<f64>,
    /// Camelot (`8A`).
    pub key: Option<String>,
    /// 1..10.
    pub energy: Option<u8>,
    pub duration_sec: f64,
    pub first_beat_sec: f64,
    pub downbeat_offset: u8,
    pub lufs: Option<f64>,
    pub has_stems: bool,
}

impl From<TransitionTrack> for dt::TrackFeatures {
    fn from(t: TransitionTrack) -> Self {
        Self {
            id: t.id,
            title: t.title,
            artist: t.artist,
            bpm: t.bpm,
            key: t.key,
            energy: t.energy,
            duration_sec: t.duration_sec,
            first_beat_sec: t.first_beat_sec,
            downbeat_offset: t.downbeat_offset,
            lufs: t.lufs,
            has_stems: t.has_stems,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum EnergyTrend {
    Hold,
    Up,
    Down,
}

impl From<EnergyTrend> for dt::EnergyDirection {
    fn from(e: EnergyTrend) -> Self {
        match e {
            EnergyTrend::Hold => Self::Hold,
            EnergyTrend::Up => Self::Up,
            EnergyTrend::Down => Self::Down,
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NextCandidate {
    pub track: TransitionTrack,
    pub played_minutes_ago: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct NextSuggestion {
    pub id: String,
    pub score: f64,
    pub key_score: f64,
    pub tempo_score: f64,
    pub energy_score: f64,
    /// Reason tags (`key_adjacent`, `tempo_close`, `energy_up`, `recently_played`, …).
    pub reasons: Vec<String>,
    pub tempo_ratio: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TransitionStyle {
    BassSwap,
    FilterSweep,
    EchoOut,
    StemSwap,
    Cut,
}

impl From<TransitionStyle> for dt::Style {
    fn from(s: TransitionStyle) -> Self {
        match s {
            TransitionStyle::BassSwap => Self::BassSwap,
            TransitionStyle::FilterSweep => Self::FilterSweep,
            TransitionStyle::EchoOut => Self::EchoOut,
            TransitionStyle::StemSwap => Self::StemSwap,
            TransitionStyle::Cut => Self::Cut,
        }
    }
}

impl From<dt::Style> for TransitionStyle {
    fn from(s: dt::Style) -> Self {
        match s {
            dt::Style::BassSwap => Self::BassSwap,
            dt::Style::FilterSweep => Self::FilterSweep,
            dt::Style::EchoOut => Self::EchoOut,
            dt::Style::StemSwap => Self::StemSwap,
            dt::Style::Cut => Self::Cut,
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TransitionPlanInfo {
    pub style: TransitionStyle,
    pub bars: u32,
    pub start_sec: f64,
    pub beats_until_start: f64,
    pub to_cue_sec: f64,
    pub to_tempo_ratio: f64,
    /// Editable automation (JSON, see docs/decks/transitions.md); pass back to `TransitionRunner`.
    pub automation_json: String,
    pub reasons: Vec<String>,
}

/// One set-safety warning.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SafetyWarning {
    /// `ending_without_next`, `plan_does_not_fit`, `tempo_gap`, `key_clash`, `loudness_jump`, `no_grid`.
    pub code: String,
    /// 2 = act now, 1 = heads-up.
    pub severity: u8,
    /// Full warning as JSON (numbers for the UI text).
    pub detail_json: String,
}

/// Recognised DJ intent as JSON (`action`, `bars?`, `style?`, `energy?`, `deck?`, `beats?`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DjIntent {
    pub json: String,
}

/// Rank next tracks after `playing`.
#[uniffi::export]
pub fn transition_rank_next(
    playing: TransitionTrack,
    candidates: Vec<NextCandidate>,
    energy: EnergyTrend,
    limit: u32,
) -> Vec<NextSuggestion> {
    let p: dt::TrackFeatures = playing.into();
    let c: Vec<dt::Candidate> = candidates
        .into_iter()
        .map(|c| dt::Candidate {
            track: c.track.into(),
            played_minutes_ago: c.played_minutes_ago,
        })
        .collect();
    let opts = dt::RankOptions {
        energy: energy.into(),
        limit: limit.clamp(1, 200) as usize,
        ..Default::default()
    };
    dt::rank_next(&p, &c, &opts)
        .into_iter()
        .map(|r| NextSuggestion {
            id: r.id,
            score: r.score,
            key_score: r.key,
            tempo_score: r.tempo,
            energy_score: r.energy,
            reasons: r.reasons,
            tempo_ratio: r.tempo_ratio,
        })
        .collect()
}

/// Plan a transition from `from` (on `from_deck`, at `from_pos_sec`) to `to` (on `to_deck`).
#[uniffi::export]
#[allow(clippy::too_many_arguments)]
pub fn transition_plan(
    from: TransitionTrack,
    to: TransitionTrack,
    from_deck: u8,
    to_deck: u8,
    from_pos_sec: f64,
    bars: Option<u32>,
    style: Option<TransitionStyle>,
    not_before_bars: u32,
) -> Result<TransitionPlanInfo, DecksError> {
    if from_deck > 3 || to_deck > 3 || from_deck == to_deck {
        return Err(DecksError::invalid("decks must be different and in 0..=3"));
    }
    let req = dt::PlanRequest {
        from: from.into(),
        to: to.into(),
        from_deck,
        to_deck,
        from_pos_sec,
        bars,
        style: style.map(Into::into),
        not_before_bars,
    };
    let p = dt::plan_transition(&req).ok_or_else(|| DecksError::Unsupported {
        reason: "the playing track has no tempo / beatgrid".into(),
    })?;
    Ok(TransitionPlanInfo {
        style: p.style.into(),
        bars: p.bars,
        start_sec: p.start_sec,
        beats_until_start: p.beats_until_start,
        to_cue_sec: p.to_cue_sec,
        to_tempo_ratio: p.to_tempo_ratio,
        automation_json: serde_json::to_string(&p.automation).unwrap_or_default(),
        reasons: p.reasons,
    })
}

/// 32-bar look-ahead warnings.
#[uniffi::export]
pub fn transition_check_safety(
    playing: TransitionTrack,
    position_sec: f64,
    tempo_ratio: f64,
    next: Option<TransitionTrack>,
    planned_bars: Option<u32>,
) -> Vec<SafetyWarning> {
    let input = dt::SafetyInput {
        playing: playing.into(),
        position_sec,
        tempo_ratio,
        next: next.map(Into::into),
        planned_bars,
    };
    dt::check_safety(&input)
        .into_iter()
        .map(|w| {
            let v = serde_json::to_value(&w).unwrap_or_default();
            SafetyWarning {
                code: v["code"].as_str().unwrap_or("").to_string(),
                severity: w.severity(),
                detail_json: v.to_string(),
            }
        })
        .collect()
}

/// Parse a RO / EN command offline; `None` = ask codai with `transition_intent_schema()`.
#[uniffi::export]
pub fn transition_parse_intent(text: String) -> Option<DjIntent> {
    dt::parse_intent(&text).map(|i| DjIntent {
        json: serde_json::to_string(&i).unwrap_or_default(),
    })
}

/// Validate a codai structured-output answer (same rules as the offline parser).
#[uniffi::export]
pub fn transition_validate_intent(json: String) -> Option<DjIntent> {
    dt::parse_llm_intent(&json).map(|i| DjIntent {
        json: serde_json::to_string(&i).unwrap_or_default(),
    })
}

/// JSON Schema for the codai structured-output request.
#[uniffi::export]
pub fn transition_intent_schema() -> String {
    dt::LLM_INTENT_SCHEMA.to_string()
}

/// Mono f32 riser in `key`, `bars` long at `bpm`.
#[uniffi::export]
pub fn transition_render_riser(
    key: String,
    bpm: f64,
    bars: u32,
    sample_rate: u32,
    seed: u64,
) -> Result<Vec<f32>, DecksError> {
    if bars > 64 {
        return Err(DecksError::invalid("at most 64 bars"));
    }
    dt::render_riser(&dt::RiserSpec {
        key,
        bpm,
        bars,
        sample_rate,
        level: 0.5,
        seed,
    })
    .ok_or_else(|| DecksError::invalid("unknown key, or tempo / rate not positive"))
}

/// Runner status after a tick.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TransitionTick {
    pub applied: u32,
    pub errors: Vec<String>,
    pub done: bool,
    /// 0..1 of the automation length (0 before the start).
    pub progress: f64,
}

/// Plays an automation against the master clock and sends the commands to a `DecksEngine`.
#[derive(uniffi::Object)]
pub struct TransitionRunner {
    inner: Mutex<dt::TransitionRunner>,
}

pub(crate) fn apply_auto(engine: &DecksEngine, cmd: &dt::AutoCmd) -> Result<(), DecksError> {
    match *cmd {
        dt::AutoCmd::Set { target, value } => match target {
            dt::Target::Volume { deck } => engine.set_volume(deck, value),
            dt::Target::Eq { deck, band } => engine.set_eq(
                deck,
                match band {
                    0 => EqBand::Low,
                    1 => EqBand::Mid,
                    _ => EqBand::High,
                },
                value,
            ),
            dt::Target::Filter { deck } => engine.set_filter(deck, value),
            dt::Target::Stem { deck, stem } => engine.set_stem_gain(deck, stem, value),
            dt::Target::EchoWet { deck } => {
                engine.set_beat_fx(deck, BeatFx::Echo, value, 0.75, 0.45)
            }
        },
        dt::AutoCmd::EchoSetup { deck, beats } => {
            engine.set_beat_fx(deck, BeatFx::Echo, 0.0, beats, 0.45)
        }
        dt::AutoCmd::Event { event } => match event {
            dt::Event::Play { deck } => engine.play(deck),
            dt::Event::Pause { deck } => engine.pause(deck),
            dt::Event::Sync { deck } => engine.phase_sync(deck, true),
            dt::Event::Stems { deck, on } => engine.set_stems_active(deck, on),
        },
        dt::AutoCmd::Done => Ok(()),
    }
}

#[uniffi::export]
impl TransitionRunner {
    /// `automation_json` from a plan (possibly edited); `start_beat` = master clock beat to start at
    /// (current clock beat + `beats_until_start`).
    #[uniffi::constructor]
    pub fn new(automation_json: String, start_beat: f64) -> Result<Self, DecksError> {
        let a: dt::Automation = serde_json::from_str(&automation_json)
            .map_err(|e| DecksError::invalid(format!("automation: {e}")))?;
        if !start_beat.is_finite() {
            return Err(DecksError::invalid("start_beat must be finite"));
        }
        Ok(Self {
            inner: Mutex::new(dt::TransitionRunner::new(a, start_beat)),
        })
    }

    /// Sample at `master_beat` and apply to `engine`. Call from the UI tick.
    pub fn tick(&self, engine: &DecksEngine, master_beat: f64) -> TransitionTick {
        let mut r = lock(&self.inner);
        let cmds = r.tick(master_beat);
        let mut applied = 0;
        let mut errors = Vec::new();
        for c in &cmds {
            match apply_auto(engine, c) {
                Ok(()) => applied += 1,
                Err(e) => errors.push(e.to_string()),
            }
        }
        let len = r.automation.length_beats.max(1e-9);
        TransitionTick {
            applied,
            errors,
            done: r.is_done(),
            progress: ((master_beat - r.start_beat) / len).clamp(0.0, 1.0),
        }
    }

    pub fn is_done(&self) -> bool {
        lock(&self.inner).is_done()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DecksEngineConfig;

    fn track(id: &str, bpm: f64, key: &str) -> TransitionTrack {
        TransitionTrack {
            id: id.into(),
            title: id.into(),
            artist: String::new(),
            bpm: Some(bpm),
            key: Some(key.into()),
            energy: Some(6),
            duration_sec: 360.0,
            first_beat_sec: 0.0,
            downbeat_offset: 0,
            lufs: Some(-9.0),
            has_stems: false,
        }
    }

    #[test]
    fn rank_plan_and_safety_round_trip() {
        let r = transition_rank_next(
            track("a", 124.0, "8A"),
            vec![
                NextCandidate {
                    track: track("b", 124.0, "9A"),
                    played_minutes_ago: None,
                },
                NextCandidate {
                    track: track("c", 124.0, "3B"),
                    played_minutes_ago: None,
                },
            ],
            EnergyTrend::Hold,
            5,
        );
        assert_eq!(r[0].id, "b");
        let p = transition_plan(
            track("a", 124.0, "8A"),
            track("b", 124.0, "9A"),
            0,
            1,
            60.0,
            None,
            None,
            0,
        )
        .unwrap();
        assert_eq!(p.style, TransitionStyle::BassSwap);
        assert!(p.automation_json.contains("\"lanes\""));
        assert!(
            transition_plan(
                track("a", 124.0, "8A"),
                track("b", 124.0, "9A"),
                1,
                1,
                0.0,
                None,
                None,
                0
            )
            .is_err()
        );
        let w = transition_check_safety(track("a", 124.0, "8A"), 340.0, 1.0, None, None);
        assert_eq!(w[0].code, "ending_without_next");
        assert!(w[0].detail_json.contains("bars_left"));
    }

    #[test]
    fn intents_schema_and_riser() {
        let i = transition_parse_intent("mix next in 8 bars with echo".into()).unwrap();
        assert!(i.json.contains("\"mix_next\""));
        assert!(transition_parse_intent("hello there".into()).is_none());
        assert!(transition_validate_intent(r#"{"action":"cancel"}"#.into()).is_some());
        assert!(transition_intent_schema().contains("DecksIntent"));
        let r = transition_render_riser("8A".into(), 128.0, 2, 44_100, 1).unwrap();
        assert_eq!(
            r.len(),
            (2.0 * 4.0 * 60.0 / 128.0 * 44_100.0_f64).round() as usize
        );
        assert!(transition_render_riser("8A".into(), 128.0, 65, 44_100, 1).is_err());
    }

    #[test]
    fn runner_drives_a_stopped_engine_without_panicking() {
        let p = transition_plan(
            track("a", 124.0, "8A"),
            track("b", 124.0, "8A"),
            0,
            1,
            30.0,
            Some(4),
            None,
            0,
        )
        .unwrap();
        let engine = DecksEngine::new(DecksEngineConfig::default());
        let r = TransitionRunner::new(p.automation_json, 10.0).unwrap();
        let mut t = r.tick(&engine, 9.0);
        assert_eq!((t.applied, t.progress), (0, 0.0));
        let mut beat = 10.0;
        while !t.done && beat < 40.0 {
            t = r.tick(&engine, beat);
            beat += 0.5;
        }
        assert!(t.done);
        assert_eq!(t.progress, 1.0);
        // Volume changes are stored while stopped; transport is refused (engine not running).
        assert_eq!(engine.snapshot().decks[1].volume, 1.0);
        assert!(TransitionRunner::new("{not json".into(), 0.0).is_err());
    }
}
