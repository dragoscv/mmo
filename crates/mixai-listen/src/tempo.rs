//! Tempo and beat phase: log-spectral-flux onset strength at ~100 frames/s, autocorrelation with a one-octave
//! comb and a log-Gaussian prior around 120 BPM, then a fine comb search (±3 %, 0.05 BPM) that also finds the
//! beat phase. Same family as `apps/mixai/.../analysis.rs`, rewritten to stream and to resolve octave errors.

use std::collections::VecDeque;

use crate::fft::{MagSpectrum, next_pow2};
use crate::ring::Ring;

/// Onset strength detector (half-wave rectified log-magnitude flux up to 8 kHz).
pub(crate) struct OnsetDetector {
    spec: MagSpectrum,
    frame: Vec<f32>,
    prev: Vec<f32>,
    max_bin: usize,
}

impl OnsetDetector {
    pub fn new(sample_rate: u32) -> Self {
        let n = next_pow2((sample_rate as f64 * 0.046) as usize);
        let max_bin = ((8000.0 * n as f64 / sample_rate as f64) as usize).min(n / 2);
        Self { spec: MagSpectrum::new(n), frame: vec![0.0; n], prev: vec![0.0; max_bin], max_bin }
    }

    pub fn window(&self) -> usize {
        self.spec.len()
    }

    pub fn step(&mut self, ring: &Ring) -> f32 {
        ring.copy_latest(&mut self.frame);
        self.spec.compute(&self.frame);
        let mut flux = 0.0f32;
        for (p, &m) in self.prev.iter_mut().zip(&self.spec.mags[..self.max_bin]) {
            let l = (1.0 + 100.0 * m).ln();
            let d = l - *p;
            if d > 0.0 {
                flux += d;
            }
            *p = l;
        }
        flux
    }

    pub fn reset(&mut self) {
        self.prev.iter_mut().for_each(|x| *x = 0.0);
    }
}

/// One tempo reading from an onset envelope.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct TempoPeak {
    pub bpm: f64,
    /// Peak / mean of the prior-weighted autocorrelation (≥ 1; ~1 = no periodicity).
    pub strength: f64,
    /// Envelope frames between the last beat and the end of the envelope.
    pub beat_offset: f64,
}

pub(crate) fn fold(mut bpm: f64, lo: f64, hi: f64) -> f64 {
    let hi = hi.max(lo * 2.0);
    if !(bpm > 0.0) || !bpm.is_finite() {
        return bpm;
    }
    while bpm < lo {
        bpm *= 2.0;
    }
    while bpm >= hi {
        bpm /= 2.0;
    }
    bpm
}

fn detrend(env: &[f32], rate: f64) -> Vec<f32> {
    let n = env.len();
    let w = ((rate * 0.25) as usize).max(1);
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + env[i] as f64;
    }
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(w);
            let b = (i + w + 1).min(n);
            let mean = (prefix[b] - prefix[a]) / (b - a) as f64;
            (env[i] as f64 - mean).max(0.0) as f32
        })
        .collect()
}

#[inline]
fn sample_at(x: &[f32], pos: f64) -> f64 {
    let i = pos.floor();
    let f = pos - i;
    let i = i as usize;
    let a = x[i] as f64;
    let b = if i + 1 < x.len() { x[i + 1] as f64 } else { a };
    a + (b - a) * f
}

/// Best (bpm, beat offset, contrast) near `bpm0` by comb alignment over the whole envelope. Contrast = mean
/// onset strength on the beat grid divided by the envelope mean (1 = no alignment).
fn refine(x: &[f32], rate: f64, bpm0: f64) -> (f64, f64, f64) {
    let end = (x.len() - 1) as f64;
    let mut best = (bpm0, 0.0, f64::MIN);
    let steps = ((bpm0 * 0.04) / 0.1).round() as i64;
    for s in -steps / 2..=steps / 2 {
        let bpm = bpm0 + s as f64 * 0.1;
        let p = 60.0 * rate / bpm;
        let mut o = 0.0;
        while o < p {
            let mut acc = 0.0;
            let mut cnt = 0usize;
            let mut pos = end - o;
            while pos >= 0.0 {
                acc += sample_at(x, pos);
                cnt += 1;
                pos -= p;
            }
            let score = acc / cnt.max(1) as f64;
            if score > best.2 {
                best = (bpm, o, score);
            }
            o += 0.5;
        }
    }
    let mean = x.iter().map(|&v| v as f64).sum::<f64>() / x.len() as f64;
    (best.0, best.1, if mean > 0.0 { best.2 / mean } else { 1.0 })
}

