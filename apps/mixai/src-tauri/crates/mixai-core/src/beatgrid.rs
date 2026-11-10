//! Beatgrid model (WP19-05): constant or variable tempo, optional downbeat.
//!
//! Times are in **seconds of source audio** so a grid never depends on the
//! device or track sample rate (the deck converts frames ↔ seconds). A grid
//! is either constant (`bpm` + `first_beat`) or piecewise linear through
//! `anchors` (time → beat pairs, strictly increasing), which covers live-played
//! tracks with drifting tempo. All queries are allocation-free so the audio
//! thread can call them freely.
//!
//! WP19-37 flexible grid: the editable form of a variable grid is a short list
//! of [`TempoMarker`]s (`sec`, `bpm`: "from here on the tempo is `bpm`"), as
//! stored by the library and by rekordbox / Traktor. [`BeatGrid::from_markers`]
//! turns markers into anchors and [`BeatGrid::markers`] turns anchors back into
//! markers. `fixed` is the fixed-grid toggle: the grid behaves as the constant
//! `bpm` + `first_beat` grid while the anchors are kept for when it is switched off.

use serde::{Deserialize, Serialize};

/// One variable-tempo anchor: source time `time` (s) is beat number `beat`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridAnchor {
    pub time: f64,
    pub beat: f64,
}

/// Tempo-change marker: from source time `sec` on, the tempo is `bpm`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TempoMarker {
    pub sec: f64,
    pub bpm: f64,
}

/// One analysed tempo section: source time `sec` is **exactly** beat `beat`, and the tempo from
/// there on is `bpm`. The beat tracker counts beats, so `beat` is an integer it measured rather
/// than a number integrated from the previous tempo (see [`BeatGrid::from_sections`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TempoSection {
    pub sec: f64,
    pub beat: f64,
    pub bpm: f64,
}

/// Relative tolerance under which two tempos count as equal (0.05 % ≈ 0.06 BPM at 128).
pub const MARKER_BPM_TOLERANCE: f64 = 0.0005;

/// Slowest tempo any entry path accepts (WP19-37 P1-9).
pub const MIN_BPM: f64 = 20.0;
/// Fastest tempo any entry path accepts.
pub const MAX_BPM: f64 = 400.0;

/// A tempo the grid maths can use: finite and inside [`MIN_BPM`]..=[`MAX_BPM`].
///
/// Everything that reaches [`BeatGrid`] must pass this: `beat_at` / `time_at` divide by the
/// segment length, so a marker at 1e-300 or 1e308 BPM turns into `NaN` **on the audio thread**.
#[inline]
pub fn valid_bpm(bpm: f64) -> bool {
    bpm.is_finite() && (MIN_BPM..=MAX_BPM).contains(&bpm)
}

