//! Onset strength, tempo, beat tracking and downbeat estimation.
//!
//! * **Onset strength** — multi-band (low < 200 Hz, mid, high > 2 kHz) log-magnitude spectral flux
//!   on the ~11 kHz decimated mono signal (1024-point frames, hop 128 ≈ 11.6 ms).
//! * **Tempo** — autocorrelation of the locally-detrended onset curve, scored by a 4-tap comb
//!   (lags τ, 2τ, 3τ, 4τ) so a candidate only wins when its whole pulse train is periodic. A
//!   DJ-range prior (hard 70–180, flat 85–175, mild log-Gaussian around 125 BPM) settles octave
//!   ambiguities.
//! * **Beats** — dynamic programming (Ellis 2007, "Beat tracking by dynamic programming"):
//!   maximise onset strength minus a log-ratio penalty on inter-beat intervals.
//! * **Phase** — every tracked beat is refined to the strongest energy step (prefix-sum step
//!   detector, 5.8 ms windows) nearby; the robust median offset shifts the whole grid, so the
//!   grid lands on transients instead of the FFT frame centres.
//! * **Grid** — least-squares line through the beats (beat index vs time) gives the BPM to
//!   ~0.01 BPM on steady material.
//! * **Tempo changes** (WP19-37) — binary segmentation of the beat times into straight-line
//!   sections (split where two lines fit best while a section's residual is too large), then
//!   adjacent sections whose tempos agree within 0.25 % are merged. A step change gives exactly
//!   one change; a drifting live tempo gives a few sections (one per ~15 ms of curvature). The
//!   section starts are the [`TempoAnchor`]s: a short, editable tempo-marker list. Flagged
//!   variable only when a section deviates > 0.5 % from the average.
//! * **Downbeats** — 4/4 bar-accent pattern: the beat phase (mod 4) with the highest mean onset
//!   accent (full-band + kick band) is the downbeat.

use serde::{Deserialize, Serialize};

use crate::util::{FrameRing, Spectrum, linear_fit, median, std_dev, weighted_median};

pub(crate) const ONSET_N: usize = 1024;
pub(crate) const ONSET_HOP: usize = 128;
const COMB_WEIGHTS: [f64; 4] = [1.0, 0.5, 0.33, 0.25];
const DP_TIGHTNESS: f32 = 100.0;
const VARIABLE_THRESHOLD: f64 = 0.005;
/// Shortest constant-tempo section (beats).
const MIN_SECTION_BEATS: usize = 8;
/// A section is split while its line-fit RMS residual exceeds this (seconds)…
const SPLIT_RMS_SEC: f64 = 0.008;
/// …or any single beat is further than this from the line (seconds).
const SPLIT_MAX_SEC: f64 = 0.030;
/// Adjacent sections with tempos this close (relative) are one section.
const MERGE_TOLERANCE: f64 = 0.0025;

/// Beatgrid for a track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatGrid {
    /// Average tempo in beats per minute.
    pub bpm: f64,
    /// 0..1 periodicity strength of the winning tempo.
    pub confidence: f32,
    /// Time of grid beat 0 in seconds (the first tracked beat, phase-refined).
    pub first_beat_sec: f64,
    /// Index (0..3) of the first downbeat counted from `first_beat_sec`, assuming 4/4.
    pub downbeat_offset_beats: u8,
    /// 0..1 how clearly one bar phase is accented over the others.
    pub downbeat_confidence: f32,
    /// Tracked beat times in seconds (omitted when `include_beats` is off).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beats: Option<Vec<f64>>,
    /// True when a constant-tempo section deviates more than 0.5 % from the average.
    pub is_variable: bool,
    /// Constant-tempo sections when `is_variable` (the first starts at beat 0; every later
    /// one is a tempo-change marker); empty otherwise.
    #[serde(default)]
    pub anchors: Vec<TempoAnchor>,
}

impl BeatGrid {
    /// Tempo-change markers `(sec, bpm)`: every section start after the first one.
    pub fn tempo_markers(&self) -> Vec<(f64, f64)> {
        self.anchors
            .iter()
            .skip(1)
            .map(|a| (a.time_sec, a.bpm))
            .collect()
    }
}

/// Start of a constant-tempo section of a variable beatgrid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TempoAnchor {
    pub beat_index: u32,
    pub time_sec: f64,
    pub bpm: f64,
}