/// Tempo of an onset envelope sampled at `rate` frames/s, folded into `[lo, hi)`. Needs ≥ 3 s.
pub(crate) fn estimate(env: &[f32], rate: f64, lo: f64, hi: f64) -> Option<TempoPeak> {
    let n = env.len();
    if (n as f64) < rate * 3.0 {
        return None;
    }
    let x = detrend(env, rate);
    if x.iter().all(|&v| v <= 1e-9) {
        return None;
    }
    let lag_lo = ((60.0 * rate / 240.0).floor() as usize).max(2);
    let lag_hi = ((60.0 * rate / 40.0).ceil() as usize).min((n - 1) / 2);
    if lag_hi <= lag_lo + 2 {
        return None;
    }
    let max_lag = (4 * lag_hi).min(n - 1);
    let mut ac = vec![0.0f64; max_lag + 1];
    for (l, a) in ac.iter_mut().enumerate().skip(1) {
        let mut s = 0.0f64;
        for i in l..n {
            s += x[i] as f64 * x[i - l] as f64;
        }
        *a = s / (n - l) as f64;
    }
    // Comb over the first four lag multiples: at the true beat period every multiple lands on a kick, while a
    // dotted/triplet period (2/3×, 4/3× tempo) only lands on one every other multiple.
    let at = |l: usize| if l <= max_lag { ac[l] } else { 0.0 };
    let score: Vec<f64> = (lag_lo..=lag_hi)
        .map(|l| {
            let bpm = 60.0 * rate / l as f64;
            let z = (bpm / 120.0).log2();
            let prior = (-0.5 * z * z).exp();
            let comb = at(l) + at(2 * l) + at(3 * l) + at(4 * l);
            comb * prior
        })
        .collect();
    let (bi, &best) = score.iter().enumerate().skip(1).take(score.len() - 2).max_by(|a, b| a.1.total_cmp(b.1))?;
    if best <= 0.0 {
        return None;
    }
    let (a, b, c) = (score[bi - 1], best, score[bi + 1]);
    let denom = a - 2.0 * b + c;
    let delta = if denom.abs() > 1e-12 { (0.5 * (a - c) / denom).clamp(-0.5, 0.5) } else { 0.0 };
    let lag = (lag_lo + bi) as f64 + delta;
    let mean = score.iter().sum::<f64>() / score.len() as f64;
    let coarse = fold(60.0 * rate / lag, lo, hi);
    // Metrical-level check: the true beat grid lines up with onsets on every beat, a dotted / triplet grid
    // (2/3, 3/4, 4/3, 3/2 of the tempo) only on some. Keep the candidate with the best grid contrast, with a
    // small bias for the autocorrelation winner.
    let mut pick = refine(&x, rate, coarse);
    let mut pick_score = pick.2 * 1.05;
    for ratio in [2.0 / 3.0, 3.0 / 4.0, 0.8, 1.25, 4.0 / 3.0, 1.5] {
        let cand = coarse * ratio;
        if cand < lo || cand >= hi.max(lo * 2.0) {
            continue;
        }
        let r = refine(&x, rate, cand);
        if r.2 > pick_score {
            pick_score = r.2;
            pick = r;
        }
    }
    let (bpm, beat_offset, _) = pick;
    Some(TempoPeak { bpm: fold(bpm, lo, hi), strength: if mean > 0.0 { best / mean } else { 1.0 }, beat_offset })
}

/// Public tempo reading.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TempoEstimate {
    pub bpm: f64,
    /// 0..1.
    pub confidence: f64,
    /// Stable for long enough to stop hunting (UI "locked").
    pub locked: bool,
    /// 0..1 position inside the current beat (0 = on the beat).
    pub beat_phase: f64,
    /// Seconds until the next predicted beat (for the haptic pulse / beat ring).
    pub next_beat_in_secs: f64,
}

pub(crate) struct TempoTracker {
    rate: f64,
    lo: f64,
    hi: f64,
    env: VecDeque<f32>,
    cap: usize,
    since_estimate: usize,
    history: VecDeque<f64>,
    good_streak: u32,
    locked: bool,
    last: Option<(TempoPeak, f64)>,
    latency_secs: f64,
    total_frames: u64,
}

impl TempoTracker {
    pub fn new(rate: f64, lo: f64, hi: f64, window_secs: f64, latency_secs: f64) -> Self {
        let cap = (rate * window_secs) as usize;
        Self {
            rate,
            lo,
            hi,
            env: VecDeque::with_capacity(cap),
            cap,
            since_estimate: 0,
            history: VecDeque::with_capacity(8),
            good_streak: 0,
            locked: false,
            last: None,
            latency_secs,
            total_frames: 0,
        }
    }

    pub fn push(&mut self, onset: f32) {
        if self.env.len() == self.cap {
            self.env.pop_front();
        }
        self.env.push_back(onset);
        self.total_frames += 1;
        self.since_estimate += 1;
        if self.since_estimate >= (self.rate * 0.5) as usize {
            self.since_estimate = 0;
            self.update();
        }
    }

