//! Synthetic signal helpers shared by the integration tests.
#![allow(dead_code)]

use std::sync::{Arc, OnceLock};

use decks_dvs::{DEFAULT_LEVEL, MIXAI_ZERO_LEVEL, MixAiCode, PositionCode, TimecodeGenerator};

pub const SR: u32 = 48_000;
pub const BLOCK: usize = 256;

/// One shared code (the table is 4 MiB; build it once per test binary).
pub fn code() -> Arc<MixAiCode> {
    static CODE: OnceLock<Arc<MixAiCode>> = OnceLock::new();
    CODE.get_or_init(|| Arc::new(MixAiCode::new())).clone()
}

pub fn generator() -> TimecodeGenerator {
    TimecodeGenerator::new(code(), SR, DEFAULT_LEVEL)
}

/// Deterministic xorshift64* + Box-Muller Gaussian noise.
pub struct Noise {
    s: u64,
    spare: Option<f64>,
}

impl Noise {
    pub fn new(seed: u64) -> Self {
        Self {
            s: seed.max(1),
            spare: None,
        }
    }

    fn uniform(&mut self) -> f64 {
        self.s ^= self.s >> 12;
        self.s ^= self.s << 25;
        self.s ^= self.s >> 27;
        let v = self.s.wrapping_mul(0x2545_F491_4F6C_DD1D);
        ((v >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }

    pub fn gauss(&mut self) -> f64 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let (u1, u2) = (self.uniform(), self.uniform());
        let r = (-2.0 * u1.ln()).sqrt();
        let (s, c) = (std::f64::consts::TAU * u2).sin_cos();
        self.spare = Some(r * s);
        r * c
    }
}

/// Noise σ per channel for a given SNR (dB) relative to the mean MixAI per-channel power.
pub fn sigma_for_snr(snr_db: f64) -> f64 {
    let z = MIXAI_ZERO_LEVEL as f64;
    let level = DEFAULT_LEVEL as f64;
    let p = level * level * (1.0 + z * z) / 2.0 / 2.0;
    (p / 10f64.powf(snr_db / 10.0)).sqrt()
}

/// A rendered test signal: interleaved stereo and the true position (cycles) of every frame.
pub struct Signal {
    pub data: Vec<f32>,
    pub phi: Vec<f64>,
}

impl Signal {
    pub fn new() -> Self {
        Self {
            data: Vec::new(),
            phi: Vec::new(),
        }
    }

    /// Append `frames` frames starting at `phi0`; `speed(i)` gives the speed at frame `i`.
    /// Returns the position after the last frame.
    pub fn play(
        &mut self,
        g: &TimecodeGenerator,
        phi0: f64,
        frames: usize,
        speed: impl Fn(usize) -> f64,
        sigma: f64,
        noise: &mut Noise,
    ) -> f64 {
        let step = PositionCode::carrier_hz(g.code().as_ref()) / SR as f64;
        let mut phi = phi0;
        for i in 0..frames {
            let (l, r) = g.sample_at(phi);
            self.data.push(l + (sigma * noise.gauss()) as f32);
            self.data.push(r + (sigma * noise.gauss()) as f32);
            self.phi.push(phi);
            phi += speed(i) * step;
        }
        phi
    }

    /// Append `frames` frames of noise only (needle lifted).
    pub fn silence(&mut self, frames: usize, sigma: f64, noise: &mut Noise) {
        for _ in 0..frames {
            self.data.push((sigma * noise.gauss()) as f32);
            self.data.push((sigma * noise.gauss()) as f32);
            self.phi.push(f64::NAN);
        }
    }

    pub fn frames(&self) -> usize {
        self.phi.len()
    }
}

pub fn ms_to_frames(ms: f64) -> usize {
    (ms * 1e-3 * SR as f64).round() as usize
}