/// BPM search range and preferred (unpenalised) band.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TempoRange {
    pub min_bpm: f64,
    pub max_bpm: f64,
    pub prefer_min_bpm: f64,
    pub prefer_max_bpm: f64,
}

impl Default for TempoRange {
    fn default() -> Self {
        Self {
            min_bpm: 70.0,
            max_bpm: 180.0,
            prefer_min_bpm: 85.0,
            prefer_max_bpm: 175.0,
        }
    }
}

impl TempoRange {
    fn prior(&self, bpm: f64) -> f64 {
        if bpm < self.min_bpm || bpm > self.max_bpm {
            return 0.0;
        }
        let taper = if bpm < self.prefer_min_bpm {
            0.6 + 0.4 * (bpm - self.min_bpm) / (self.prefer_min_bpm - self.min_bpm).max(1e-9)
        } else if bpm > self.prefer_max_bpm {
            0.6 + 0.4 * (self.max_bpm - bpm) / (self.max_bpm - self.prefer_max_bpm).max(1e-9)
        } else {
            1.0
        };
        let oct = (bpm / 125.0).log2() / 1.5;
        taper * (-0.5 * oct * oct).exp()
    }
}

/// Multi-band log spectral flux. One value per hop; allocation-free after construction.
pub(crate) struct OnsetDetector {
    ring: FrameRing,
    spec: Spectrum,
    prev: Vec<f32>,
    bands: [(usize, usize); 3],
    primed: bool,
}

impl OnsetDetector {
    pub(crate) fn new(sr: f64) -> Self {
        let bin = |hz: f64| ((hz * ONSET_N as f64 / sr).round() as usize).clamp(1, ONSET_N / 2);
        let top = bin(sr * 0.45);
        Self {
            ring: FrameRing::new(ONSET_N, ONSET_HOP),
            spec: Spectrum::new(ONSET_N),
            prev: vec![0.0; ONSET_N / 2 + 1],
            bands: [
                (1, bin(200.0)),
                (bin(200.0), bin(2000.0)),
                (bin(2000.0), top),
            ],
            primed: false,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.ring.reset();
        self.prev.fill(0.0);
        self.primed = false;
    }

    /// Push one decimated sample; on a hop boundary returns `(full_band_flux, low_band_flux)`.
    #[inline]
    pub(crate) fn push(&mut self, x: f32) -> Option<(f32, f32)> {
        if !self.ring.push(x) {
            return None;
        }
        let mags = self.spec.magnitudes(self.ring.frame());
        let mut flux = [0.0f32; 3];
        for (b, &(lo, hi)) in self.bands.iter().enumerate() {
            let mut acc = 0.0;
            for (&m, prev) in mags[lo..hi].iter().zip(&mut self.prev[lo..hi]) {
                let l = (1.0 + 100.0 * m).ln();
                let d = l - *prev;
                if d > 0.0 {
                    acc += d;
                }
                *prev = l;
            }
            flux[b] = acc / (hi - lo).max(1) as f32;
        }
        if !self.primed {
            self.primed = true;
            return Some((0.0, 0.0));
        }
        Some((flux[0] + flux[1] + flux[2], flux[0]))
    }
}

/// Autocorrelation + comb tempo estimator with a fixed-capacity work area (no allocation in
/// [`TempoEstimator::estimate`]).
pub(crate) struct TempoEstimator {
    work: Vec<f32>,
    prefix: Vec<f64>,
    acf: Vec<f64>,
    len: usize,
    fps: f64,
}

impl TempoEstimator {
    pub(crate) fn new(capacity: usize, fps: f64, range: &TempoRange) -> Self {
        let max_lag = (4.0 * 60.0 * fps / range.min_bpm.max(20.0)).ceil() as usize + 3;
        Self {
            work: vec![0.0; capacity],
            prefix: vec![0.0; capacity + 1],
            acf: vec![0.0; max_lag + 1],
            len: 0,
            fps,
        }
    }

    /// Load the onset curve (`a` then `b`, so a ring buffer can be passed in two halves).
    pub(crate) fn load(&mut self, a: &[f32], b: &[f32]) {
        let n = (a.len() + b.len()).min(self.work.len());
        let na = a.len().min(n);
        self.work[..na].copy_from_slice(&a[..na]);
        self.work[na..n].copy_from_slice(&b[..n - na]);
        self.len = n;
    }

