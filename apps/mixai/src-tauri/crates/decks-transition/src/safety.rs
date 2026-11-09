//! Set safety: a 32-bar look-ahead the UI shows as warnings before they become problems.

use serde::{Deserialize, Serialize};

use crate::camelot::key_score;
use crate::rank::tempo_score;
use crate::{BEATS_PER_BAR, TrackFeatures};

/// Look-ahead window in bars.
pub const LOOKAHEAD_BARS: f64 = 32.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SafetyInput {
    pub playing: TrackFeatures,
    pub position_sec: f64,
    /// Tempo ratio applied to the playing deck.
    pub tempo_ratio: f64,
    /// The track loaded / queued as next (`None` = nothing ready).
    pub next: Option<TrackFeatures>,
    /// Bars the planned transition needs (`None` = no plan yet).
    pub planned_bars: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Warning {
    /// The playing track ends within the window and nothing is ready.
    EndingWithoutNext { bars_left: f64 },
    /// The planned transition no longer fits before the end.
    PlanDoesNotFit { bars_left: f64, needed: u32 },
    /// Next track needs a tempo change above the comfortable range.
    TempoGap { percent: f64 },
    /// Next track clashes harmonically.
    KeyClash { from: String, to: String },
    /// Loudness differs by more than 3 LU.
    LoudnessJump { delta_lu: f64 },
    /// No beatgrid on the playing track: automation cannot be aligned.
    NoGrid,
}

impl Warning {
    /// 2 = act now, 1 = heads-up.
    pub fn severity(&self) -> u8 {
        match self {
            Warning::EndingWithoutNext { bars_left } => {
                if *bars_left <= 8.0 {
                    2
                } else {
                    1
                }
            }
            Warning::PlanDoesNotFit { .. } => 2,
            _ => 1,
        }
    }
}

/// Warnings for the next 32 bars, most severe first.
pub fn check_safety(input: &SafetyInput) -> Vec<Warning> {
    let mut out = Vec::new();
    let Some(beat) = input.playing.beat_sec() else {
        out.push(Warning::NoGrid);
        return out;
    };
    let ratio = if input.tempo_ratio > 0.0 {
        input.tempo_ratio
    } else {
        1.0
    };
    let left_sec = (input.playing.duration_sec - input.position_sec).max(0.0) / ratio;
    let bars_left = left_sec / (beat / ratio) / BEATS_PER_BAR;
    match &input.next {
        None if bars_left <= LOOKAHEAD_BARS => out.push(Warning::EndingWithoutNext {
            bars_left: (bars_left * 10.0).round() / 10.0,
        }),
        None => {}
        Some(next) => {
            if let Some(n) = input.planned_bars {
                if f64::from(n) > bars_left {
                    out.push(Warning::PlanDoesNotFit {
                        bars_left: (bars_left * 10.0).round() / 10.0,
                        needed: n,
                    });
                }
            }
            let (_, r) = tempo_score(input.playing.bpm.map(|b| b * ratio), next.bpm, 6.0, true);
            if let Some(r) = r {
                let pct = [r, r / 2.0, r * 2.0]
                    .into_iter()
                    .map(|x| (x - 1.0).abs() * 100.0)
                    .fold(f64::INFINITY, f64::min);
                if pct > 6.0 {
                    out.push(Warning::TempoGap {
                        percent: (pct * 10.0).round() / 10.0,
                    });
                }
            }
            let (k, tag) = key_score(input.playing.key.as_deref(), next.key.as_deref());
            if tag == "key_clash" && k < 0.45 {
                out.push(Warning::KeyClash {
                    from: input.playing.key.clone().unwrap_or_default(),
                    to: next.key.clone().unwrap_or_default(),
                });
            }
            if let (Some(a), Some(b)) = (input.playing.lufs, next.lufs) {
                let d = b - a;
                if d.abs() > 3.0 {
                    out.push(Warning::LoudnessJump {
                        delta_lu: (d * 10.0).round() / 10.0,
                    });
                }
            }
        }
    }
    out.sort_by_key(|w| std::cmp::Reverse(w.severity()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(bpm: f64, key: &str, dur: f64, lufs: f64) -> TrackFeatures {
        TrackFeatures {
            id: key.into(),
            bpm: Some(bpm),
            key: Some(key.into()),
            duration_sec: dur,
            lufs: Some(lufs),
            ..Default::default()
        }
    }

    #[test]
    fn warns_when_ending_without_a_next_track() {
        // 120 BPM: 2 s per bar; 40 s left = 20 bars.
        let w = check_safety(&SafetyInput {
            playing: t(120.0, "8A", 300.0, -9.0),
            position_sec: 260.0,
            tempo_ratio: 1.0,
            next: None,
            planned_bars: None,
        });
        assert_eq!(w, vec![Warning::EndingWithoutNext { bars_left: 20.0 }]);
        assert_eq!(w[0].severity(), 1);
        let far = check_safety(&SafetyInput {
            playing: t(120.0, "8A", 300.0, -9.0),
            position_sec: 10.0,
            tempo_ratio: 1.0,
            next: None,
            planned_bars: None,
        });
        assert!(far.is_empty(), "more than 32 bars left");
    }

    #[test]
    fn tempo_ratio_speeds_up_the_clock() {
        let w = check_safety(&SafetyInput {
            playing: t(120.0, "8A", 300.0, -9.0),
            position_sec: 284.0,
            tempo_ratio: 1.25,
            next: None,
            planned_bars: None,
        });
        // 16 s of track at 1.25x = 12.8 s real, bar = 1.6 s -> 8 bars: severity 2.
        assert_eq!(w, vec![Warning::EndingWithoutNext { bars_left: 8.0 }]);
        assert_eq!(w[0].severity(), 2);
    }

    #[test]
    fn next_track_problems_are_reported_most_severe_first() {
        let w = check_safety(&SafetyInput {
            playing: t(124.0, "8A", 300.0, -8.0),
            position_sec: 280.0,
            tempo_ratio: 1.0,
            next: Some(t(140.0, "2B", 300.0, -14.0)),
            planned_bars: Some(16),
        });
        assert!(matches!(w[0], Warning::PlanDoesNotFit { needed: 16, .. }));
        assert!(w.iter().any(|x| matches!(x, Warning::TempoGap { .. })));
        assert!(w.iter().any(|x| matches!(x, Warning::KeyClash { .. })));
        assert!(
            w.iter()
                .any(|x| matches!(x, Warning::LoudnessJump { delta_lu } if *delta_lu == -6.0))
        );
    }

    #[test]
    fn compatible_next_track_is_quiet_and_no_grid_is_flagged() {
        let ok = check_safety(&SafetyInput {
            playing: t(124.0, "8A", 300.0, -8.0),
            position_sec: 100.0,
            tempo_ratio: 1.0,
            next: Some(t(62.0, "9A", 300.0, -9.0)),
            planned_bars: Some(16),
        });
        assert!(ok.is_empty(), "{ok:?}");
        let mut p = t(124.0, "8A", 300.0, -8.0);
        p.bpm = None;
        let w = check_safety(&SafetyInput {
            playing: p,
            position_sec: 0.0,
            tempo_ratio: 1.0,
            next: None,
            planned_bars: None,
        });
        assert_eq!(w, vec![Warning::NoGrid]);
    }
}
