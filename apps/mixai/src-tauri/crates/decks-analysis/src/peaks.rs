//! Multi-band waveform overview for GPU rendering.
//!
//! The mono mix is split with 4th-order (two cascaded 2nd-order Butterworth) filters into
//! low (< 250 Hz), mid (250 Hz..4 kHz) and high (> 4 kHz). For every point (default 150 per
//! second) each band stores min, max and RMS as `u8`:
//! * `min` / `max`: `round((x + 1) * 127.5)` clamped, so 0 = −1.0, 128 ≈ 0.0, 255 = +1.0;
//! * `rms`: `round(rms * 255)` clamped (linear amplitude, 255 = full scale).
//!
//! Point `i` covers source frames `[floor(i·sr/pps), floor((i+1)·sr/pps))`, so the array length is
//! `ceil(frames · pps / sr)` and points never drift against the audio clock.

use serde::{Deserialize, Serialize};

use crate::util::{Biquad, cascade2};

const BUTTERWORTH_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;
/// Crossover between the low and mid bands.
pub const LOW_CROSSOVER_HZ: f64 = 250.0;
/// Crossover between the mid and high bands.
pub const HIGH_CROSSOVER_HZ: f64 = 4000.0;

/// min / max / RMS lanes of one band.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BandPeaks {
    pub min: Vec<u8>,
    pub max: Vec<u8>,
    pub rms: Vec<u8>,
}

impl BandPeaks {
    fn with_capacity(n: usize) -> Self {
        Self {
            min: Vec::with_capacity(n),
            max: Vec::with_capacity(n),
            rms: Vec::with_capacity(n),
        }
    }
}

/// Waveform overview.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WaveformPeaks {
    pub points_per_second: u32,
    /// Number of points in every lane.
    pub len: usize,
    pub low: BandPeaks,
    pub mid: BandPeaks,
    pub high: BandPeaks,
}

#[derive(Clone, Copy)]
struct Acc {
    min: f32,
    max: f32,
    sq: f64,
}

impl Acc {
    const EMPTY: Acc = Acc {
        min: f32::INFINITY,
        max: f32::NEG_INFINITY,
        sq: 0.0,
    };

    #[inline]
    fn add(&mut self, x: f32) {
        self.min = self.min.min(x);
        self.max = self.max.max(x);
        self.sq += (x as f64) * (x as f64);
    }

    fn flush(&mut self, n: u64, out: &mut BandPeaks) {
        let q = |x: f32| ((x + 1.0) * 127.5).round().clamp(0.0, 255.0) as u8;
        let (lo, hi) = if n == 0 {
            (0.0, 0.0)
        } else {
            (self.min, self.max)
        };
        out.min.push(q(lo));
        out.max.push(q(hi));
        let rms = if n == 0 {
            0.0
        } else {
            (self.sq / n as f64).sqrt()
        };
        out.rms.push((rms * 255.0).round().clamp(0.0, 255.0) as u8);
        *self = Acc::EMPTY;
    }
}

/// Number of points for `frames` source frames.
pub fn peaks_len(frames: usize, sample_rate: u32, points_per_second: u32) -> usize {
    if sample_rate == 0 || points_per_second == 0 {
        return 0;
    }
    (frames as u64 * points_per_second as u64).div_ceil(sample_rate as u64) as usize
}

/// Build the overview from a mono signal.
pub(crate) fn compute(mono: &[f32], sample_rate: u32, points_per_second: u32) -> WaveformPeaks {
    let len = peaks_len(mono.len(), sample_rate, points_per_second);
    let sr = sample_rate as f64;
    let hi_cut = HIGH_CROSSOVER_HZ.min(0.45 * sr);
    let mut low_f = [Biquad::lowpass(sr, LOW_CROSSOVER_HZ, BUTTERWORTH_Q); 2];
    let mut mid_hp = [Biquad::highpass(sr, LOW_CROSSOVER_HZ, BUTTERWORTH_Q); 2];
    let mut mid_lp = [Biquad::lowpass(sr, hi_cut, BUTTERWORTH_Q); 2];
    let mut high_f = [Biquad::highpass(sr, hi_cut, BUTTERWORTH_Q); 2];
    let mut out = WaveformPeaks {
        points_per_second,
        len,
        low: BandPeaks::with_capacity(len),
        mid: BandPeaks::with_capacity(len),
        high: BandPeaks::with_capacity(len),
    };
    let mut acc = [Acc::EMPTY; 3];
    let mut point = 0u64;
    let boundary = |p: u64| (p * sample_rate as u64) / points_per_second.max(1) as u64;
    let mut next = boundary(1);
    let mut start = 0u64;
    for (i, &x) in mono.iter().enumerate() {
        let x = x as f64;
        let l = cascade2(&mut low_f, x);
        let m = cascade2(&mut mid_lp, cascade2(&mut mid_hp, x));
        let h = cascade2(&mut high_f, x);
        acc[0].add(l as f32);
        acc[1].add(m as f32);
        acc[2].add(h as f32);
        if i as u64 + 1 == next {
            let n = next - start;
            acc[0].flush(n, &mut out.low);
            acc[1].flush(n, &mut out.mid);
            acc[2].flush(n, &mut out.high);
            point += 1;
            start = next;
            next = boundary(point + 1);
        }
    }
    if (out.low.min.len()) < len {
        let n = mono.len() as u64 - start;
        acc[0].flush(n, &mut out.low);
        acc[1].flush(n, &mut out.mid);
        acc[2].flush(n, &mut out.high);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: u32, secs: f64, hz: f64, amp: f32) -> Vec<f32> {
        (0..(sr as f64 * secs) as usize)
            .map(|i| amp * (std::f64::consts::TAU * hz * i as f64 / sr as f64).sin() as f32)
            .collect()
    }

    #[test]
    fn length_follows_points_per_second() {
        assert_eq!(peaks_len(44_100 * 3, 44_100, 150), 450);
        assert_eq!(peaks_len(44_101, 44_100, 150), 151);
        let p = compute(&vec![0.0; 44_100 * 2 + 10], 44_100, 150);
        assert_eq!(p.len, 301);
        for lane in [&p.low, &p.mid, &p.high] {
            assert_eq!(lane.min.len(), 301);
            assert_eq!(lane.max.len(), 301);
            assert_eq!(lane.rms.len(), 301);
        }
        let p = compute(&vec![0.0; 48_000], 48_000, 60);
        assert_eq!((p.len, p.low.rms.len()), (60, 60));
    }

    #[test]
    fn bands_separate_bass_and_treble() {
        let sr = 44_100;
        // 20 points/s: each point spans > 1 cycle of the 60 Hz tone, so min/max reach the crest.
        let mut x = sine(sr, 1.0, 60.0, 0.5);
        let p = compute(&x, sr, 20);
        let mid = p.len / 2;
        assert!(p.low.rms[mid] > 80, "{}", p.low.rms[mid]);
        assert!(p.high.rms[mid] < 3);
        // ±0.5 full scale → 191 / 64 in the u8 encoding.
        assert!(p.low.max[mid] > 185 && p.low.min[mid] < 70);
        x = sine(sr, 1.0, 9000.0, 0.5);
        let p = compute(&x, sr, 20);
        assert!(p.high.rms[mid] > 80);
        assert!(p.low.rms[mid] < 3);
        x = sine(sr, 1.0, 1000.0, 0.5);
        let p = compute(&x, sr, 20);
        assert!(p.mid.rms[mid] > 80);
        assert!(p.low.rms[mid] < 20 && p.high.rms[mid] < 20);
    }
}