    /// `(bpm, confidence)` of the loaded curve.
    pub(crate) fn estimate(&mut self, range: &TempoRange) -> Option<(f64, f32)> {
        let n = self.len;
        let fps = self.fps;
        let min_lag = 60.0 * fps / range.max_bpm;
        if n < (8.0 * min_lag) as usize {
            return None;
        }
        // Local detrend (±0.5 s moving mean), half-wave rectify, then remove the global mean.
        self.prefix[0] = 0.0;
        for i in 0..n {
            self.prefix[i + 1] = self.prefix[i] + self.work[i] as f64;
        }
        let half = (0.5 * fps).round() as usize;
        let mut mean = 0.0;
        for i in 0..n {
            let lo = i.saturating_sub(half);
            let hi = (i + half + 1).min(n);
            let m = (self.prefix[hi] - self.prefix[lo]) / (hi - lo) as f64;
            let v = (self.work[i] as f64 - m).max(0.0);
            self.work[i] = v as f32;
            mean += v;
        }
        mean /= n as f64;
        for v in &mut self.work[..n] {
            *v -= mean as f32;
        }
        let max_lag = (self.acf.len() - 1).min(n - 1);
        for lag in 0..=max_lag {
            let mut s = 0.0f32;
            for (a, b) in self.work[..n - lag].iter().zip(&self.work[lag..n]) {
                s += a * b;
            }
            self.acf[lag] = s as f64 / (n - lag) as f64;
        }
        for v in &mut self.acf[max_lag + 1..] {
            *v = 0.0;
        }
        let a0 = self.acf[0];
        if a0 <= 1e-12 {
            return None;
        }
        let acf_at = |l: f64| -> f64 {
            let i = l.floor() as usize;
            if i + 1 > max_lag {
                return 0.0;
            }
            let f = l - i as f64;
            (self.acf[i] * (1.0 - f) + self.acf[i + 1] * f) / a0
        };
        let wsum: f64 = COMB_WEIGHTS.iter().sum();
        let score = |bpm: f64| -> f64 {
            let lag = 60.0 * fps / bpm;
            COMB_WEIGHTS
                .iter()
                .enumerate()
                .map(|(k, w)| w * acf_at(lag * (k + 1) as f64))
                .sum::<f64>()
                / wsum
        };
        let step = 0.1;
        let steps = ((range.max_bpm - range.min_bpm) / step).floor() as usize;
        let mut best = (f64::NEG_INFINITY, range.min_bpm, 0.0);
        for s in 0..=steps {
            let bpm = range.min_bpm + s as f64 * step;
            let raw = score(bpm);
            let v = raw * range.prior(bpm);
            if v > best.0 {
                best = (v, bpm, raw);
            }
        }
        if !best.0.is_finite() || best.0 <= 0.0 {
            return None;
        }
        // Parabolic refinement on the prior-weighted score.
        let (b0, bpm0) = (best.0, best.1);
        let l = score(bpm0 - step) * range.prior(bpm0 - step);
        let r = score(bpm0 + step) * range.prior(bpm0 + step);
        let den = l - 2.0 * b0 + r;
        let off = if den < 0.0 {
            (0.5 * (l - r) / den).clamp(-0.5, 0.5)
        } else {
            0.0
        };
        let bpm = bpm0 + off * step;
        // Octave check: strong pulses half-way between the candidate beats mean the real pulse
        // is twice as fast (accented bars make half-tempo look more periodic, e.g. DnB 174 vs 87).
        let lag = 60.0 * fps / bpm;
        let full = acf_at(lag);
        let half = 0.5 * (acf_at(0.5 * lag) + acf_at(1.5 * lag));
        if 2.0 * bpm <= range.prefer_max_bpm && full > 0.0 && half > 0.5 * full {
            return Some((2.0 * bpm, score(2.0 * bpm).clamp(0.0, 1.0) as f32));
        }
        Some((bpm, best.2.clamp(0.0, 1.0) as f32))
    }
}

/// Inputs for [`track`]: onset curves at `fps` frames per second, plus the decimated mono signal
/// for phase refinement and a frame → seconds mapping.
pub(crate) struct TrackInput<'a> {
    pub odf: &'a [f32],
    pub low: &'a [f32],
    pub fps: f64,
    /// Time in seconds of onset frame 0 (frame `i` is at `t0 + i / fps`).
    pub t0: f64,
    pub signal: &'a [f32],
    pub signal_sr: f64,
    /// Time in seconds of `signal[0]`.
    pub signal_t0: f64,
}

