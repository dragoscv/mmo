//! Vocal channel EQ: high-pass + low shelf + two peaks + high shelf + output gain.
//! Frequencies/gains are smoothed and coefficients recomputed at control rate (every 32 samples)
//! while a change is ramping, so sweeps are zipper-free.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit, db_to_lin};
use crate::processor::{Processor, defaults, store};

const SPECS: &[ParamSpec] = &[
    ParamSpec::log("hpf_freq", 20.0, 400.0, 80.0, Unit::Hz),
    ParamSpec::toggle("hpf_on", true),
    ParamSpec::log("low_freq", 40.0, 800.0, 200.0, Unit::Hz),
    ParamSpec::new("low_gain", -18.0, 18.0, 0.0, Unit::Db),
    ParamSpec::log("mid1_freq", 100.0, 4000.0, 400.0, Unit::Hz),
    ParamSpec::new("mid1_gain", -18.0, 18.0, 0.0, Unit::Db),
    ParamSpec::log("mid1_q", 0.2, 10.0, 1.0, Unit::None),
    ParamSpec::log("mid2_freq", 500.0, 12000.0, 3000.0, Unit::Hz),
    ParamSpec::new("mid2_gain", -18.0, 18.0, 0.0, Unit::Db),
    ParamSpec::log("mid2_q", 0.2, 10.0, 1.0, Unit::None),
    ParamSpec::log("high_freq", 2000.0, 18000.0, 10000.0, Unit::Hz),
    ParamSpec::new("high_gain", -18.0, 18.0, 0.0, Unit::Db),
    ParamSpec::new("output", -18.0, 18.0, 0.0, Unit::Db),
];

const N: usize = 13;
const BANDS: usize = 5;
const CONTROL: usize = 32;

pub struct Eq {
    sr: f32,
    v: [f32; N],
    s: [Smoothed; N],
    f: [[Biquad; BANDS]; 2],
    out: Smoothed,
}

impl Eq {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; N] = defaults(SPECS);
        let ramp = (sample_rate * 0.03) as u32;
        let s = core::array::from_fn(|i| Smoothed::new(v[i], ramp));
        let mut eq = Self {
            sr: sample_rate,
            v,
            s,
            f: [[Biquad::default(); BANDS]; 2],
            out: Smoothed::with_ms(1.0, 20.0, sample_rate),
        };
        eq.recompute();
        eq
    }

    fn recompute(&mut self) {
        let p = |i: usize| self.s[i].value();
        let sr = self.sr;
        let hpf = if p(1) > 0.5 {
            Coefs::high_pass(p(0), 0.707, sr)
        } else {
            Coefs::identity()
        };
        let c = [
            hpf,
            Coefs::low_shelf(p(2), p(3), sr),
            Coefs::peaking(p(4), p(5), p(6), sr),
            Coefs::peaking(p(7), p(8), p(9), sr),
            Coefs::high_shelf(p(10), p(11), sr),
        ];
        for ch in &mut self.f {
            for (b, c) in ch.iter_mut().zip(c) {
                b.set(c);
            }
        }
    }

    /// Combined magnitude response in dB at `freq` (for the UI curve).
    pub fn response_db(&self, freq: f32) -> f32 {
        let m: f32 = self.f[0]
            .iter()
            .map(|b| b.coefs().magnitude(freq, self.sr))
            .product();
        20.0 * m.max(1e-9).log10() + self.v[12]
    }
}

impl Processor for Eq {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 1 {
                self.s[i].reset(v); // toggles switch instantly
                self.recompute();
            } else if i == 12 {
                self.out.set(db_to_lin(v));
            } else {
                self.s[i].set(v);
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = l.len().min(r.len());
        let mut off = 0;
        while off < len {
            let n = CONTROL.min(len - off);
            if self.s.iter().any(Smoothed::is_smoothing) {
                for s in &mut self.s {
                    s.advance(n as u32);
                }
                self.recompute();
            }
            let [fl, fr] = &mut self.f;
            for i in off..off + n {
                let mut a = l[i];
                let mut b = r[i];
                for (x, y) in fl.iter_mut().zip(fr.iter_mut()) {
                    a = x.tick(a);
                    b = y.tick(b);
                }
                let g = self.out.next();
                l[i] = a * g;
                r[i] = b * g;
            }
            off += n;
        }
    }
    fn reset(&mut self) {
        for ch in &mut self.f {
            for b in ch {
                b.reset();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_by_default_except_hpf() {
        let eq = Eq::new(48000.0);
        assert!(eq.response_db(1000.0).abs() < 0.1);
        assert!(eq.response_db(30.0) < -10.0);
    }

    #[test]
    fn smoothed_gain_change_lands() {
        let mut eq = Eq::new(48000.0);
        eq.set_param(5, 9.0);
        let mut l = vec![0.0f32; 4800];
        let mut r = l.clone();
        eq.process(&mut l, &mut r);
        let db = eq.response_db(400.0);
        assert!((db - 9.0).abs() < 0.3, "{db}");
    }
}
