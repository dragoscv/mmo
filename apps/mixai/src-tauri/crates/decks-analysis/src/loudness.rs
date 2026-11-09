//! EBU R128 / ITU-R BS.1770-4 loudness and true peak.
//!
//! * K-weighting: the two BS.1770 biquads (high-shelf + RLB high-pass), re-derived for any sample
//!   rate from their analogue prototypes (f0, Q, gain published with the 48 kHz coefficients).
//! * Gating blocks of 400 ms with 75 % overlap (100 ms sub-blocks); absolute gate −70 LUFS,
//!   relative gate −10 LU. Gated blocks are kept in a 0.01 LU histogram (count + exact energy per
//!   bin), so the meter never allocates while streaming and integrates arbitrarily long input.
//! * True peak: 4× oversampling with a 48-tap Kaiser-windowed sinc interpolator (12 taps per
//!   phase, the structure of BS.1770-4 Annex 2), max |sample| over all phases.
//!
//! Reference check (tests): a 1 kHz sine at −20 dBFS in ONE channel reads −23.0 LUFS (K-weighting
//! gain at 1 kHz is +0.69 dB, offset −0.691 dB, single channel = −3.01 dB vs. both channels); the
//! EBU Tech 3341 case, the same sine at −23 dBFS in both channels of a stereo file, reads −23.0.

use std::f64::consts::PI;

use serde::{Deserialize, Serialize};

use crate::util::{Biquad, cascade2};

const ABS_GATE: f64 = -70.0;
const HIST_MIN: f64 = -70.0;
const HIST_MAX: f64 = 10.0;
const HIST_STEP: f64 = 0.01;
const HIST_BINS: usize = ((HIST_MAX - HIST_MIN) / HIST_STEP) as usize;
const TP_PHASES: usize = 4;
const TP_TAPS: usize = 12;
/// Loudness targets used for the suggested gains.
pub const STREAMING_TARGET_LUFS: f64 = -14.0;
pub const CLUB_TARGET_LUFS: f64 = -9.0;

/// Loudness result.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Loudness {
    /// EBU R128 integrated loudness in LUFS (`-inf` for silence; serialised as null).
    #[serde(with = "finite_or_null")]
    pub integrated_lufs: f64,
    /// Maximum true peak over all channels in dBTP.
    #[serde(with = "finite_or_null")]
    pub true_peak_dbtp: f64,
    /// Maximum sample peak in dBFS.
    #[serde(with = "finite_or_null")]
    pub sample_peak_dbfs: f64,
    /// Gain in dB to reach −14 LUFS (streaming target).
    #[serde(with = "finite_or_null")]
    pub gain_to_minus14_db: f64,
    /// Gain in dB to reach −9 LUFS (club/DJ target).
    #[serde(with = "finite_or_null")]
    pub gain_to_minus9_db: f64,
}

/// Live loudness readings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LiveLoudness {
    #[serde(with = "finite_or_null")]
    pub momentary_lufs: f64,
    #[serde(with = "finite_or_null")]
    pub short_term_lufs: f64,
    #[serde(with = "finite_or_null")]
    pub integrated_lufs: f64,
    #[serde(with = "finite_or_null")]
    pub true_peak_dbtp: f64,
}

mod finite_or_null {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.is_finite() {
            s.serialize_f64(*v)
        } else {
            s.serialize_none()
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NEG_INFINITY))
    }
}