/// Full offline beat tracking.
pub(crate) fn track(
    input: &TrackInput<'_>,
    range: &TempoRange,
    include_beats: bool,
) -> Option<BeatGrid> {
    let fps = input.fps;
    let mut est = TempoEstimator::new(input.odf.len(), fps, range);
    est.load(input.odf, &[]);
    let (bpm0, confidence) = est.estimate(range)?;
    let period = 60.0 * fps / bpm0;

    let sd = std_dev(input.odf).max(1e-9);
    let onset: Vec<f32> = input.odf.iter().map(|v| v / sd).collect();
    let frames = dp_beats(&onset, period);
    let frames = trim_weak(&onset, frames);
    if frames.len() < 4 {
        return None;
    }

    let label = |f: usize| input.t0 + f as f64 / fps;
    let (shift, per_beat) = phase_shift(input, &frames, &label, period / fps);
    // A beat keeps its own transient when it agrees with the global shift (±1.5 hops); otherwise
    // (soft/absent attack) it follows the frame label plus the global shift.
    let tol = 1.5 / fps;
    let times: Vec<f64> = frames
        .iter()
        .zip(&per_beat)
        .map(|(&f, o)| label(f) + o.filter(|o| (o - shift).abs() <= tol).unwrap_or(shift))
        .collect();

    // Grid indices (robust to a skipped or doubled beat), then a least-squares line.
    let p_sec = period / fps;
    let mut idx = Vec::with_capacity(times.len());
    let mut k = 0usize;
    idx.push(0.0);
    for w in times.windows(2) {
        k += ((w[1] - w[0]) / p_sec).round().max(1.0) as usize;
        idx.push(k as f64);
    }
    let (a, b) = linear_fit(&idx, &times)?;
    if b <= 0.0 {
        return None;
    }
    let bpm = 60.0 / b;

    let (downbeat_offset_beats, downbeat_confidence) = downbeat_phase(input, &frames, &idx);
    let (is_variable, anchors) = tempo_anchors(&idx, &times, bpm);

    Some(BeatGrid {
        bpm,
        confidence,
        first_beat_sec: a,
        downbeat_offset_beats,
        downbeat_confidence,
        beats: include_beats.then_some(times),
        is_variable,
        anchors,
    })
}

/// Ellis (2007) dynamic-programming beat tracker; returns beat frame indices.
fn dp_beats(onset: &[f32], period: f64) -> Vec<usize> {
    let n = onset.len();
    let lo = (period / 2.0).round().max(1.0) as usize;
    let hi = (2.0 * period).round() as usize;
    let txwt: Vec<f32> = (0..=hi)
        .map(|d| {
            if d < lo {
                f32::NEG_INFINITY
            } else {
                let r = (d as f64 / period).ln();
                -DP_TIGHTNESS * (r * r) as f32
            }
        })
        .collect();
    let mut cum = vec![0.0f32; n];
    let mut back = vec![usize::MAX; n];
    for t in 0..n {
        let mut best = 0.0f32;
        let mut bi = usize::MAX;
        if t >= lo {
            let start = t.saturating_sub(hi);
            for s in start..=t - lo {
                let v = cum[s] + txwt[t - s];
                if v > best {
                    best = v;
                    bi = s;
                }
            }
        }
        cum[t] = onset[t] + best;
        back[t] = bi;
    }
    let tail = (period.ceil() as usize + 1).min(n);
    let mut end = n - tail;
    for t in n - tail..n {
        if cum[t] > cum[end] {
            end = t;
        }
    }
    let mut beats = Vec::new();
    let mut t = end;
    loop {
        beats.push(t);
        if back[t] == usize::MAX {
            break;
        }
        t = back[t];
    }
    beats.reverse();
    beats
}

fn local_max(v: &[f32], f: usize, r: usize) -> f32 {
    let lo = f.saturating_sub(r);
    let hi = (f + r + 1).min(v.len());
    v[lo..hi].iter().copied().fold(0.0, f32::max)
}

/// Drop beats at either end that sit on (near) silence.
fn trim_weak(onset: &[f32], mut frames: Vec<usize>) -> Vec<usize> {
    if frames.is_empty() {
        return frames;
    }
    let strength: Vec<f32> = frames.iter().map(|&f| local_max(onset, f, 2)).collect();
    let thr = 0.25 * median(&strength);
    let first = strength.iter().position(|&s| s >= thr).unwrap_or(0);
    let last = strength
        .iter()
        .rposition(|&s| s >= thr)
        .unwrap_or(frames.len() - 1);
    frames.truncate(last + 1);
    frames.drain(..first);
    frames
}

