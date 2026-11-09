//! Beatgrid model (WP19-05): constant or variable tempo, optional downbeat.
//!
//! Times are in **seconds of source audio** so a grid never depends on the
//! device or track sample rate (the deck converts frames ↔ seconds). A grid
//! is either constant (`bpm` + `first_beat`) or piecewise linear through
//! `anchors` (time → beat pairs, strictly increasing), which covers live-played
//! tracks with drifting tempo. All queries are allocation-free so the audio
//! thread can call them freely.

use serde::{Deserialize, Serialize};

/// One variable-tempo anchor: source time `time` (s) is beat number `beat`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridAnchor {
    pub time: f64,
    pub beat: f64,
}

/// Per-deck beatgrid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGrid {
    /// Nominal tempo (used when there are fewer than two anchors).
    pub bpm: f64,
    /// Time of beat 0 in seconds (first-beat offset).
    #[serde(default)]
    pub first_beat: f64,
    /// Beat number (counted from beat 0) that is a downbeat; `None` = unknown.
    #[serde(default)]
    pub downbeat: Option<i64>,
    /// Beats per bar (4 for nearly all dance music).
    #[serde(default = "default_bpb")]
    pub beats_per_bar: u32,
    /// Variable-tempo anchors. Two or more override `bpm`/`first_beat`.
    #[serde(default)]
    pub anchors: Vec<GridAnchor>,
}

fn default_bpb() -> u32 {
    4
}

impl Default for BeatGrid {
    fn default() -> Self {
        BeatGrid {
            bpm: 0.0,
            first_beat: 0.0,
            downbeat: None,
            beats_per_bar: 4,
            anchors: Vec::new(),
        }
    }
}

impl BeatGrid {
    /// Constant-tempo grid.
    pub fn constant(bpm: f64, first_beat: f64) -> Self {
        BeatGrid {
            bpm,
            first_beat,
            ..Default::default()
        }
    }

    /// Sort anchors and drop any that are not strictly increasing in both
    /// time and beat. Call off the audio thread after building a grid.
    pub fn normalized(mut self) -> Self {
        self.anchors.sort_by(|a, b| a.time.total_cmp(&b.time));
        self.anchors
            .dedup_by(|next, prev| next.time <= prev.time || next.beat <= prev.beat);
        self.beats_per_bar = self.beats_per_bar.max(1);
        self
    }

    pub fn is_valid(&self) -> bool {
        self.variable() || (self.bpm.is_finite() && self.bpm > 0.0)
    }

    fn variable(&self) -> bool {
        self.anchors.len() >= 2
    }

    /// Anchor segment covering `x` (clamped to the end segments).
    fn segment(&self, x: f64, by_beat: bool) -> usize {
        let n = self.anchors.len();
        let idx = self
            .anchors
            .partition_point(|a| if by_beat { a.beat <= x } else { a.time <= x });
        idx.saturating_sub(1).min(n - 2)
    }

    /// Fractional beat number at source time `t`.
    pub fn beat_at(&self, t: f64) -> f64 {
        if self.variable() {
            let i = self.segment(t, false);
            let (a, b) = (self.anchors[i], self.anchors[i + 1]);
            a.beat + (t - a.time) * (b.beat - a.beat) / (b.time - a.time)
        } else if self.bpm > 0.0 {
            (t - self.first_beat) * self.bpm / 60.0
        } else {
            0.0
        }
    }

    /// Source time of (fractional) beat number `beat`.
    pub fn time_at(&self, beat: f64) -> f64 {
        if self.variable() {
            let i = self.segment(beat, true);
            let (a, b) = (self.anchors[i], self.anchors[i + 1]);
            a.time + (beat - a.beat) * (b.time - a.time) / (b.beat - a.beat)
        } else if self.bpm > 0.0 {
            self.first_beat + beat * 60.0 / self.bpm
        } else {
            0.0
        }
    }

    /// Local tempo at source time `t`.
    pub fn bpm_at(&self, t: f64) -> f64 {
        if self.variable() {
            let i = self.segment(t, false);
            let (a, b) = (self.anchors[i], self.anchors[i + 1]);
            (b.beat - a.beat) / (b.time - a.time) * 60.0
        } else {
            self.bpm
        }
    }

    /// Time of the beat closest to `t`.
    pub fn nearest_beat_time(&self, t: f64) -> f64 {
        self.time_at(self.beat_at(t).round())
    }

    /// Position inside the bar in beats (0..beats_per_bar) when the downbeat is known.
    pub fn bar_phase(&self, t: f64) -> Option<f64> {
        let d = self.downbeat?;
        let bpb = self.beats_per_bar.max(1) as f64;
        Some((self.beat_at(t) - d as f64).rem_euclid(bpb))
    }
}

/// Wrap `x` into `[-period/2, period/2]` (shortest signed distance on a circle).
#[inline]
pub fn wrap_phase(x: f64, period: f64) -> f64 {
    x - period * (x / period).round()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_grid_round_trips() {
        let g = BeatGrid::constant(120.0, 0.25);
        assert!((g.beat_at(0.25 + 1.5) - 3.0).abs() < 1e-9);
        assert!((g.time_at(2.5) - 1.5).abs() < 1e-9);
        assert!((g.nearest_beat_time(1.9) - 1.75).abs() < 1e-9);
    }

    #[test]
    fn variable_grid_interpolates() {
        let g = BeatGrid {
            bpm: 120.0,
            downbeat: Some(0),
            anchors: vec![
                GridAnchor {
                    time: 4.0,
                    beat: 10.0,
                },
                GridAnchor {
                    time: 0.0,
                    beat: 0.0,
                },
                GridAnchor {
                    time: 2.0,
                    beat: 4.0,
                },
            ],
            ..Default::default()
        }
        .normalized();
        assert!((g.bpm_at(1.0) - 120.0).abs() < 1e-9);
        assert!((g.bpm_at(3.0) - 180.0).abs() < 1e-9);
        assert!((g.beat_at(3.0) - 7.0).abs() < 1e-9);
        assert!((g.time_at(7.0) - 3.0).abs() < 1e-9);
        assert!((g.bar_phase(3.0).unwrap() - 3.0).abs() < 1e-9);
    }

    #[test]
    fn wrap_phase_is_centred() {
        assert!((wrap_phase(0.9, 1.0) + 0.1).abs() < 1e-12);
        assert!((wrap_phase(-0.3, 1.0) + 0.3).abs() < 1e-12);
        assert!((wrap_phase(3.5, 4.0) + 0.5).abs() < 1e-12);
    }
}
