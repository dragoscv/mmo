//! Real-time-safe DSP primitives. No allocation, no locks — safe to call from
//! the cpal audio callback.

/// One-pole smoothing for parameter changes (anti-zipper). Ported concept from
/// the web mixer's `rampParam` helper, done per-sample here for glitch-free knobs.
#[derive(Clone, Copy)]
pub struct Smoothed {
    current: f32,
    target: f32,
    coeff: f32,
}

impl Smoothed {
    pub fn new(value: f32, sample_rate: f32, ms: f32) -> Self {
        // Time constant → one-pole coefficient.
        let tau = (ms / 1000.0).max(0.0001);
        let coeff = (-1.0 / (tau * sample_rate)).exp();
        Smoothed {
            current: value,
            target: value,
            coeff,
        }
    }

    #[inline]
    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        self.current = self.target + (self.current - self.target) * self.coeff;
        self.current
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.current
    }
}

/// Transposed Direct Form II biquad. Coefficients normalized by a0.
#[derive(Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn identity() -> Self {
        Biquad {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    fn set(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    /// Low-shelf (RBJ cookbook). `gain_db` in dB, `freq` in Hz.
    pub fn low_shelf(&mut self, freq: f32, gain_db: f32, sr: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / sr;
        let (sn, cs) = w0.sin_cos();
        let s = 1.0; // shelf slope
        let alpha = sn / 2.0 * ((a + 1.0 / a) * (1.0 / s - 1.0) + 2.0).sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        let b0 = a * ((a + 1.0) - (a - 1.0) * cs + two_sqrt_a_alpha);
        let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cs);
        let b2 = a * ((a + 1.0) - (a - 1.0) * cs - two_sqrt_a_alpha);
        let a0 = (a + 1.0) + (a - 1.0) * cs + two_sqrt_a_alpha;
        let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cs);
        let a2 = (a + 1.0) + (a - 1.0) * cs - two_sqrt_a_alpha;
        self.set(b0, b1, b2, a0, a1, a2);
    }

    /// High-shelf (RBJ cookbook).
    pub fn high_shelf(&mut self, freq: f32, gain_db: f32, sr: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / sr;
        let (sn, cs) = w0.sin_cos();
        let s = 1.0;
        let alpha = sn / 2.0 * ((a + 1.0 / a) * (1.0 / s - 1.0) + 2.0).sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        let b0 = a * ((a + 1.0) + (a - 1.0) * cs + two_sqrt_a_alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cs);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cs - two_sqrt_a_alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cs + two_sqrt_a_alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cs);
        let a2 = (a + 1.0) - (a - 1.0) * cs - two_sqrt_a_alpha;
        self.set(b0, b1, b2, a0, a1, a2);
    }

    /// Peaking EQ (RBJ cookbook). `q` controls bandwidth.
    pub fn peaking(&mut self, freq: f32, gain_db: f32, q: f32, sr: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq / sr;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / (2.0 * q);
        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cs;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cs;
        let a2 = 1.0 - alpha / a;
        self.set(b0, b1, b2, a0, a1, a2);
    }

    /// Resonant low-pass (RBJ cookbook).
    pub fn low_pass(&mut self, freq: f32, q: f32, sr: f32) {
        let w0 = 2.0 * std::f32::consts::PI * freq.clamp(20.0, sr / 2.0 - 100.0) / sr;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / (2.0 * q);
        let b1 = 1.0 - cs;
        let b0 = b1 / 2.0;
        let b2 = b0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cs;
        let a2 = 1.0 - alpha;
        self.set(b0, b1, b2, a0, a1, a2);
    }

    /// Resonant high-pass (RBJ cookbook).
    pub fn high_pass(&mut self, freq: f32, q: f32, sr: f32) {
        let w0 = 2.0 * std::f32::consts::PI * freq.clamp(20.0, sr / 2.0 - 100.0) / sr;
        let (sn, cs) = w0.sin_cos();
        let alpha = sn / (2.0 * q);
        let one_plus_cs = 1.0 + cs;
        let b0 = one_plus_cs / 2.0;
        let b1 = -one_plus_cs;
        let b2 = b0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cs;
        let a2 = 1.0 - alpha;
        self.set(b0, b1, b2, a0, a1, a2);
    }
}

/// Equal-power-ish crossfader gain for one side given position -1..+1.
/// `side_is_a` selects which deck this gain is for.
pub fn crossfader_gain(position: f32, side_is_a: bool, curve: u8) -> f32 {
    // Normalize position 0..1 from the perspective of this side.
    let p = ((position + 1.0) / 2.0).clamp(0.0, 1.0);
    let x = if side_is_a { 1.0 - p } else { p };
    match curve {
        // Smooth (equal power)
        1 => (x * std::f32::consts::FRAC_PI_2).sin(),
        // Sharp (dead-zone cut)
        2 => {
            if x <= 0.0 {
                0.0
            } else {
                (x * 4.0).min(1.0)
            }
        }
        // Linear
        _ => x,
    }
}

/// dB → linear amplitude.
#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Soft clip (tanh) limiter to protect the master from overs.
#[inline]
pub fn soft_clip(x: f32) -> f32 {
    x.tanh()
}
