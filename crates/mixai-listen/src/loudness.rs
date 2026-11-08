//! EBU R128 loudness (momentary, short-term, integrated, true peak) via `ebur128`, plus a 1..10 energy score
//! with the same weights as the server analysis (`server/python/analyze.py`: 0.5 RMS + 0.3 flux + 0.2 onset
//! density). Mic levels are uncalibrated, so LUFS from the mic is relative ("how loud is it getting"), while
//! file mode gives true programme loudness.

use std::collections::VecDeque;

use ebur128::{EbuR128, Mode};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoudnessReading {
    /// 400 ms window, LUFS (−inf as `f64::NEG_INFINITY` when silent).
    pub momentary_lufs: f64,
    /// 3 s window.
    pub short_term_lufs: f64,
    /// Gated, since start/reset.
    pub integrated_lufs: f64,
    /// dBTP since start/reset.
    pub true_peak_dbtp: f64,
}

pub(crate) struct Loudness {
    meter: Option<EbuR128>,
}

impl Loudness {
    pub fn new(sample_rate: u32) -> Self {
        Self { meter: EbuR128::new(1, sample_rate, Mode::M | Mode::S | Mode::I | Mode::TRUE_PEAK).ok() }
    }

    pub fn push(&mut self, samples: &[f32]) {
        if let Some(m) = self.meter.as_mut() {
            let _ = m.add_frames_f32(samples);
        }
    }

    pub fn reading(&self) -> Option<LoudnessReading> {
        let m = self.meter.as_ref()?;
        let peak = m.true_peak(0).unwrap_or(0.0);
        Some(LoudnessReading {
            momentary_lufs: m.loudness_momentary().unwrap_or(f64::NEG_INFINITY),
            short_term_lufs: m.loudness_shortterm().unwrap_or(f64::NEG_INFINITY),
            integrated_lufs: m.loudness_global().unwrap_or(f64::NEG_INFINITY),
            true_peak_dbtp: if peak > 0.0 { 20.0 * peak.log10() } else { f64::NEG_INFINITY },
        })
    }

    pub fn reset(&mut self) {
        if let Some(m) = self.meter.as_mut() {
            m.reset();
        }
    }
}

/// Rolling 1..10 energy over the last ~6 s of onset frames.
pub(crate) struct Energy {
    frames: VecDeque<(f32, f32)>,
    cap: usize,
    rate: f64,
}

impl Energy {
    pub fn new(rate: f64) -> Self {
        let cap = (rate * 6.0) as usize;
        Self { frames: VecDeque::with_capacity(cap), cap, rate }
    }

    pub fn push(&mut self, rms: f32, flux: f32) {
        if self.frames.len() == self.cap {
            self.frames.pop_front();
        }
        self.frames.push_back((rms, flux));
    }

    pub fn score(&self) -> Option<f64> {
        if (self.frames.len() as f64) < self.rate * 2.0 {
            return None;
        }
        let n = self.frames.len() as f64;
        let rms = self.frames.iter().map(|f| f.0 as f64).sum::<f64>() / n;
        let flux_mean = self.frames.iter().map(|f| f.1 as f64).sum::<f64>() / n;
        // dBFS -50..-6 → 0..1.
        let rms_db = 20.0 * rms.max(1e-6).log10();
        let level = ((rms_db + 50.0) / 44.0).clamp(0.0, 1.0);
        let flux = (flux_mean / 25.0).clamp(0.0, 1.0);
        let threshold = flux_mean * 1.5;
        let onsets = self
            .frames
            .iter()
            .zip(self.frames.iter().skip(1))
            .filter(|(a, b)| b.1 as f64 > threshold && b.1 > a.1)
            .count();
        let density = (onsets as f64 / (n / self.rate) / 8.0).clamp(0.0, 1.0);
        Some((1.0 + 9.0 * (0.5 * level + 0.3 * flux + 0.2 * density)).clamp(1.0, 10.0))
    }

    pub fn reset(&mut self) {
        self.frames.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minus_20_dbfs_sine_reads_about_minus_23_lufs() {
        let sr = 48_000;
        let mut l = Loudness::new(sr);
        let amp = 10f32.powf(-20.0 / 20.0);
        let s: Vec<f32> = (0..sr * 4).map(|i| amp * (std::f32::consts::TAU * 1000.0 * i as f32 / sr as f32).sin()).collect();
        l.push(&s);
        let r = l.reading().unwrap();
        // 1 kHz sine at -20 dBFS peak: -23.0 LUFS mono (-3.01 dB RMS, K-weighting ≈ +0.7 dB at 1 kHz, -0.691).
        assert!((r.integrated_lufs - -23.0).abs() < 0.6, "{}", r.integrated_lufs);
        assert!((r.true_peak_dbtp - -20.0).abs() < 0.3, "{}", r.true_peak_dbtp);
    }

    #[test]
    fn loud_busy_audio_scores_more_energy_than_quiet_sparse_audio() {
        let mut quiet = Energy::new(100.0);
        let mut loud = Energy::new(100.0);
        for i in 0..400 {
            quiet.push(0.005, if i % 100 == 0 { 3.0 } else { 0.2 });
            loud.push(0.3, if i % 25 == 0 { 40.0 } else { 8.0 });
        }
        let (q, l) = (quiet.score().unwrap(), loud.score().unwrap());
        assert!(q < 3.0 && l > 6.0 && l - q > 4.0, "quiet {q} loud {l}");
    }
}