/// A usable source time: finite and not before the start of the file.
#[inline]
pub fn valid_sec(sec: f64) -> bool {
    sec.is_finite() && sec >= 0.0
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
    /// Fixed-grid toggle: when true the grid is the constant `bpm` + `first_beat`
    /// grid and `anchors` are ignored (but kept).
    #[serde(default)]
    pub fixed: bool,
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
            fixed: false,
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
        self.is_variable() || (self.bpm.is_finite() && self.bpm > 0.0)
    }

    /// True when the anchors drive the grid (two or more anchors and not `fixed`).
    pub fn is_variable(&self) -> bool {
        !self.fixed && self.anchors.len() >= 2
    }

    /// Grid from a first beat and tempo-change markers. `bpm` is the tempo from
    /// `first_beat` until the first marker; a marker at (or before) `first_beat`
    /// replaces it. Markers that do not change the running tempo are dropped, so
    /// a marker list without real changes gives a constant grid. Beat 0 stays at
    /// `first_beat`; a marker between two beats is honoured exactly (fractional beat).
    pub fn from_markers(bpm: f64, first_beat: f64, markers: &[TempoMarker], fixed: bool) -> Self {
        let markers = merge_markers(bpm, markers);
        let mut start_bpm = bpm;
        let mut anchors = Vec::with_capacity(markers.len() + 2);
        let (mut t, mut beat, mut cur) = (first_beat, 0.0, bpm);
        for m in &markers {
            if m.sec <= first_beat + 1e-9 {
                start_bpm = m.bpm;
                cur = m.bpm;
                continue;
            }
            if anchors.is_empty() {
                anchors.push(GridAnchor { time: t, beat });
            }
            beat += (m.sec - t) * cur / 60.0;
            t = m.sec;
            cur = m.bpm;
            anchors.push(GridAnchor { time: t, beat });
        }
        if !anchors.is_empty() {
            // Trailing anchor one beat later so the last segment runs at the last tempo
            // (queries past the last anchor extrapolate the last segment).
            anchors.push(GridAnchor {
                time: t + 60.0 / cur,
                beat: beat + 1.0,
            });
        }
        BeatGrid {
            bpm: start_bpm,
            first_beat,
            anchors,
            fixed,
            ..Default::default()
        }
    }

    /// Grid from **measured** tempo sections (the analyser's anchors, WP19-37 P1-8).
    ///
    /// Unlike [`BeatGrid::from_markers`], which integrates the running tempo to find where each
    /// marker falls, every section already knows its own beat number, so the anchors land on the
    /// beats the tracker counted. The per-section line fits do not meet exactly at the
    /// boundaries (they disagree by up to ~15 ms), and integrating those fractional beats makes
    /// the error accumulate section after section; pinning each section to its integer beat
    /// keeps the error local to one section instead.
    ///
    /// Sections with an unusable tempo or time are dropped; beats must be strictly increasing
    /// (the normalisation in [`BeatGrid::normalized`] drops the rest). Fewer than two usable
    /// sections give a constant grid at `bpm` / `first_beat`.
    pub fn from_sections(
        bpm: f64,
        first_beat: f64,
        sections: &[TempoSection],
        fixed: bool,
    ) -> Self {
        let usable: Vec<TempoSection> = sections
            .iter()
            .copied()
            .filter(|s| valid_bpm(s.bpm) && s.sec.is_finite() && s.beat.is_finite())
            .collect();
        if usable.len() < 2 {
            return BeatGrid {
                bpm,
                first_beat,
                fixed,
                ..Default::default()
            };
        }
        let mut anchors = Vec::with_capacity(2 * usable.len() + 1);
        for (i, s) in usable.iter().enumerate() {
            anchors.push(GridAnchor {
                time: s.sec,
                beat: s.beat,
            });
            // Inside a section the beats follow the section's own fitted tempo, not the chord
            // to the next section start: follow it up to the section's last beat, then one
            // transition beat into the next measured start (where the tempo really changes).
            // Skipped when the fit and the next start disagree too much to make a sane beat.
            let Some(next) = usable.get(i + 1) else {
                continue;
            };
            let last_beat = next.beat - 1.0;
            if last_beat <= s.beat {
                continue;
            }
            let t = s.sec + (last_beat - s.beat) * 60.0 / s.bpm;
            if t > s.sec && t < next.sec && valid_bpm(60.0 / (next.sec - t)) {
                anchors.push(GridAnchor {
                    time: t,
                    beat: last_beat,
                });
            }
        }
        // Trailing anchor one beat past the last section so the last segment keeps its tempo.
        let last = usable[usable.len() - 1];
        anchors.push(GridAnchor {
            time: last.sec + 60.0 / last.bpm,
            beat: last.beat + 1.0,
        });
        BeatGrid {
            bpm,
            first_beat,
            anchors,
            fixed,
            ..Default::default()
        }
        .normalized()
    }

    /// Tempo-change markers of the anchors (inverse of [`BeatGrid::from_markers`]):
    /// one marker at the start of every anchor segment whose tempo differs from the
    /// previous segment. The first segment's tempo is not a marker (it is the
    /// grid's starting tempo, see [`BeatGrid::start_bpm`]). Ignores `fixed`.
    pub fn markers(&self) -> Vec<TempoMarker> {
        let mut out = Vec::new();
        if self.anchors.len() < 2 {
            return out;
        }
        let mut prev = segment_bpm(self.anchors[0], self.anchors[1]);
        for w in self.anchors.windows(2).skip(1) {
            let bpm = segment_bpm(w[0], w[1]);
            if !same_tempo(bpm, prev) {
                out.push(TempoMarker {
                    sec: w[0].time,
                    bpm,
                });
                prev = bpm;
            }
        }
        out
    }

    /// Tempo of the first anchor segment (or `bpm` for constant grids). Ignores `fixed`.
    pub fn start_bpm(&self) -> f64 {
        if self.anchors.len() >= 2 {
            segment_bpm(self.anchors[0], self.anchors[1])
        } else {
            self.bpm
        }
    }

    /// Time of beat 0 (first anchor time for anchored grids). Ignores `fixed`.
    pub fn start_time(&self) -> f64 {
        match self.anchors.first() {
            Some(a) if self.anchors.len() >= 2 => a.time - a.beat * 60.0 / self.start_bpm(),
            _ => self.first_beat,
        }
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
        if self.is_variable() {
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
        if self.is_variable() {
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
        if self.is_variable() {
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

fn segment_bpm(a: GridAnchor, b: GridAnchor) -> f64 {
    (b.beat - a.beat) / (b.time - a.time) * 60.0
}

fn same_tempo(a: f64, b: f64) -> bool {
    (a - b).abs() <= MARKER_BPM_TOLERANCE * a.abs().max(b.abs())
}

/// Normalise an editable marker list: drop entries whose time is not finite or whose tempo is
/// outside [`MIN_BPM`]..=[`MAX_BPM`] (a 1e-300 or 1e308 marker would make `beat_at` return
/// `NaN` on the audio thread), sort by time, keep the last of markers at the same time (within
/// 1 ms) and drop every marker whose tempo equals the running tempo (starting at `start_bpm`).
///
/// This is the last line of defence: every public entry path rejects such markers with an
/// error first (see `grid.rs` / the Tauri commands), so nothing is silently dropped there.
pub fn merge_markers(start_bpm: f64, markers: &[TempoMarker]) -> Vec<TempoMarker> {
    let mut sorted: Vec<TempoMarker> = markers
        .iter()
        .copied()
        .filter(|m| m.sec.is_finite() && valid_bpm(m.bpm))
        .collect();
    sorted.sort_by(|a, b| a.sec.total_cmp(&b.sec));
    let mut uniq: Vec<TempoMarker> = Vec::with_capacity(sorted.len());
    for m in sorted {
        match uniq.last_mut() {
            Some(last) if (m.sec - last.sec).abs() < 1e-3 => *last = m,
            _ => uniq.push(m),
        }
    }
    let mut out = Vec::with_capacity(uniq.len());
    let mut cur = start_bpm;
    for m in uniq {
        if !same_tempo(m.bpm, cur) {
            out.push(m);
            cur = m.bpm;
        }
    }
    out
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

    fn m(sec: f64, bpm: f64) -> TempoMarker {
        TempoMarker { sec, bpm }
    }

    #[test]
    fn markers_build_a_piecewise_grid() {
        // 120 BPM from 0.5 s, 128 BPM from 16.5 s (beat 32), 124 BPM from 31.5 s (beat 64).
        let g = BeatGrid::from_markers(120.0, 0.5, &[m(16.5, 128.0), m(31.5, 124.0)], false);
        assert!(g.is_variable());
        assert!((g.beat_at(16.5) - 32.0).abs() < 1e-9);
        assert!((g.bpm_at(10.0) - 120.0).abs() < 1e-9);
        assert!((g.bpm_at(20.0) - 128.0).abs() < 1e-9);
        assert!((g.bpm_at(31.4) - 128.0).abs() < 1e-9);
        // Past the last marker the grid keeps the last tempo (trailing anchor).
        assert!((g.bpm_at(200.0) - 124.0).abs() < 1e-9);
        assert!((g.beat_at(31.5) - 64.0).abs() < 1e-9);
        assert!((g.time_at(64.0 + 124.0) - (31.5 + 60.0)).abs() < 1e-9);
        // Before the first beat the first tempo extrapolates.
        assert!((g.time_at(-1.0) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn markers_round_trip_and_merge() {
        let ms = [m(16.5, 128.0), m(31.5, 124.0)];
        let g = BeatGrid::from_markers(120.0, 0.5, &ms, false);
        let back = g.markers();
        assert_eq!(back.len(), ms.len());
        for (a, b) in back.iter().zip(&ms) {
            assert!(
                (a.sec - b.sec).abs() < 1e-9 && (a.bpm - b.bpm).abs() < 1e-9,
                "{back:?}"
            );
        }
        assert!((g.start_bpm() - 120.0).abs() < 1e-9);
        assert!((g.start_time() - 0.5).abs() < 1e-9);
        // Equal tempos merge away; duplicates at one time keep the last.
        let merged = merge_markers(
            120.0,
            &[
                m(30.0, 128.02), // same tempo as the previous marker (within tolerance)
                m(10.0, 126.0),  // replaced by the one 0.4 ms later
                m(10.0004, 128.0),
                m(20.0, 128.0), // no change
            ],
        );
        assert_eq!(merged, vec![m(10.0004, 128.0)]);
        // No real change -> constant grid.
        let c = BeatGrid::from_markers(120.0, 0.5, &[m(8.0, 120.0)], false);
        assert!(!c.is_variable() && c.anchors.is_empty());
        // A marker on the first beat replaces the starting tempo.
        let s = BeatGrid::from_markers(120.0, 0.5, &[m(0.5, 126.0)], false);
        assert!(s.anchors.is_empty() && (s.bpm - 126.0).abs() < 1e-12);
    }

    #[test]
    fn fixed_grid_ignores_the_anchors_but_keeps_them() {
        let mut g = BeatGrid::from_markers(120.0, 0.5, &[m(16.5, 128.0)], true);
        assert!(!g.is_variable());
        assert_eq!(g.anchors.len(), 3);
        // Constant 120 BPM from 0.5 s everywhere, also after the 128 BPM marker.
        assert!((g.bpm_at(30.0) - 120.0).abs() < 1e-9);
        assert!((g.beat_at(30.5) - 60.0).abs() < 1e-9);
        assert!((g.time_at(60.0) - 30.5).abs() < 1e-9);
        // Switching it off brings the markers back.
        g.fixed = false;
        assert!((g.bpm_at(30.0) - 128.0).abs() < 1e-9);
        assert_eq!(g.markers(), vec![m(16.5, 128.0)]);
        // Default (and older payloads without `fixed`) stay variable.
        assert!(!BeatGrid::default().fixed);
    }

    #[test]
    fn markers_outside_the_bpm_range_are_dropped() {
        // P1-9: a subnormal / huge tempo would make beat_at() return NaN on the audio thread.
        for bad in [1e-300, 1e308, 0.0, -128.0, 19.999, 400.001, f64::NAN] {
            assert_eq!(merge_markers(120.0, &[m(8.0, bad)]), Vec::new(), "{bad}");
            let g = BeatGrid::from_markers(120.0, 0.5, &[m(8.0, bad)], false);
            assert!(!g.is_variable(), "{bad}");
            assert!(
                g.beat_at(30.0).is_finite() && g.time_at(60.0).is_finite(),
                "{bad}"
            );
        }
        assert!(valid_bpm(20.0) && valid_bpm(400.0) && !valid_bpm(f64::INFINITY));
        assert!(valid_sec(0.0) && !valid_sec(-1e-9) && !valid_sec(f64::NAN));
    }

    #[test]
    fn sections_land_on_their_measured_beats() {
        // P1-8: section beats are measured, so they must not be re-integrated from the tempo.
        // Here the first section's fitted tempo (119 BPM) disagrees with where beat 64 really
        // is (31.5 s): from_markers would put beat 64 at ~62.6, from_sections puts it at 64.
        let secs = [
            TempoSection {
                sec: 0.5,
                beat: 0.0,
                bpm: 119.0,
            },
            TempoSection {
                sec: 31.5,
                beat: 64.0,
                bpm: 128.0,
            },
            TempoSection {
                sec: 61.5,
                beat: 128.0,
                bpm: 124.0,
            },
        ];
        let g = BeatGrid::from_sections(120.0, 0.5, &secs, false);
        assert!(g.is_variable());
        assert!((g.beat_at(31.5) - 64.0).abs() < 1e-9, "{:?}", g.anchors);
        assert!((g.beat_at(61.5) - 128.0).abs() < 1e-9, "{:?}", g.anchors);
        assert!((g.time_at(128.0) - 61.5).abs() < 1e-9);
        // Inside a section the grid follows the section's own tempo (128 from beat 64), not the
        // chord to the next start; only the last beat before a start absorbs the difference.
        assert!((g.bpm_at(40.0) - 128.0).abs() < 1e-9, "{:?}", g.anchors);
        assert!((g.time_at(100.0) - (31.5 + 36.0 * 60.0 / 128.0)).abs() < 1e-9);
        // Past the last section the last tempo extrapolates.
        assert!((g.bpm_at(300.0) - 124.0).abs() < 1e-6);
        // The integrating path drifts instead (this is the bug the snap fixes).
        let drifting = BeatGrid::from_markers(119.0, 0.5, &[m(31.5, 128.0), m(61.5, 124.0)], false);
        assert!((drifting.beat_at(61.5) - 128.0).abs() > 1.0);
        // Fewer than two usable sections = constant grid; bad tempos are dropped.
        let one = BeatGrid::from_sections(120.0, 0.5, &secs[..1], false);
        assert!(!one.is_variable() && (one.bpm - 120.0).abs() < 1e-12);
        let bad = [
            TempoSection {
                sec: 0.5,
                beat: 0.0,
                bpm: 1e-300,
            },
            TempoSection {
                sec: 31.5,
                beat: 64.0,
                bpm: f64::NAN,
            },
        ];
        assert!(!BeatGrid::from_sections(120.0, 0.5, &bad, false).is_variable());
    }
}
