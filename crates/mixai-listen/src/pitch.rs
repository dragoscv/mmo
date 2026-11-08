//! Monophonic pitch for the chromatic tuner: McLeod Pitch Method (normalised square difference function, key
//! maximum above 0.9 × the highest, parabolic interpolation). The autocorrelation runs through a zero-padded FFT
//! so a 2048-sample window costs two real FFTs instead of N².

use std::sync::Arc;

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex, num_complex::Complex};

use crate::notation::PITCH_NAMES;
use crate::ring::Ring;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PitchEstimate {
    pub hz: f64,
    /// MIDI note number of the nearest equal-tempered note (A4 = 69) at the user's reference.
    pub midi: i32,
    /// −50..50 cents from that note.
    pub cents: f64,
    /// 0..1 NSDF peak (periodicity); below ~0.8 the reading is not shown.
    pub clarity: f64,
}

impl PitchEstimate {
    /// `A4`, `C#3`.
    pub fn note_name(&self) -> String {
        format!("{}{}", PITCH_NAMES[self.midi.rem_euclid(12) as usize], self.midi.div_euclid(12) - 1)
    }
}

pub(crate) struct PitchDetector {
    sr: f64,
    n: usize,
    frame: Vec<f32>,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    buf: Vec<f32>,
    spec: Vec<Complex<f32>>,
    min_lag: usize,
    max_lag: usize,
}

impl PitchDetector {
    pub fn new(sample_rate: u32) -> Self {
        let n = crate::fft::next_pow2((sample_rate as f64 * 0.046) as usize);
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(2 * n);
        let inv = planner.plan_fft_inverse(2 * n);
        let sr = sample_rate as f64;
        Self {
            sr,
            n,
            frame: vec![0.0; n],
            buf: fwd.make_input_vec(),
            spec: fwd.make_output_vec(),
            fwd,
            inv,
            // 1400 Hz .. 40 Hz (bass E1 = 41 Hz needs a longer window; 46 ms covers ~2 periods of 43 Hz).
            min_lag: (sr / 1400.0) as usize,
            max_lag: ((sr / 40.0) as usize).min(n - 2),
        }
    }

    pub fn window(&self) -> usize {
        self.n
    }

    pub fn step(&mut self, ring: &Ring, a4: f64) -> Option<PitchEstimate> {
        ring.copy_latest(&mut self.frame);
        let rms = (self.frame.iter().map(|x| x * x).sum::<f32>() / self.n as f32).sqrt();
        if rms < 1e-3 {
            return None;
        }
        self.buf[..self.n].copy_from_slice(&self.frame);
        self.buf[self.n..].iter_mut().for_each(|x| *x = 0.0);
        let _ = self.fwd.process(&mut self.buf, &mut self.spec);
        for c in &mut self.spec {
            *c = Complex::new(c.norm_sqr(), 0.0);
        }
        let _ = self.inv.process(&mut self.spec, &mut self.buf);
        let scale = 1.0 / (2 * self.n) as f32;
        // NSDF n'(τ) = 2 r(τ) / m(τ), m(τ) = Σ x[j]² + x[j+τ]² over the overlap.
        let mut m = 2.0 * self.buf[0] * scale;
        let mut nsdf = vec![0.0f32; self.max_lag + 2];
        for tau in 0..nsdf.len() {
            if tau > 0 {
                let a = self.frame[tau - 1];
                let b = self.frame[self.n - tau];
                m -= a * a + b * b;
            }
            nsdf[tau] = if m > 1e-9 { 2.0 * self.buf[tau] * scale / m } else { 0.0 };
        }
        // Key maxima: highest point between each positive-going and negative-going zero crossing.
        let mut maxima: Vec<(usize, f32)> = Vec::new();
        let mut tau = 1;
        while tau < nsdf.len() - 1 && nsdf[tau] > 0.0 {
            tau += 1;
        }
        while tau < nsdf.len() - 1 {
            while tau < nsdf.len() - 1 && nsdf[tau] <= 0.0 {
                tau += 1;
            }
            let mut best = (tau, nsdf[tau]);
            while tau < nsdf.len() - 1 && nsdf[tau] > 0.0 {
                if nsdf[tau] > best.1 {
                    best = (tau, nsdf[tau]);
                }
                tau += 1;
            }
            if best.0 >= self.min_lag && best.0 <= self.max_lag && best.1 > 0.0 {
                maxima.push(best);
            }
        }
        let highest = maxima.iter().map(|m| m.1).fold(0.0f32, f32::max);
        let &(t, clarity) = maxima.iter().find(|m| m.1 >= 0.9 * highest)?;
        let (a, b, c) = (nsdf[t - 1] as f64, nsdf[t] as f64, nsdf[t + 1] as f64);
        let denom = a - 2.0 * b + c;
        let delta = if denom.abs() > 1e-12 { (0.5 * (a - c) / denom).clamp(-0.5, 0.5) } else { 0.0 };
        let hz = self.sr / (t as f64 + delta);
        let semis = 12.0 * (hz / a4).log2() + 69.0;
        let midi = semis.round() as i32;
        Some(PitchEstimate { hz, midi, cents: (semis - midi as f64) * 100.0, clarity: clarity as f64 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chroma::synth::*;

    fn detect(hz: f32, a4: f64) -> PitchEstimate {
        let sr = 48_000;
        let mut d = PitchDetector::new(sr);
        let mut ring = Ring::new(d.window());
        let mut s = vec![0.0f32; d.window() * 2];
        let len = s.len();
        add_tone(&mut s, sr, 0, len, hz, 0.3);
        for x in &s[..d.window() + 500] {
            ring.push(*x);
        }
        d.step(&ring, a4).expect("pitch")
    }

    #[test]
    fn reads_guitar_strings_within_two_cents() {
        for (note, name) in [(40.0, "E2"), (45.0, "A2"), (50.0, "D3"), (55.0, "G3"), (59.0, "B3"), (64.0, "E4"), (69.0, "A4")] {
            let p = detect(midi_hz(note, 440.0), 440.0);
            assert_eq!(p.note_name(), name);
            assert!(p.cents.abs() < 2.0, "{name}: {} cents", p.cents);
            assert!(p.clarity > 0.9, "{name}: clarity {}", p.clarity);
        }
    }

    #[test]
    fn reports_cents_against_the_chosen_reference() {
        let p = detect(442.0, 440.0);
        assert_eq!(p.note_name(), "A4");
        assert!((p.cents - 7.85).abs() < 1.5, "{}", p.cents);
        let p = detect(442.0, 442.0);
        assert!(p.cents.abs() < 1.5, "{}", p.cents);
    }

    #[test]
    fn noise_has_low_clarity_or_no_pitch() {
        let sr = 48_000;
        let mut d = PitchDetector::new(sr);
        let mut ring = Ring::new(d.window());
        let mut rng = Lcg(7);
        for _ in 0..d.window() {
            ring.push(rng.next() * 0.3);
        }
        assert!(d.step(&ring, 440.0).is_none_or(|p| p.clarity < 0.8));
    }
}
