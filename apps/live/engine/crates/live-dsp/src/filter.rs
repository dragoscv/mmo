//! Tone filter: a high-pass and a low-pass, each switchable, 12 or 24 dB/octave.
//!
//! The plain pair of shelves every voice needs before anything else — a rumble cut on the way in, a
//! hiss cut on the way out — and the shaping half of the character presets (a 300–3400 Hz band is a
//! telephone, see [`crate::character`]). Coefficients are recomputed at control rate while a change
//! is ramping, so sweeps are zipper-free; the dry/wet blend follows a smoothed parameter.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit};
use crate::processor::{Processor, defaults, store};

const SPECS: &[ParamSpec] = &[
    ParamSpec::toggle("hpf_on", true),
    ParamSpec::log("hpf_freq", 20.0, 500.0, 80.0, Unit::Hz),
    ParamSpec::toggle("lpf_on", false),
    ParamSpec::log("lpf_freq", 1000.0, 20000.0, 12000.0, Unit::Hz),
    // `12` = one biquad (0.707 Butterworth), `24` = two cascaded (Butterworth pair).
    ParamSpec::choice("slope", &["12", "24"], 0),
    ParamSpec::log("q", 0.5, 4.0, 0.707, Unit::None),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
];

const N: usize = 7;
/// Butterworth Q of a 4th-order cascade, split into two 2nd-order sections.
const BUTTER_Q: [f32; 2] = [0.5412, 1.3066];
const CONTROL: usize = 32;

pub struct Filter {
    sr: f32,
    v: [f32; N],
    s: [Smoothed; N],
    /// Per channel: [high-pass section 1, high-pass 2, low-pass 1, low-pass 2].
    f: [[Biquad; 4]; 2],
    mix: Smoothed,
}

impl Filter {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; N] = defaults(SPECS);
        let ramp = (sample_rate * 0.03) as u32;
        let s = core::array::from_fn(|i| Smoothed::new(v[i], ramp));
        let mut f = Self {
            sr: sample_rate,
            v,
            s,
            f: [[Biquad::default(); 4]; 2],
            mix: Smoothed::new(v[6], ramp),
        };
        f.recompute();
        f
    }

    fn recompute(&mut self) {
        let sr = self.sr;
        let fourth = self.s[4].value() > 0.5;
        let q = self.s[5].value();
        let hz = |i: usize| self.s[i].value();
        // The high-pass is a Butterworth pair when 24 dB/octave, one section at the chosen Q else.
        let hp_q: [f32; 2] = if fourth { BUTTER_Q } else { [q, 0.0] };
        let lp_q: [f32; 2] = if fourth { BUTTER_Q } else { [q, 0.0] };
        let hp = if self.s[0].value() > 0.5 {
            [
                Coefs::high_pass(hz(1), hp_q[0], sr),
                if fourth {
                    Coefs::high_pass(hz(1), hp_q[1], sr)
                } else {
                    Coefs::identity()
                },
            ]
        } else {
            [Coefs::identity(), Coefs::identity()]
        };
        let lp = if self.s[2].value() > 0.5 {
            [
                Coefs::low_pass(hz(3), lp_q[0], sr),
                if fourth {
                    Coefs::low_pass(hz(3), lp_q[1], sr)
                } else {
                    Coefs::identity()
                },
            ]
        } else {
            [Coefs::identity(), Coefs::identity()]
        };
        let all = [hp[0], hp[1], lp[0], lp[1]];
        for ch in &mut self.f {
            for (b, c) in ch.iter_mut().zip(all) {
                b.set(c);
            }
        }
    }

    /// Magnitude response in dB at `freq`, for tests and UI curves.
    pub fn response_db(&self, freq: f32) -> f32 {
        let m: f32 = self.f[0]
            .iter()
            .map(|b| b.coefs().magnitude(freq, self.sr))
            .product();
        20.0 * m.max(1e-9).log10()
    }
}

impl Processor for Filter {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 6 {
                self.mix.set(v);
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
                let (a, b) = (l[i], r[i]);
                let mut x = a;
                let mut y = b;
                for (bl, br) in fl.iter_mut().zip(fr.iter_mut()) {
                    x = bl.tick(x);
                    y = br.tick(y);
                }
                let m = self.mix.next();
                l[i] = a + m * (x - a);
                r[i] = b + m * (y - b);
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
    use crate::test_util::{rms, sine};

