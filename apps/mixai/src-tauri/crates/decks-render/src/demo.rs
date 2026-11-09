//! Synthetic track peaks for previews, tests and the window example (no audio decoding).

use crate::model::{BandPeaks, PeaksView};

/// Owned three-band peaks of a generated "track": kick on every beat (low), a hi-hat on the
/// off-beats (high), a slow mid swell, a breakdown in bar 9–12.
#[derive(Clone, Debug)]
pub struct SyntheticTrack {
    /// Points per second.
    pub points_per_second: f32,
    /// Tempo used to place the hits.
    pub bpm: f64,
    /// Duration in seconds.
    pub duration_s: f64,
    bands: [[Vec<u8>; 3]; 3],
}

fn encode_peak(v: f32) -> u8 {
    ((v.clamp(-1.0, 1.0) + 1.0) * 127.5).round() as u8
}

fn encode_rms(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

impl SyntheticTrack {
    /// Generates `duration_s` seconds at `bpm` and `points_per_second`.
    pub fn new(duration_s: f64, bpm: f64, points_per_second: f32) -> Self {
        let n = (duration_s * f64::from(points_per_second)).ceil() as usize;
        let mut bands: [[Vec<u8>; 3]; 3] = Default::default();
        for band in &mut bands {
            for arr in band.iter_mut() {
                arr.reserve(n);
            }
        }
        let beat = 60.0 / bpm;
        for i in 0..n {
            let t = i as f64 / f64::from(points_per_second);
            let ph = (t / beat).fract();
            let bar = (t / (beat * 4.0)) as i64;
            let breakdown = (8..12).contains(&bar);
            let kick = if breakdown {
                0.0
            } else {
                (-ph * 9.0).exp() as f32
            };
            let off = ((ph - 0.5).abs() * 2.0) as f32;
            let hat = (1.0 - off).powf(10.0) * 0.7;
            let swell = (0.35 + 0.25 * (t * 0.4).sin()) as f32;
            let mid = if breakdown { swell * 1.4 } else { swell };
            let levels = [0.08 + 0.9 * kick, mid.min(0.95), 0.06 + hat];
            for (b, &peak) in levels.iter().enumerate() {
                // Slight asymmetry so min/max differ like real audio.
                let asym = 0.9 + 0.1 * ((t * 7.3 + b as f64).sin() as f32);
                bands[b][0].push(encode_peak(-peak * asym));
                bands[b][1].push(encode_peak(peak));
                bands[b][2].push(encode_rms(peak * 0.62));
            }
        }
        Self {
            points_per_second,
            bpm,
            duration_s,
            bands,
        }
    }

    /// Borrowed view for [`crate::Renderer::set_peaks`].
    pub fn view(&self) -> PeaksView<'_> {
        let band = |b: usize| BandPeaks {
            min: &self.bands[b][0],
            max: &self.bands[b][1],
            rms: &self.bands[b][2],
        };
        PeaksView {
            points_per_second: self.points_per_second,
            low: band(0),
            mid: band(1),
            high: band(2),
        }
    }
}