fn k_weighting(sr: f64) -> [Biquad; 2] {
    // Stage 1: high shelf (+4 dB above ~1.7 kHz).
    let (f0, g, q) = (
        1_681.974_450_955_533,
        3.999_843_853_973_347,
        0.707_175_236_955_42,
    );
    let k = (PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let shelf = Biquad::new(
        [
            vh + vb * k / q + k * k,
            2.0 * (k * k - vh),
            vh - vb * k / q + k * k,
        ],
        [
            1.0 + k / q + k * k,
            2.0 * (k * k - 1.0),
            1.0 - k / q + k * k,
        ],
    );
    // Stage 2: RLB high-pass (~38 Hz). Numerator stays [1, −2, 1] as in BS.1770.
    let (f0, q) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
    let k = (PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Biquad::new(
        [a0, -2.0 * a0, a0],
        [a0, 2.0 * (k * k - 1.0), 1.0 - k / q + k * k],
    );
    [shelf, hp]
}

fn channel_weight(ch: usize, channels: usize) -> f64 {
    if channels == 6 {
        // 5.1 in L R C LFE Ls Rs order.
        [1.0, 1.0, 1.0, 0.0, 1.41, 1.41][ch]
    } else {
        1.0
    }
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let y = x * x / 4.0;
    for k in 1..50 {
        term *= y / (k * k) as f64;
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

fn true_peak_taps() -> [[f32; TP_TAPS]; TP_PHASES] {
    let n = TP_PHASES * TP_TAPS;
    // Centre on an integer tap so the 4 phases evaluate offsets 0, 1/4, 1/2 and 3/4.
    let mid = (n / 2) as f64;
    let beta = 7.0;
    let mut taps = [[0.0f32; TP_TAPS]; TP_PHASES];
    for i in 0..n {
        let x = (i as f64 - mid) / TP_PHASES as f64;
        let sinc = if x.abs() < 1e-12 {
            1.0
        } else {
            (PI * x).sin() / (PI * x)
        };
        let r = (i as f64 - mid) / mid;
        let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / bessel_i0(beta);
        taps[i % TP_PHASES][i / TP_PHASES] = (sinc * w) as f32;
    }
    // Unit DC gain per phase, so a steady level never reads above its sample peak.
    for phase in &mut taps {
        let s: f32 = phase.iter().sum();
        phase.iter_mut().for_each(|t| *t /= s);
    }
    taps
}

/// Streaming BS.1770 meter. Allocates only in [`LoudnessMeter::new`].
pub(crate) struct LoudnessMeter {
    channels: usize,
    filters: Vec<[Biquad; 2]>,
    weights: Vec<f64>,
    sub_len: usize,
    sub_pos: usize,
    sub_acc: f64,
    subs: [f64; 30],
    sub_count: u64,
    hist_count: Vec<u64>,
    hist_energy: Vec<f64>,
    tp_taps: [[f32; TP_TAPS]; TP_PHASES],
    tp_hist: Vec<[f32; 2 * TP_TAPS]>,
    tp_pos: usize,
    true_peak: f32,
    sample_peak: f32,
}

impl LoudnessMeter {
    pub(crate) fn new(channels: usize, sr: u32) -> Self {
        let channels = channels.max(1);
        let srf = sr as f64;
        Self {
            channels,
            filters: (0..channels).map(|_| k_weighting(srf)).collect(),
            weights: (0..channels).map(|c| channel_weight(c, channels)).collect(),
            sub_len: ((srf / 10.0).round() as usize).max(1),
            sub_pos: 0,
            sub_acc: 0.0,
            subs: [0.0; 30],
            sub_count: 0,
            hist_count: vec![0; HIST_BINS],
            hist_energy: vec![0.0; HIST_BINS],
            tp_taps: true_peak_taps(),
            tp_hist: vec![[0.0; 2 * TP_TAPS]; channels],
            tp_pos: 0,
            true_peak: 0.0,
            sample_peak: 0.0,
        }
    }

    pub(crate) fn reset(&mut self) {
        for f in &mut self.filters {
            f[0].reset();
            f[1].reset();
        }
        self.sub_pos = 0;
        self.sub_acc = 0.0;
        self.subs = [0.0; 30];
        self.sub_count = 0;
        self.hist_count.fill(0);
        self.hist_energy.fill(0.0);
        self.tp_hist
            .iter_mut()
            .for_each(|h| *h = [0.0; 2 * TP_TAPS]);
        self.tp_pos = 0;
        self.true_peak = 0.0;
        self.sample_peak = 0.0;
    }

    /// Feed interleaved frames (`samples.len()` must be a multiple of the channel count).
    pub(crate) fn push(&mut self, samples: &[f32]) {
        for frame in samples.chunks_exact(self.channels) {
            self.push_frame(frame);
        }
    }

    /// Feed one interleaved frame (`frame.len()` == channel count).
    #[inline]
    pub(crate) fn push_frame(&mut self, frame: &[f32]) {
        let mut e = 0.0;
        for (c, &x) in frame.iter().enumerate().take(self.channels) {
            let y = cascade2(&mut self.filters[c], x as f64);
            e += self.weights[c] * y * y;
            self.sample_peak = self.sample_peak.max(x.abs());
            let h = &mut self.tp_hist[c];
            h[self.tp_pos] = x;
            h[self.tp_pos + TP_TAPS] = x;
        }
        self.tp_pos = (self.tp_pos + 1) % TP_TAPS;
        for h in &self.tp_hist {
            let win = &h[self.tp_pos..self.tp_pos + TP_TAPS];
            for phase in &self.tp_taps {
                let mut acc = 0.0f32;
                for (a, b) in win.iter().zip(phase) {
                    acc += a * b;
                }
                self.true_peak = self.true_peak.max(acc.abs());
            }
        }
        self.sub_acc += e;
        self.sub_pos += 1;
        if self.sub_pos == self.sub_len {
            self.finish_sub();
        }
    }

    fn finish_sub(&mut self) {
        let ms = self.sub_acc / self.sub_len as f64;
        self.sub_acc = 0.0;
        self.sub_pos = 0;
        self.subs.copy_within(1.., 0);
        self.subs[29] = ms;
        self.sub_count += 1;
        if self.sub_count >= 4 {
            let z = self.subs[26..].iter().sum::<f64>() / 4.0;
            let l = to_lufs(z);
            if l >= ABS_GATE {
                let bin = (((l - HIST_MIN) / HIST_STEP) as usize).min(HIST_BINS - 1);
                self.hist_count[bin] += 1;
                self.hist_energy[bin] += z;
            }
        }
    }

    /// Integrated loudness (gated) in LUFS; `-inf` until a block passes the absolute gate.
    pub(crate) fn integrated(&self) -> f64 {
        let (n, e) = self
            .hist_count
            .iter()
            .zip(&self.hist_energy)
            .fold((0u64, 0.0), |(n, e), (c, x)| (n + c, e + x));
        if n == 0 {
            return f64::NEG_INFINITY;
        }
        let rel = to_lufs(e / n as f64) - 10.0;
        let start = if rel <= HIST_MIN {
            0
        } else {
            (((rel - HIST_MIN) / HIST_STEP).ceil() as usize).min(HIST_BINS)
        };
        let (n, e) = self.hist_count[start..]
            .iter()
            .zip(&self.hist_energy[start..])
            .fold((0u64, 0.0), |(n, e), (c, x)| (n + c, e + x));
        if n == 0 {
            f64::NEG_INFINITY
        } else {
            to_lufs(e / n as f64)
        }
    }

    pub(crate) fn live(&self) -> LiveLoudness {
        let window = |k: usize| -> f64 {
            if self.sub_count < k as u64 {
                return f64::NEG_INFINITY;
            }
            to_lufs(self.subs[30 - k..].iter().sum::<f64>() / k as f64)
        };
        LiveLoudness {
            momentary_lufs: window(4),
            short_term_lufs: window(30),
            integrated_lufs: self.integrated(),
            true_peak_dbtp: to_db(self.true_peak.max(self.sample_peak) as f64),
        }
    }

    pub(crate) fn result(&self) -> Loudness {
        let integrated = self.integrated();
        Loudness {
            integrated_lufs: integrated,
            true_peak_dbtp: to_db(self.true_peak.max(self.sample_peak) as f64),
            sample_peak_dbfs: to_db(self.sample_peak as f64),
            gain_to_minus14_db: STREAMING_TARGET_LUFS - integrated,
            gain_to_minus9_db: CLUB_TARGET_LUFS - integrated,
        }
    }
}

fn to_lufs(z: f64) -> f64 {
    if z <= 0.0 {
        f64::NEG_INFINITY
    } else {
        -0.691 + 10.0 * z.log10()
    }
}

fn to_db(a: f64) -> f64 {
    if a <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * a.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(sr: u32, secs: f64, hz: f64, amp: f64, channels: usize, phase: f64) -> Vec<f32> {
        let n = (sr as f64 * secs) as usize;
        let mut v = Vec::with_capacity(n * channels);
        for i in 0..n {
            let x = (amp * (2.0 * PI * hz * i as f64 / sr as f64 + phase).sin()) as f32;
            for _ in 0..channels {
                v.push(x);
            }
        }
        v
    }

    fn integrated(samples: &[f32], channels: usize, sr: u32) -> Loudness {
        let mut m = LoudnessMeter::new(channels, sr);
        m.push(samples);
        m.result()
    }

    #[test]
    fn k_weighting_matches_the_bs1770_48k_coefficients() {
        let [s, h] = k_weighting(48_000.0);
        assert!((s.b0_for_test() - 1.535_124_859_586_97).abs() < 1e-6);
        assert!((s.a1_for_test() + 1.690_659_293_182_41).abs() < 1e-6);
        assert!((h.a1_for_test() + 1.990_047_454_833_98).abs() < 1e-6);
        assert!((h.a2_for_test() - 0.990_072_250_366_21).abs() < 1e-6);
    }

    #[test]
    fn minus_20_dbfs_1k_sine_mono_reads_minus_23_lufs() {
        // Expected per BS.1770: −0.691 + 10·log10(0.1²/2) + 0.691 (K gain at 1 kHz) = −23.01.
        for sr in [44_100, 48_000] {
            let l = integrated(&sine(sr, 10.0, 1000.0, 0.1, 1, 0.0), 1, sr);
            assert!((l.integrated_lufs + 23.01).abs() < 0.1, "{sr}: {l:?}");
            assert!((l.gain_to_minus14_db - 9.01).abs() < 0.1);
        }
    }

    #[test]
    fn ebu_3341_stereo_minus_23_dbfs_reads_minus_23_lufs() {
        let amp = 10f64.powf(-23.0 / 20.0);
        let l = integrated(&sine(48_000, 20.0, 1000.0, amp, 2, 0.0), 2, 48_000);
        assert!((l.integrated_lufs + 23.0).abs() < 0.1, "{l:?}");
    }

    #[test]
    fn relative_gate_ignores_quiet_passages() {
        let mut v = sine(48_000, 10.0, 1000.0, 0.1, 1, 0.0);
        v.extend(sine(48_000, 10.0, 1000.0, 0.001, 1, 0.0)); // −60 dBFS: below the relative gate
        let l = integrated(&v, 1, 48_000);
        assert!((l.integrated_lufs + 23.01).abs() < 0.15, "{l:?}");
    }

    #[test]
    fn true_peak_sees_inter_sample_overs() {
        // fs/4 sine with 45° phase: every sample sits at 0.707·A, the waveform peaks at A.
        let l = integrated(&sine(48_000, 1.0, 12_000.0, 0.5, 1, PI / 4.0), 1, 48_000);
        assert!((l.sample_peak_dbfs - to_db(0.5 * 0.5f64.sqrt())).abs() < 0.05);
        assert!((l.true_peak_dbtp - to_db(0.5)).abs() < 0.3, "{l:?}");
    }

    #[test]
    fn silence_is_minus_infinity_and_serialises_as_null() {
        let l = integrated(&vec![0.0; 48_000], 1, 48_000);
        assert_eq!(l.integrated_lufs, f64::NEG_INFINITY);
        let json = serde_json::to_string(&l).unwrap();
        assert!(json.contains("\"integrated_lufs\":null"), "{json}");
        let back: Loudness = serde_json::from_str(&json).unwrap();
        assert_eq!(back.integrated_lufs, f64::NEG_INFINITY);
    }
}
