//! Harmonic pitch-class profile (HPCP-style chroma) and reference tuning from spectral peaks.
//!
//! Each frame: Hann-windowed spectrum (~186 ms), local maxima above −50 dB relative to the frame peak in
//! 65 Hz–5 kHz, parabolic interpolation on log magnitude → exact frequency → semitone position. Each peak adds
//! cos²-weighted energy to the two nearest pitch classes (after removing the estimated tuning offset), and to
//! the pitch classes of its first sub-harmonics (h = 2..4, weight 0.6^(h-1)) the way HPCP does, so a bass note's
//! overtones reinforce the root instead of smearing the profile.

use crate::fft::{MagSpectrum, next_pow2};
use crate::ring::Ring;

const F_MIN: f32 = 65.0;
const F_MAX: f32 = 5000.0;
const HARMONICS: [(f32, f32); 4] = [(1.0, 1.0), (2.0, 0.6), (3.0, 0.36), (4.0, 0.216)];
/// Half-width (semitones) of the cos² weighting window.
const HALF_WIDTH: f32 = 0.66;

pub(crate) struct ChromaFrame {
    pub chroma: [f32; 12],
    /// Sum of interpolated peak magnitudes that fed the frame (0 = silent / noise only).
    pub energy: f32,
}

pub(crate) struct ChromaAnalyzer {
    spec: MagSpectrum,
    frame: Vec<f32>,
    bin_hz: f32,
    lo_bin: usize,
    hi_bin: usize,
    /// Running circular tuning accumulator (cos, sin) weighted by peak magnitude, with slow decay.
    tune: (f64, f64),
}

impl ChromaAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let n = next_pow2((sample_rate as f64 * 0.186) as usize);
        let bin_hz = sample_rate as f32 / n as f32;
        let lo_bin = ((F_MIN / bin_hz).floor() as usize).max(2);
        let hi_bin = ((F_MAX / bin_hz).ceil() as usize).min(n / 2 - 2);
        Self { spec: MagSpectrum::new(n), frame: vec![0.0; n], bin_hz, lo_bin, hi_bin, tune: (0.0, 0.0) }
    }

    pub fn window(&self) -> usize {
        self.spec.len()
    }

    /// Reference tuning offset in semitones (−0.5..0.5); +0.233 ≈ A4 = 446 Hz.
    pub fn tuning_semitones(&self) -> f32 {
        if self.tune.0.abs() + self.tune.1.abs() < 1e-12 {
            return 0.0;
        }
        (self.tune.1.atan2(self.tune.0) / std::f64::consts::TAU) as f32
    }

    pub fn step(&mut self, ring: &Ring) -> ChromaFrame {
        ring.copy_latest(&mut self.frame);
        self.spec.compute(&self.frame);
        let m = &self.spec.mags;
        let peak = m[self.lo_bin..=self.hi_bin].iter().copied().fold(0.0f32, f32::max);
        let mut out = ChromaFrame { chroma: [0.0; 12], energy: 0.0 };
        if peak < 1e-4 {
            return out;
        }
        let floor = peak * 0.003; // −50 dB
        let tuning = self.tuning_semitones();
        let mut tc = 0.0f64;
        let mut ts = 0.0f64;
        for k in self.lo_bin..=self.hi_bin {
            let v = m[k];
            if v < floor || v <= m[k - 1] || v < m[k + 1] {
                continue;
            }
            let (a, b, c) = ((m[k - 1] + 1e-9).ln(), (v + 1e-9).ln(), (m[k + 1] + 1e-9).ln());
            let denom = a - 2.0 * b + c;
            let delta = if denom.abs() > 1e-9 { (0.5 * (a - c) / denom).clamp(-0.5, 0.5) } else { 0.0 };
            let freq = (k as f32 + delta) * self.bin_hz;
            let mag = (b - 0.25 * (a - c) * delta).exp();
            let semis = 12.0 * (freq / 440.0).log2() + 69.0;
            let dev = semis - semis.round();
            let w = mag as f64;
            tc += w * (std::f64::consts::TAU * dev as f64).cos();
            ts += w * (std::f64::consts::TAU * dev as f64).sin();
            out.energy += mag;
            for (h, hw) in HARMONICS {
                let s = semis - 12.0 * h.log2() - tuning;
                let base = s.floor();
                for p in [base, base + 1.0] {
                    let d = (s - p).abs();
                    if d < HALF_WIDTH {
                        let c = (std::f32::consts::FRAC_PI_2 * d / HALF_WIDTH).cos();
                        out.chroma[(p as i64).rem_euclid(12) as usize] += mag * hw * c * c;
                    }
                }
            }
        }
        // Slow decay (≈ 60 s at 10 frames/s) so a re-tuned set follows, but one odd frame does not.
        self.tune = (self.tune.0 * 0.998 + tc, self.tune.1 * 0.998 + ts);
        let max = out.chroma.iter().copied().fold(0.0f32, f32::max);
        if max > 0.0 {
            out.chroma.iter_mut().for_each(|x| *x /= max);
        }
        out
    }

    pub fn reset(&mut self) {
        self.tune = (0.0, 0.0);
    }
}

