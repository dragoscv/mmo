//! RBJ cookbook biquads (coefficients in f64, state in f32, transposed direct form II).

use core::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Default for Coefs {
    fn default() -> Self {
        Self::identity()
    }
}

fn w0(freq: f32, sr: f32) -> f64 {
    let f = (freq as f64).clamp(1.0, sr as f64 * 0.49);
    2.0 * PI * f / sr as f64
}

fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Coefs {
    Coefs {
        b0: (b0 / a0) as f32,
        b1: (b1 / a0) as f32,
        b2: (b2 / a0) as f32,
        a1: (a1 / a0) as f32,
        a2: (a2 / a0) as f32,
    }
}

impl Coefs {
    pub const fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }

    pub fn low_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q.max(0.05) as f64);
        norm(
            (1.0 - c) / 2.0,
            1.0 - c,
            (1.0 - c) / 2.0,
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    pub fn high_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q.max(0.05) as f64);
        norm(
            (1.0 + c) / 2.0,
            -(1.0 + c),
            (1.0 + c) / 2.0,
            1.0 + alpha,
            -2.0 * c,
            1.0 - alpha,
        )
    }

    pub fn band_pass(freq: f32, q: f32, sr: f32) -> Self {
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q.max(0.05) as f64);
        norm(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * c, 1.0 - alpha)
    }

    pub fn peaking(freq: f32, gain_db: f32, q: f32, sr: f32) -> Self {
        if gain_db.abs() < 1e-4 {
            return Self::identity();
        }
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q.max(0.05) as f64);
        norm(
            1.0 + alpha * a,
            -2.0 * c,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * c,
            1.0 - alpha / a,
        )
    }

    pub fn low_shelf(freq: f32, gain_db: f32, sr: f32) -> Self {
        if gain_db.abs() < 1e-4 {
            return Self::identity();
        }
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / 2.0 * 2f64.sqrt(); // shelf slope S = 1
        let k = 2.0 * a.sqrt() * alpha;
        norm(
            a * ((a + 1.0) - (a - 1.0) * c + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - k),
            (a + 1.0) + (a - 1.0) * c + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - k,
        )
    }

    pub fn high_shelf(freq: f32, gain_db: f32, sr: f32) -> Self {
        if gain_db.abs() < 1e-4 {
            return Self::identity();
        }
        let a = 10f64.powf(gain_db as f64 / 40.0);
        let w = w0(freq, sr);
        let (s, c) = w.sin_cos();
        let alpha = s / 2.0 * 2f64.sqrt();
        let k = 2.0 * a.sqrt() * alpha;
        norm(
            a * ((a + 1.0) + (a - 1.0) * c + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - k),
            (a + 1.0) - (a - 1.0) * c + k,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - k,
        )
    }

    /// Magnitude response (linear) at `freq` — used by UI curves and tests.
    pub fn magnitude(&self, freq: f32, sr: f32) -> f32 {
        let w = w0(freq, sr);
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let (b0, b1, b2) = (self.b0 as f64, self.b1 as f64, self.b2 as f64);
        let (a1, a2) = (self.a1 as f64, self.a2 as f64);
        let nr = b0 + b1 * c1 + b2 * c2;
        let ni = -(b1 * s1 + b2 * s2);
        let dr = 1.0 + a1 * c1 + a2 * c2;
        let di = -(a1 * s1 + a2 * s2);
        (((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt()) as f32
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Biquad {
    c: Coefs,
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn new(c: Coefs) -> Self {
        Self {
            c,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn set(&mut self, c: Coefs) {
        self.c = c;
    }

    #[inline]
    pub fn coefs(&self) -> Coefs {
        self.c
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let c = &self.c;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        if !self.z1.is_finite() || !self.z2.is_finite() {
            self.z1 = 0.0;
            self.z2 = 0.0;
            return 0.0;
        }
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaking_gain_at_centre() {
        let c = Coefs::peaking(1000.0, 6.0, 1.0, 48000.0);
        let db = 20.0 * c.magnitude(1000.0, 48000.0).log10();
        assert!((db - 6.0).abs() < 0.05, "{db}");
    }

    #[test]
    fn shelves_reach_gain() {
        let lo = Coefs::low_shelf(200.0, -9.0, 48000.0);
        assert!((20.0 * lo.magnitude(20.0, 48000.0).log10() + 9.0).abs() < 0.3);
        let hi = Coefs::high_shelf(8000.0, 4.0, 48000.0);
        assert!((20.0 * hi.magnitude(20000.0, 48000.0).log10() - 4.0).abs() < 0.3);
    }

    #[test]
    fn high_pass_attenuates_lows() {
        let c = Coefs::high_pass(100.0, 0.707, 48000.0);
        assert!(c.magnitude(25.0, 48000.0) < 0.1);
        assert!((c.magnitude(2000.0, 48000.0) - 1.0).abs() < 0.01);
    }
}