/// Robust offset (seconds) from frame labels to the actual energy steps of the beats, plus each
/// beat's own offset when it has a clear transient.
fn phase_shift(
    input: &TrackInput<'_>,
    frames: &[usize],
    label: &dyn Fn(usize) -> f64,
    period_sec: f64,
) -> (f64, Vec<Option<f64>>) {
    let sig = input.signal;
    let sr = input.signal_sr;
    let mut per_beat = vec![None; frames.len()];
    if sig.len() < 512 {
        return (0.0, per_beat);
    }
    let mut prefix = Vec::with_capacity(sig.len() + 1);
    prefix.push(0.0f64);
    let mut acc = 0.0f64;
    for &x in sig {
        acc += (x as f64) * (x as f64);
        prefix.push(acc);
    }
    let w = ((0.0058 * sr).round() as usize).max(8);
    let radius = ((ONSET_N / 2 + 2 * ONSET_HOP) as f64).min(0.3 * period_sec * sr) as usize;
    let eps = 1e-10 * w as f64;
    let mut offsets = Vec::with_capacity(frames.len());
    for (i, &f) in frames.iter().enumerate() {
        let c = ((label(f) - input.signal_t0) * sr).round() as i64;
        let lo = (c - radius as i64).max(w as i64) as usize;
        let hi = ((c + radius as i64).max(0) as usize).min(sig.len().saturating_sub(w));
        if lo >= hi {
            continue;
        }
        let mut best = (f64::NEG_INFINITY, lo);
        for s in lo..=hi {
            let after = prefix[s + w] - prefix[s];
            let before = prefix[s] - prefix[s - w];
            let r = ((after + eps) / (before + eps)).ln();
            if r > best.0 {
                best = (r, s);
            }
        }
        if best.0 > 4f64.ln() {
            let o = (best.1 as f64 - c as f64) / sr;
            per_beat[i] = Some(o);
            offsets.push((o, best.0));
        }
    }
    if offsets.len() * 4 < frames.len() {
        return (0.0, vec![None; frames.len()]);
    }
    (weighted_median(&mut offsets).unwrap_or(0.0), per_beat)
}

