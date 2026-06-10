//! Offline BPM + beatgrid analysis.
//!
//! Fully permissive (hand-written, no GPL deps) so it ships inside the
//! distributable engine. The approach is the classic two-stage tempo
//! estimator used by most DJ tools:
//!
//! 1. **Onset envelope** — a coarse spectral-flux-like energy novelty curve:
//!    we frame the mono mix, take the per-frame RMS energy, and keep the
//!    positive first difference (rising energy = note onset).
//! 2. **Tempo estimation** — autocorrelate the onset envelope and pick the
//!    lag with the strongest periodicity inside a musical BPM range, folding
//!    octave errors into a preferred band (90–180 BPM).
//! 3. **Beat phase** — slide a beat comb over the envelope to find the offset
//!    (first downbeat) that best aligns with the detected period.

use crate::deck::TrackBuffer;

/// Result of analysing a track.
#[derive(Debug, Clone, Copy)]
pub struct BeatAnalysis {
    /// Estimated tempo in beats per minute.
    pub bpm: f64,
    /// Time of the first beat in seconds (beatgrid phase anchor).
    pub first_beat_secs: f64,
    /// Confidence 0..1 (relative strength of the winning autocorrelation peak).
    pub confidence: f64,
}

/// Hop size for the onset envelope, in source frames.
const HOP: usize = 512;
/// Analysis BPM search range.
const MIN_BPM: f64 = 70.0;
const MAX_BPM: f64 = 200.0;
/// Preferred fold band (most dance music sits here).
const FOLD_LO: f64 = 90.0;
const FOLD_HI: f64 = 180.0;

/// Compute the onset (energy-novelty) envelope at `env_sr` = sample_rate / HOP.
fn onset_envelope(buf: &TrackBuffer) -> (Vec<f32>, f64) {
    let frames = buf.frames();
    let env_sr = buf.sample_rate as f64 / HOP as f64;
    if frames < HOP * 2 {
        return (Vec::new(), env_sr);
    }
    let n = frames / HOP;
    let mut energy = Vec::with_capacity(n);
    for h in 0..n {
        let start = h * HOP;
        let end = (start + HOP).min(frames);
        let mut sum = 0.0f64;
        for i in start..end {
            let m = (buf.left[i] + buf.right[i]) * 0.5;
            sum += (m as f64) * (m as f64);
        }
        energy.push((sum / (end - start) as f64).sqrt() as f32);
    }
    // Positive first difference = rising-energy novelty.
    let mut env = vec![0.0f32; n];
    for i in 1..n {
        let d = energy[i] - energy[i - 1];
        env[i] = if d > 0.0 { d } else { 0.0 };
    }
    // Normalize.
    let max = env.iter().cloned().fold(0.0f32, f32::max);
    if max > 0.0 {
        for v in &mut env {
            *v /= max;
        }
    }
    (env, env_sr)
}

/// Autocorrelation of `env` at integer `lag`.
fn autocorr(env: &[f32], lag: usize) -> f64 {
    if lag == 0 || lag >= env.len() {
        return 0.0;
    }
    let mut acc = 0.0f64;
    for i in lag..env.len() {
        acc += env[i] as f64 * env[i - lag] as f64;
    }
    acc
}

/// Fold a BPM into the preferred [FOLD_LO, FOLD_HI] band by doubling/halving.
fn fold_bpm(mut bpm: f64) -> f64 {
    while bpm < FOLD_LO {
        bpm *= 2.0;
    }
    while bpm > FOLD_HI {
        bpm /= 2.0;
    }
    bpm
}

/// Analyse a decoded track for tempo + beat phase.
pub fn analyze(buf: &TrackBuffer) -> BeatAnalysis {
    let (env, env_sr) = onset_envelope(buf);
    if env.len() < 16 || env_sr <= 0.0 {
        return BeatAnalysis { bpm: 0.0, first_beat_secs: 0.0, confidence: 0.0 };
    }

    // Lag search bounds (in envelope samples) for the BPM range.
    let lag_min = ((60.0 / MAX_BPM) * env_sr).round().max(1.0) as usize;
    let lag_max = ((60.0 / MIN_BPM) * env_sr).round() as usize;
    let lag_max = lag_max.min(env.len() / 2);

    let mut best_lag = lag_min;
    let mut best_score = 0.0f64;
    let mut total = 0.0f64;
    let mut count = 0.0f64;
    for lag in lag_min..=lag_max {
        let s = autocorr(&env, lag);
        total += s;
        count += 1.0;
        if s > best_score {
            best_score = s;
            best_lag = lag;
        }
    }

    let period_secs = best_lag as f64 / env_sr;
    let raw_bpm = 60.0 / period_secs;
    let bpm = fold_bpm(raw_bpm);

    // Beat phase: slide a unit-spaced comb (period = best_lag) over the
    // envelope and pick the offset with the strongest accumulated energy.
    let period = best_lag.max(1);
    let mut best_phase = 0usize;
    let mut best_phase_score = -1.0f64;
    for phase in 0..period {
        let mut acc = 0.0f64;
        let mut k = phase;
        while k < env.len() {
            acc += env[k] as f64;
            k += period;
        }
        if acc > best_phase_score {
            best_phase_score = acc;
            best_phase = phase;
        }
    }
    let first_beat_secs = best_phase as f64 / env_sr;

    let mean = if count > 0.0 { total / count } else { 0.0 };
    let confidence = if mean > 0.0 {
        ((best_score / mean) / 10.0).clamp(0.0, 1.0)
    } else {
        0.0
    };

    BeatAnalysis { bpm, first_beat_secs, confidence }
}