    fn at(f: &mut Filter, sr: f32, freq: f32, n: usize, amp: f32) -> f32 {
        let mut l = sine(freq, sr, n, amp);
        let mut r = l.clone();
        // Let the smoother settle, then measure the steady state.
        let head = n / 4;
        f.process(&mut l[..head], &mut r[..head]);
        f.process(&mut l[head..], &mut r[head..]);
        rms(&l[head..])
    }

    /// Coefficients are recomputed only while a parameter is ramping (30 ms), so a curve read
    /// straight after `set_param` still shows the previous settings. Run silence to settle it.
    fn settle(f: &mut Filter) {
        for _ in 0..40 {
            let (mut l, mut r) = (vec![0.0f32; 480], vec![0.0f32; 480]);
            f.process(&mut l, &mut r);
        }
    }

    /// Defaults are the useful pair: a rumble cut in, no hiss cut.
    #[test]
    fn defaults_cut_the_bottom_and_leave_the_top_alone() {
        let f = Filter::new(48000.0);
        assert!(f.response_db(30.0) < -12.0, "-12 dB or more at 30 Hz");
        assert!(f.response_db(1000.0).abs() < 0.5, "flat in the middle");
        assert!(f.response_db(10000.0).abs() < 0.5, "no low-pass by default");
    }

    /// 24 dB/octave really is twice the slope: 24 dB down two octaves below, against 12.
    #[test]
    fn the_slope_setting_changes_the_rolloff() {
        let mut f = Filter::new(48000.0);
        f.set_param(1, 100.0); // high-pass at 100 Hz
        f.set_param(6, 1.0);
        settle(&mut f);
        let twelve = f.response_db(25.0); // two octaves below
        f.set_param(4, 1.0); // 24 dB/octave
        settle(&mut f);
        let twenty_four = f.response_db(25.0);
        assert!(twelve < -18.0, "12 dB/octave reaches {twelve:.1} dB");
        assert!(
            twenty_four < twelve - 12.0,
            "24 dB/octave must be far steeper: {twenty_four:.1} against {twelve:.1}"
        );
    }

    /// The low-pass is off until it is switched on, and then it cuts what it should.
    #[test]
    fn the_low_pass_only_acts_when_enabled() {
        let mut f = Filter::new(48000.0);
        f.set_param(6, 1.0);
        settle(&mut f);
        assert!(f.response_db(9000.0).abs() < 0.5);
        f.set_param(2, 1.0); // on
        f.set_param(3, 2000.0);
        settle(&mut f);
        assert!(f.response_db(9000.0) < -20.0, "hiss cut above 2 kHz");
        assert!(f.response_db(500.0).abs() < 1.0, "the voice stays");
    }

    /// Two octaves below the corner it really attenuates the signal, not just the curve.
    #[test]
    fn the_high_pass_removes_the_rumble_from_a_tone() {
        let mut f = Filter::new(48000.0);
        f.set_param(1, 120.0);
        f.set_param(6, 1.0);
        let low = at(&mut f, 48000.0, 40.0, 48000, 0.5);
        let mid = at(&mut f, 48000.0, 1000.0, 48000, 0.5);
        assert!(low < 0.05, "40 Hz should be gone, got {low:.4}");
        assert!(mid > 0.3, "1 kHz should pass, got {mid:.4}");
    }

    /// `mix` at zero is a bypass, at one the filter: the blend is real.
    #[test]
    fn mix_blends_with_the_dry_signal() {
        let mut f = Filter::new(48000.0);
        f.set_param(1, 200.0);
        f.set_param(6, 0.0);
        // A 0.5-amplitude sine is 0.354 RMS; at `mix` 0 none of it is filtered away.
        assert!(at(&mut f, 48000.0, 50.0, 48000, 0.5) > 0.3, "dry");
        f.set_param(6, 1.0);
        assert!(at(&mut f, 48000.0, 50.0, 48000, 0.5) < 0.1, "wet");
    }

    /// A parameter sweep must not click: the coefficient update is per control block.
    #[test]
    fn a_frequency_sweep_does_not_step() {
        let mut f = Filter::new(48000.0);
        f.set_param(6, 1.0);
        let mut out: Vec<f32> = Vec::new();
        for k in 0..40 {
            // Sweep the corner across two octaves while a tone plays.
            f.set_param(1, 60.0 + k as f32 * 8.0);
            let mut l = sine(300.0, 48000.0, 480, 0.4);
            let mut r = l.clone();
            f.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        let worst = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        let step = 2.0 * std::f32::consts::PI * 300.0 / 48000.0 * 0.4;
        assert!(
            worst < 6.0 * step,
            "sweep stepped by {worst:.4}, the tone by {step:.4}"
        );
    }
}