/// Downbeat phase (0..3) and confidence from the per-beat accent pattern.
fn downbeat_phase(input: &TrackInput<'_>, frames: &[usize], idx: &[f64]) -> (u8, f32) {
    if frames.len() < 8 {
        return (0, 0.0);
    }
    let full: Vec<f32> = frames.iter().map(|&f| local_max(input.odf, f, 2)).collect();
    let low: Vec<f32> = frames.iter().map(|&f| local_max(input.low, f, 2)).collect();
    let fm = crate::util::mean(&full).max(1e-9);
    let lm = crate::util::mean(&low).max(1e-9);
    let mut sum = [0.0f64; 4];
    let mut cnt = [0usize; 4];
    for i in 0..frames.len() {
        let ph = (idx[i] as usize) % 4;
        sum[ph] += (full[i] / fm + low[i] / lm) as f64;
        cnt[ph] += 1;
    }
    let mut means = [0.0f64; 4];
    for p in 0..4 {
        means[p] = if cnt[p] > 0 {
            sum[p] / cnt[p] as f64
        } else {
            0.0
        };
    }
    let mut order = [0usize, 1, 2, 3];
    order.sort_by(|&a, &b| means[b].total_cmp(&means[a]));
    let (b1, b2) = (means[order[0]], means[order[1]]);
    let avg = means.iter().sum::<f64>() / 4.0;
    let conf = if avg > 0.0 {
        ((b1 - b2) / (0.5 * avg)).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (order[0] as u8, conf as f32)
}

/// Prefix sums for O(1) least-squares line fits of `times` against `idx` over any range.
struct LineSums {
    x: Vec<f64>,
    y: Vec<f64>,
    xx: Vec<f64>,
    xy: Vec<f64>,
    yy: Vec<f64>,
}

impl LineSums {
    fn new(idx: &[f64], times: &[f64]) -> Self {
        let n = idx.len().min(times.len());
        let mut s = Self {
            x: vec![0.0; n + 1],
            y: vec![0.0; n + 1],
            xx: vec![0.0; n + 1],
            xy: vec![0.0; n + 1],
            yy: vec![0.0; n + 1],
        };
        // Centre x and y so the sums stay well-conditioned on long tracks.
        let (x0, y0) = (
            idx.first().copied().unwrap_or(0.0),
            times.first().copied().unwrap_or(0.0),
        );
        for i in 0..n {
            let (x, y) = (idx[i] - x0, times[i] - y0);
            s.x[i + 1] = s.x[i] + x;
            s.y[i + 1] = s.y[i] + y;
            s.xx[i + 1] = s.xx[i] + x * x;
            s.xy[i + 1] = s.xy[i] + x * y;
            s.yy[i + 1] = s.yy[i] + y * y;
        }
        s
    }

    /// Sum of squared residuals of the best line through `lo..hi`.
    fn sse(&self, lo: usize, hi: usize) -> f64 {
        let n = (hi - lo) as f64;
        if n < 2.0 {
            return 0.0;
        }
        let sx = self.x[hi] - self.x[lo];
        let sy = self.y[hi] - self.y[lo];
        let cxx = (self.xx[hi] - self.xx[lo]) - sx * sx / n;
        let cxy = (self.xy[hi] - self.xy[lo]) - sx * sy / n;
        let cyy = (self.yy[hi] - self.yy[lo]) - sy * sy / n;
        if cxx <= 1e-12 {
            return cyy.max(0.0);
        }
        (cyy - cxy * cxy / cxx).max(0.0)
    }
}

/// Least-squares `(intercept, slope)` over `lo..hi`, slope in seconds per beat.
fn fit(idx: &[f64], times: &[f64], lo: usize, hi: usize) -> Option<(f64, f64)> {
    linear_fit(&idx[lo..hi], &times[lo..hi]).filter(|f| f.1 > 0.0)
}

fn needs_split(idx: &[f64], times: &[f64], lo: usize, hi: usize) -> bool {
    let Some((a, b)) = fit(idx, times, lo, hi) else {
        return false;
    };
    let mut sum = 0.0;
    let mut max = 0.0f64;
    for i in lo..hi {
        let r = (times[i] - (a + b * idx[i])).abs();
        sum += r * r;
        max = max.max(r);
    }
    (sum / (hi - lo) as f64).sqrt() > SPLIT_RMS_SEC || max > SPLIT_MAX_SEC
}

/// Binary segmentation into straight-line sections (`(start, end)` beat ranges, end exclusive).
fn split_sections(
    idx: &[f64],
    times: &[f64],
    sums: &LineSums,
    lo: usize,
    hi: usize,
    out: &mut Vec<(usize, usize)>,
) {
    if hi - lo < 2 * MIN_SECTION_BEATS || !needs_split(idx, times, lo, hi) {
        out.push((lo, hi));
        return;
    }
    let mut best = (f64::INFINITY, lo + MIN_SECTION_BEATS);
    for k in lo + MIN_SECTION_BEATS..=hi - MIN_SECTION_BEATS {
        let cost = sums.sse(lo, k) + sums.sse(k, hi);
        if cost < best.0 {
            best = (cost, k);
        }
    }
    split_sections(idx, times, sums, lo, best.1, out);
    split_sections(idx, times, sums, best.1, hi, out);
}

fn section_bpm(idx: &[f64], times: &[f64], s: (usize, usize)) -> Option<f64> {
    fit(idx, times, s.0, s.1).map(|(_, b)| 60.0 / b)
}

/// Merge adjacent sections whose tempos agree within [`MERGE_TOLERANCE`] (closest pair first).
fn merge_sections(
    idx: &[f64],
    times: &[f64],
    mut secs: Vec<(usize, usize)>,
) -> Vec<(usize, usize)> {
    loop {
        let mut best: Option<(f64, usize)> = None;
        for i in 0..secs.len().saturating_sub(1) {
            let (Some(a), Some(b)) = (
                section_bpm(idx, times, secs[i]),
                section_bpm(idx, times, secs[i + 1]),
            ) else {
                continue;
            };
            let d = (a / b - 1.0).abs();
            if d <= MERGE_TOLERANCE && best.is_none_or(|(bd, _)| d < bd) {
                best = Some((d, i));
            }
        }
        let Some((_, i)) = best else {
            return secs;
        };
        secs[i].1 = secs[i + 1].1;
        secs.remove(i + 1);
    }
}

/// Constant-tempo sections of the tracked beats; `(is_variable, anchors)`.
fn tempo_anchors(idx: &[f64], times: &[f64], bpm: f64) -> (bool, Vec<TempoAnchor>) {
    let n = idx.len().min(times.len());
    if n < 2 * MIN_SECTION_BEATS {
        return (false, Vec::new());
    }
    let sums = LineSums::new(&idx[..n], &times[..n]);
    let mut secs = Vec::new();
    split_sections(idx, times, &sums, 0, n, &mut secs);
    let secs = merge_sections(idx, times, secs);
    let mut anchors = Vec::with_capacity(secs.len());
    let mut max_dev = 0.0f64;
    for &(lo, hi) in &secs {
        let Some((a, b)) = fit(idx, times, lo, hi) else {
            continue;
        };
        let local = 60.0 / b;
        max_dev = max_dev.max((local / bpm - 1.0).abs());
        anchors.push(TempoAnchor {
            beat_index: idx[lo] as u32,
            time_sec: a + b * idx[lo],
            bpm: local,
        });
    }
    if anchors.len() >= 2 && max_dev > VARIABLE_THRESHOLD {
        (true, anchors)
    } else {
        (false, Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prior_prefers_the_dj_band() {
        let r = TempoRange::default();
        assert_eq!(r.prior(60.0), 0.0);
        assert_eq!(r.prior(190.0), 0.0);
        assert!(r.prior(128.0) > r.prior(72.0));
        assert!(r.prior(174.0) > 0.7 * r.prior(87.0));
    }

    #[test]
    fn dp_follows_a_pulse_train() {
        let mut onset = vec![0.0f32; 1000];
        for i in (37..1000).step_by(40) {
            onset[i] = 5.0;
        }
        let beats = trim_weak(&onset, dp_beats(&onset, 40.0));
        assert_eq!(beats.first(), Some(&37));
        assert!(beats.windows(2).all(|w| w[1] - w[0] == 40));
    }

    fn beat_times(first: f64, segments: &[(f64, usize)]) -> Vec<f64> {
        let mut t = first;
        let mut out = Vec::new();
        for &(bpm, n) in segments {
            for _ in 0..n {
                out.push(t);
                t += 60.0 / bpm;
            }
        }
        out
    }

    fn anchors_of(times: &[f64]) -> (bool, Vec<TempoAnchor>) {
        let idx: Vec<f64> = (0..times.len()).map(|i| i as f64).collect();
        let (_, b) = linear_fit(&idx, times).unwrap();
        tempo_anchors(&idx, times, 60.0 / b)
    }

    #[test]
    fn constant_tempo_has_no_markers_even_with_jitter() {
        let mut times = beat_times(0.3, &[(126.0, 200)]);
        for (i, t) in times.iter_mut().enumerate() {
            *t += 0.004 * ((i * 7919) % 11) as f64 / 10.0 - 0.002;
        }
        assert_eq!(anchors_of(&times), (false, Vec::new()));
    }

    #[test]
    fn step_change_gives_exactly_one_marker_at_the_step() {
        let times = beat_times(0.5, &[(120.0, 64), (128.0, 64)]);
        let (var, a) = anchors_of(&times);
        assert!(var);
        assert_eq!(a.len(), 2, "{a:?}");
        // Beat 64 lies on both lines, so either section may own it; the marker time is exact.
        let k = a[1].beat_index as usize;
        assert!(k == 64 || k == 65, "{a:?}");
        assert!((a[1].time_sec - times[k]).abs() < 1e-6, "{a:?}");
        assert!((a[0].bpm - 120.0).abs() < 1e-6 && (a[1].bpm - 128.0).abs() < 1e-6);
    }

    #[test]
    fn drift_gives_a_short_monotonic_marker_list() {
        // 120 → 128 BPM ramp over 160 beats.
        let mut times = Vec::new();
        let mut t = 0.2;
        for k in 0..160 {
            times.push(t);
            t += 60.0 / (120.0 + 8.0 * k as f64 / 160.0);
        }
        let (var, a) = anchors_of(&times);
        assert!(var);
        assert!((3..=10).contains(&a.len()), "{} sections", a.len());
        assert!(a.windows(2).all(|w| w[1].bpm > w[0].bpm), "{a:?}");
    }
}
