//! In-key riser: white noise through a rising band-pass plus a saw on the incoming track's root
//! and fifth with an upward pitch sweep, `bars` long at the given tempo. Deterministic (seeded),
//! mono f32, ready to load on a sampler pad or a spare deck. The heavy generative path (AI loops)
//! stays on the server (`packages/audio-gen`); this is the instant, offline one.

use crate::BEATS_PER_BAR;
use crate::camelot::{Camelot, root_pitch_class};

#[derive(Debug, Clone, PartialEq)]
pub struct RiserSpec {
    /// Camelot key of the track the riser leads into.
    pub key: String,
    pub bpm: f64,
    pub bars: u32,
    pub sample_rate: u32,
    /// Peak level 0..1 (default 0.5 ≈ −6 dBFS).
    pub level: f32,
    pub seed: u64,
}

/// Root frequency (Hz) of `key` in octave 3 (C3 = 130.81 Hz).
pub fn riser_root_hz(key: &str) -> Option<f32> {
    let pc = root_pitch_class(Camelot::parse(key)?);
    Some(130.812_78 * 2f32.powf(f32::from(pc) / 12.0))
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f32 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let v = self.0.wrapping_mul(0x2545_F491_4F6C_DD1D);
        ((v >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// Render the riser. `None` for an unknown key or a non-positive tempo / rate.
pub fn render_riser(spec: &RiserSpec) -> Option<Vec<f32>> {
    let root = riser_root_hz(&spec.key)?;
    if spec.bpm <= 0.0 || spec.sample_rate == 0 || spec.bars == 0 {
        return None;
    }
    let sr = spec.sample_rate as f32;
    let secs = f64::from(spec.bars) * BEATS_PER_BAR * 60.0 / spec.bpm;
    let n = (secs * f64::from(spec.sample_rate)).round() as usize;
    let level = spec.level.clamp(0.0, 1.0);
    let mut rng = Rng(spec.seed.max(1));
    let mut out = Vec::with_capacity(n);
    let (mut p1, mut p2) = (0.0f32, 0.0f32);
    // State-variable band-pass for the noise.
    let (mut low, mut band) = (0.0f32, 0.0f32);
    for i in 0..n {
        let t = i as f32 / n.max(1) as f32;
        // Pitch sweeps up one octave; noise filter sweeps 300 Hz → 8 kHz.
        let f1 = root * 2f32.powf(t);
        let f2 = f1 * 1.5;
        p1 = (p1 + f1 / sr).fract();
        p2 = (p2 + f2 / sr).fract();
        let saw = (2.0 * p1 - 1.0) * 0.6 + (2.0 * p2 - 1.0) * 0.4;
        let fc = 300.0 * (8000.0f32 / 300.0).powf(t);
        let g = (std::f32::consts::PI * fc / sr).tan().min(0.99);
        let q = 1.0 / 2.5;
        let x = rng.next();
        let high = x - low - q * band;
        band += g * high;
        low += g * band;
        let env = t * t; // exponential-ish swell
        let tail = if t > 0.97 { (1.0 - t) / 0.03 } else { 1.0 }; // 3 % fade, no click
        let s = (0.55 * saw + 0.8 * band) * env * tail;
        out.push(s);
    }
    let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > 0.0 {
        let k = level / peak;
        for v in &mut out {
            *v *= k;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> RiserSpec {
        RiserSpec {
            key: "8A".into(),
            bpm: 120.0,
            bars: 4,
            sample_rate: 48_000,
            level: 0.5,
            seed: 7,
        }
    }

    #[test]
    fn root_frequencies() {
        assert!((riser_root_hz("8B").unwrap() - 130.81).abs() < 0.01, "C3");
        assert!((riser_root_hz("8A").unwrap() - 220.0).abs() < 0.01, "A3");
        assert_eq!(riser_root_hz("x"), None);
    }

    #[test]
    fn length_level_swell_and_determinism() {
        let a = render_riser(&spec()).unwrap();
        // 4 bars at 120 BPM = 8 s.
        assert_eq!(a.len(), 8 * 48_000);
        let peak = a.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 1e-4);
        let rms = |s: &[f32]| (s.iter().map(|v| v * v).sum::<f32>() / s.len() as f32).sqrt();
        let q = a.len() / 4;
        assert!(rms(&a[3 * q..]) > 4.0 * rms(&a[..q]), "it rises");
        assert!(a.last().unwrap().abs() < 1e-3, "faded end, no click");
        assert!(a.iter().all(|v| v.is_finite()));
        assert_eq!(a, render_riser(&spec()).unwrap(), "seeded = repeatable");
        let mut other = spec();
        other.seed = 8;
        assert_ne!(a, render_riser(&other).unwrap());
    }

    #[test]
    fn invalid_specs() {
        let mut s = spec();
        s.bpm = 0.0;
        assert!(render_riser(&s).is_none());
        let mut s = spec();
        s.key = "nope".into();
        assert!(render_riser(&s).is_none());
    }
}