    fn update(&mut self) {
        let env: Vec<f32> = self.env.iter().copied().collect();
        let now = self.total_frames as f64 / self.rate;
        let Some(peak) = estimate(&env, self.rate, self.lo, self.hi) else {
            self.good_streak = 0;
            return;
        };
        if self.history.len() == 8 {
            self.history.pop_front();
        }
        self.history.push_back(peak.bpm);
        self.last = Some((peak, now));
        let conf = self.confidence();
        if conf >= 0.6 && now >= 6.0 {
            self.good_streak += 1;
        } else {
            self.good_streak = 0;
            if conf < 0.3 {
                self.locked = false;
            }
        }
        if self.good_streak >= 4 {
            self.locked = true;
        }
    }

    fn median(&self) -> Option<f64> {
        if self.history.is_empty() {
            return None;
        }
        let mut v: Vec<f64> = self.history.iter().copied().collect();
        v.sort_by(f64::total_cmp);
        Some(v[v.len() / 2])
    }

    fn confidence(&self) -> f64 {
        let (Some(med), Some((peak, _))) = (self.median(), self.last) else { return 0.0 };
        let stable = self.history.iter().filter(|b| ((**b - med) / med).abs() < 0.02).count() as f64
            / self.history.len().max(4) as f64;
        let strength = ((peak.strength - 1.0) / 2.0).clamp(0.0, 1.0);
        (0.6 * stable + 0.4 * strength).clamp(0.0, 1.0)
    }

    /// Reading at `now_secs` (stream time); beat phase extrapolated from the last estimate.
    pub fn snapshot(&self, now_secs: f64) -> Option<TempoEstimate> {
        let bpm = self.median()?;
        let (peak, at) = self.last?;
        let period = 60.0 / bpm;
        let last_beat = at - peak.beat_offset / self.rate - self.latency_secs;
        let phase = ((now_secs - last_beat) / period).rem_euclid(1.0);
        Some(TempoEstimate {
            bpm,
            confidence: self.confidence(),
            locked: self.locked,
            beat_phase: phase,
            next_beat_in_secs: (1.0 - phase) * period,
        })
    }

    pub fn reset(&mut self) {
        self.env.clear();
        self.history.clear();
        self.good_streak = 0;
        self.locked = false;
        self.last = None;
        self.since_estimate = 0;
        self.total_frames = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Onset envelope with an impulse on every beat (plus weaker off-beat hats) at 100 frames/s.
    fn envelope(bpm: f64, secs: f64, offbeat: f32) -> Vec<f32> {
        let rate = 100.0;
        let n = (secs * rate) as usize;
        let mut env = vec![0.02f32; n];
        let period = 60.0 * rate / bpm;
        let mut t = 7.0;
        while (t as usize) < n {
            env[t as usize] = 1.0;
            let half = (t + period / 2.0) as usize;
            if half < n {
                env[half] = env[half].max(offbeat);
            }
            t += period;
        }
        env
    }

    #[test]
    fn finds_common_dance_tempos_in_the_default_band() {
        for bpm in [90.0, 124.0, 128.0, 140.0, 150.0, 174.0] {
            let p = estimate(&envelope(bpm, 10.0, 0.4), 100.0, 88.0, 176.0).unwrap();
            assert!((p.bpm - bpm).abs() < 0.6, "{bpm} -> {}", p.bpm);
            assert!(p.strength > 1.5, "{bpm}: strength {}", p.strength);
        }
    }

    #[test]
    fn folds_into_the_requested_band() {
        assert_eq!(fold(64.0, 88.0, 176.0), 128.0);
        assert_eq!(fold(256.0, 88.0, 176.0), 128.0);
        assert_eq!(fold(174.0, 88.0, 176.0), 174.0);
        assert_eq!(fold(174.0, 70.0, 140.0), 87.0);
    }

    #[test]
    fn flat_envelope_has_no_tempo() {
        assert!(estimate(&vec![0.3; 800], 100.0, 88.0, 176.0).is_none());
        assert!(estimate(&vec![0.3; 100], 100.0, 88.0, 176.0).is_none());
    }

    #[test]
    fn beat_offset_points_at_the_last_impulse() {
        let env = envelope(120.0, 8.0, 0.0);
        let p = estimate(&env, 100.0, 88.0, 176.0).unwrap();
        let last = env.iter().rposition(|&v| v == 1.0).unwrap() as f64;
        let expected = (env.len() - 1) as f64 - last;
        assert!((p.beat_offset - expected).abs() <= 1.0, "offset {} vs {}", p.beat_offset, expected);
    }

    #[test]
    fn tracker_locks_on_a_steady_beat_and_predicts_the_next_one() {
        let env = envelope(126.0, 12.0, 0.3);
        let mut tr = TempoTracker::new(100.0, 88.0, 176.0, 8.0, 0.0);
        for v in &env {
            tr.push(*v);
        }
        let s = tr.snapshot(12.0).unwrap();
        assert!((s.bpm - 126.0).abs() < 0.6, "{}", s.bpm);
        assert!(s.locked, "conf {}", s.confidence);
        assert!(s.next_beat_in_secs > 0.0 && s.next_beat_in_secs <= 60.0 / s.bpm + 1e-9);
    }
}