/// Synthetic test signals shared by the analysis tests.
#[cfg(test)]
pub(crate) mod synth {
    use std::f32::consts::TAU;

    pub fn midi_hz(note: f32, a4: f32) -> f32 {
        a4 * 2f32.powf((note - 69.0) / 12.0)
    }

    /// Adds a harmonic tone (6 partials, 1/h amplitudes) with a soft attack/decay envelope.
    pub fn add_tone(out: &mut [f32], sr: u32, start: usize, len: usize, hz: f32, amp: f32) {
        let end = (start + len).min(out.len());
        for i in start..end {
            let t = (i - start) as f32 / sr as f32;
            let env = (t / 0.01).min(1.0) * (1.0 - (i - start) as f32 / len as f32).max(0.0).sqrt();
            let mut s = 0.0;
            for h in 1..=6 {
                s += (TAU * hz * h as f32 * t).sin() / h as f32;
            }
            out[i] += amp * env * s;
        }
    }

    /// i-iv-V-i (minor) or I-IV-V-I (major) on `tonic` (MIDI), each chord `chord_secs`, with a bass root.
    pub fn cadence(sr: u32, tonic: i32, minor: bool, chord_secs: f32, repeats: usize, a4: f32) -> Vec<f32> {
        let third = if minor { 3 } else { 4 };
        let chords: [[i32; 3]; 4] = [
            [0, third, 7],
            [5, 5 + third, 12],
            [7, 11, 14], // V is major in both modes (harmonic minor leading tone)
            [0, third, 7],
        ];
        let len = (chord_secs * sr as f32) as usize;
        let mut out = vec![0.0f32; len * 4 * repeats];
        for r in 0..repeats {
            for (c, chord) in chords.iter().enumerate() {
                let start = (r * 4 + c) * len;
                for &iv in chord {
                    add_tone(&mut out, sr, start, len, midi_hz((tonic + iv) as f32, a4), 0.12);
                }
                add_tone(&mut out, sr, start, len, midi_hz((tonic + chord[0] - 12) as f32, a4), 0.16);
            }
        }
        out
    }

    /// Deterministic white noise in −1..1.
    pub struct Lcg(pub u32);
    impl Lcg {
        pub fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1u32 << 23) as f32 - 1.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::synth::*;
    use super::*;

    fn run(signal: &[f32], sr: u32) -> (ChromaAnalyzer, [f32; 12]) {
        let mut a = ChromaAnalyzer::new(sr);
        let mut ring = Ring::new(a.window());
        let hop = sr as usize / 10;
        let mut acc = [0.0f32; 12];
        for (i, &s) in signal.iter().enumerate() {
            ring.push(s);
            if i >= a.window() && i % hop == 0 {
                let f = a.step(&ring);
                for (x, c) in acc.iter_mut().zip(f.chroma) {
                    *x += c;
                }
            }
        }
        (a, acc)
    }

    #[test]
    fn a_major_triad_lights_a_c_sharp_and_e() {
        let sr = 44_100;
        let mut s = vec![0.0f32; sr as usize * 2];
        let len = s.len();
        for n in [57.0, 61.0, 64.0] {
            add_tone(&mut s, sr, 0, len, midi_hz(n, 440.0), 0.2);
        }
        let (_, acc) = run(&s, sr);
        let mut idx: Vec<usize> = (0..12).collect();
        idx.sort_by(|a, b| acc[*b].total_cmp(&acc[*a]));
        let mut top: Vec<usize> = idx[..3].to_vec();
        top.sort();
        assert_eq!(top, vec![1, 4, 9], "chroma {acc:?}");
    }

    #[test]
    fn estimates_a_detuned_reference() {
        let sr = 44_100;
        let s = cadence(sr, 57, true, 1.0, 2, 446.0);
        let (a, _) = run(&s, sr);
        let cents = a.tuning_semitones() * 100.0;
        let want = 1200.0 * (446.0f32 / 440.0).log2();
        assert!((cents - want).abs() < 4.0, "tuning {cents} vs {want}");
    }
}
