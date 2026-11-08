//! Log-frequency spectrogram for the key CNN (WP18-16): 24 bins per octave from C2 (65.4 Hz) over five
//! octaves (120 bins), ~186 ms window, 5 frames/s, `ln(1 + 1000·x)` compression. The SAME code produces the
//! training features (`mixai-listen-bench --dump-features`) and the on-device input, so there is no
//! train/inference skew. Pitch shifting by one semitone = moving two bins, which is how training augments.

use crate::fft::{MagSpectrum, next_pow2};
use crate::ring::Ring;

pub const BINS_PER_OCTAVE: usize = 24;
pub const BINS: usize = 120;
pub const FRAMES_PER_SEC: f64 = 5.0;
const F_MIN: f64 = 65.406_391_325_149_66; // C2

pub(crate) struct LogSpec {
    spec: MagSpectrum,
    frame: Vec<f32>,
    /// Per log bin: (first FFT bin, weights).
    filters: Vec<(usize, Vec<f32>)>,
}

impl LogSpec {
    pub fn new(sample_rate: u32) -> Self {
        let n = next_pow2((sample_rate as f64 * 0.186) as usize);
        let bin_hz = sample_rate as f64 / n as f64;
        let nyq_bin = n / 2;
        let center = |k: f64| F_MIN * 2f64.powf(k / BINS_PER_OCTAVE as f64);
        let filters = (0..BINS)
            .map(|k| {
                let c = center(k as f64);
                let mut lo = center(k as f64 - 1.0);
                let mut hi = center(k as f64 + 1.0);
                // Below ~200 Hz the quarter-tone spacing is finer than an FFT bin: widen to ±1 bin so every
                // log bin sees energy (neighbouring log bins then share FFT bins, like madmom's filterbank).
                if c - lo < bin_hz {
                    lo = c - bin_hz;
                }
                if hi - c < bin_hz {
                    hi = c + bin_hz;
                }
                let first = ((lo / bin_hz).floor().max(0.0) as usize).min(nyq_bin);
                let last = ((hi / bin_hz).ceil() as usize).min(nyq_bin);
                let mut w: Vec<f32> = (first..=last)
                    .map(|b| {
                        let f = b as f64 * bin_hz;
                        let v = if f <= c { (f - lo) / (c - lo) } else { (hi - f) / (hi - c) };
                        v.max(0.0) as f32
                    })
                    .collect();
                let sum: f32 = w.iter().sum();
                if sum > 0.0 {
                    w.iter_mut().for_each(|x| *x /= sum);
                }
                (first, w)
            })
            .collect();
        Self { spec: MagSpectrum::new(n), frame: vec![0.0; n], filters }
    }

    pub fn window(&self) -> usize {
        self.spec.len()
    }

    pub fn step(&mut self, ring: &Ring, out: &mut [f32; BINS]) {
        ring.copy_latest(&mut self.frame);
        self.spec.compute(&self.frame);
        for (o, (first, w)) in out.iter_mut().zip(&self.filters) {
            let e: f32 = w.iter().zip(&self.spec.mags[*first..]).map(|(a, b)| a * b).sum();
            *o = (1.0 + 1000.0 * e).ln();
        }
    }
}

/// Whole-signal log spectrogram, row-major `[frames][BINS]`.
pub fn log_spectrogram(samples: &[f32], sample_rate: u32) -> Vec<[f32; BINS]> {
    let sr = sample_rate.clamp(8_000, 192_000);
    let mut ls = LogSpec::new(sr);
    let mut ring = Ring::new(ls.window());
    let hop = (sr as f64 / FRAMES_PER_SEC) as usize;
    let mut out = Vec::with_capacity(samples.len() / hop + 1);
    let mut frame = [0.0f32; BINS];
    for (i, &s) in samples.iter().enumerate() {
        ring.push(if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 });
        let n = i + 1;
        if n >= ls.window() && (n - ls.window()) % hop == 0 {
            ls.step(&ring, &mut frame);
            out.push(frame);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chroma::synth::*;

    #[test]
    fn a_tone_peaks_in_its_own_bin_and_a_semitone_is_two_bins() {
        let sr = 44_100;
        for (note, bin) in [(57.0, 2 * 21), (69.0, 2 * 33), (45.0, 2 * 9)] {
            let mut s = vec![0.0f32; sr as usize * 2];
            let len = s.len();
            // Pure sine (no partials) so the peak is unambiguous.
            for (i, x) in s.iter_mut().enumerate().take(len) {
                *x = 0.3 * (std::f32::consts::TAU * midi_hz(note, 440.0) * i as f32 / sr as f32).sin();
            }
            let spec = log_spectrogram(&s, sr);
            assert!((spec.len() as f64 - 2.0 * FRAMES_PER_SEC).abs() <= 1.0);
            let f = spec[spec.len() / 2];
            let peak = f.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
            assert_eq!(peak, bin, "note {note}");
        }
    }

    #[test]
    fn silence_is_zero() {
        let spec = log_spectrogram(&vec![0.0; 44_100], 44_100);
        assert!(spec.iter().flatten().all(|&v| v == 0.0));
    }
}
