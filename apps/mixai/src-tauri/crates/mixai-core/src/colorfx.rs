//! Per-deck colour FX (WP19-10): one bipolar knob (-1..1) per effect, placed
//! pre-fader after the deck filter, like a club mixer's "sound colour" section.
//!
//! Effects: bipolar filter, phaser, flanger, noise sweep, dub echo. Everything
//! is preallocated in `new`; `process` never allocates or locks. Algorithms are
//! textbook (RBJ biquads, first-order all-pass chain, modulated delay line) and
//! written from scratch for this crate.
// Parallel per-channel arrays (x, y, state) read clearest as indexed loops.
#![allow(clippy::needless_range_loop)]

use crate::dsp::{Biquad, Smoothed};

/// Colour FX selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorFxKind {
    #[default]
    None,
    Filter,
    Phaser,
    Flanger,
    Noise,
    DubEcho,
}

impl ColorFxKind {
    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Filter,
            2 => Self::Phaser,
            3 => Self::Flanger,
            4 => Self::Noise,
            5 => Self::DubEcho,
            _ => Self::None,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Filter => 1,
            Self::Phaser => 2,
            Self::Flanger => 3,
            Self::Noise => 4,
            Self::DubEcho => 5,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "none" | "off" => Self::None,
            "filter" => Self::Filter,
            "phaser" => Self::Phaser,
            "flanger" => Self::Flanger,
            "noise" => Self::Noise,
            "dub_echo" | "dubEcho" | "dub-echo" => Self::DubEcho,
            _ => return None,
        })
    }
}

const PHASER_STAGES: usize = 6;
/// Coefficients are refreshed every N frames (cheap control-rate updates).
const CONTROL_EVERY: u32 = 32;

/// Stereo ring delay with fractional (linear) reads.
struct Ring {
    l: Vec<f32>,
    r: Vec<f32>,
    w: usize,
}

impl Ring {
    fn new(len: usize) -> Self {
        let len = len.max(4);
        Ring {
            l: vec![0.0; len],
            r: vec![0.0; len],
            w: 0,
        }
    }

    #[inline]
    fn read(&self, delay: f32) -> (f32, f32) {
        let n = self.l.len();
        let d = delay.clamp(1.0, (n - 2) as f32);
        let i = d as usize;
        let frac = d - i as f32;
        let a = (self.w + n - i) % n;
        let b = (self.w + n - i - 1) % n;
        (
            self.l[a] + (self.l[b] - self.l[a]) * frac,
            self.r[a] + (self.r[b] - self.r[a]) * frac,
        )
    }

    #[inline]
    fn push(&mut self, l: f32, r: f32) {
        self.l[self.w] = l;
        self.r[self.w] = r;
        self.w = (self.w + 1) % self.l.len();
    }

    fn clear(&mut self) {
        self.l.iter_mut().for_each(|x| *x = 0.0);
        self.r.iter_mut().for_each(|x| *x = 0.0);
    }
}

/// First-order all-pass section.
#[derive(Clone, Copy, Default)]
struct AllPass1 {
    x1: f32,
    y1: f32,
}

impl AllPass1 {
    #[inline]
    fn process(&mut self, x: f32, a: f32) -> f32 {
        let y = a * x + self.x1 - a * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }
}

/// Per-deck colour FX unit.
pub struct ColorFx {
    sr: f32,
    kind: ColorFxKind,
    param: Smoothed,
    tick: u32,
    // Filter / noise sweep filters (track + noise, stereo).
    filt: [Biquad; 2],
    noise_filt: [Biquad; 2],
    noise_state: u32,
    // Phaser.
    ap: [[AllPass1; PHASER_STAGES]; 2],
    ap_coef: f32,
    phaser_fb: [f32; 2],
    // Flanger / dub echo shared modulation.
    lfo: f32,
    flange: Ring,
    // Dub echo.
    dub: Ring,
    dub_lp: [Biquad; 2],
    dub_hp: [Biquad; 2],
    dub_delay: f32,
}

impl ColorFx {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate.max(8_000.0);
        ColorFx {
            sr,
            kind: ColorFxKind::None,
            param: Smoothed::new(0.0, sr, 25.0),
            tick: 0,
            filt: [Biquad::identity(); 2],
            noise_filt: [Biquad::identity(); 2],
            noise_state: 0x1234_5678,
            ap: [[AllPass1::default(); PHASER_STAGES]; 2],
            ap_coef: 0.0,
            phaser_fb: [0.0; 2],
            lfo: 0.0,
            flange: Ring::new((sr * 0.02) as usize),
            // Up to 2 s of dub echo (3/4 beat at 22.5 bpm).
            dub: Ring::new((sr * 2.0) as usize),
            dub_lp: [Biquad::identity(); 2],
            dub_hp: [Biquad::identity(); 2],
            dub_delay: sr * 0.375,
        }
    }

    pub fn kind(&self) -> ColorFxKind {
        self.kind
    }

    pub fn set(&mut self, kind: ColorFxKind, param: f32) {
        if kind != self.kind {
            self.flange.clear();
            self.phaser_fb = [0.0; 2];
            self.ap = [[AllPass1::default(); PHASER_STAGES]; 2];
            // Dub echo keeps its tail when switching away (spill-over), cleared on entry.
            if kind == ColorFxKind::DubEcho {
                self.dub.clear();
            }
            self.kind = kind;
            self.tick = 0;
        }
        self.param.set_target(param.clamp(-1.0, 1.0));
    }

    #[inline]
    fn noise(&mut self) -> f32 {
        // xorshift32: deterministic, allocation-free white noise.
        let mut x = self.noise_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.noise_state = x;
        (x as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn sweep_filter(filt: &mut [Biquad; 2], p: f32, sr: f32) {
        for f in filt.iter_mut() {
            if p.abs() < 0.02 {
                *f = Biquad::identity();
            } else if p < 0.0 {
                f.low_pass(200.0 * (20_000.0f32 / 200.0).powf(1.0 + p), 1.1, sr);
            } else {
                f.high_pass(20.0 * (8_000.0f32 / 20.0).powf(p), 1.1, sr);
            }
        }
    }

    /// Control-rate coefficient refresh.
    fn update_controls(&mut self, p: f32, bpm: f64) {
        let sr = self.sr;
        match self.kind {
            ColorFxKind::Filter => Self::sweep_filter(&mut self.filt, p, sr),
            ColorFxKind::Noise => {
                Self::sweep_filter(&mut self.filt, p, sr);
                Self::sweep_filter(&mut self.noise_filt, p, sr);
            }
            ColorFxKind::Phaser => {
                // Rate: left = slow (0.2 Hz), right = fast (up to 2 Hz).
                let rate = if p < 0.0 { 0.2 } else { 0.4 + 1.6 * p };
                self.lfo = (self.lfo + rate * CONTROL_EVERY as f32 / sr).fract();
                let m = 0.5 - 0.5 * (std::f32::consts::TAU * self.lfo).cos();
                let fc = 200.0 * (3_000.0f32 / 200.0).powf(m);
                let t = (std::f32::consts::PI * fc / sr).tan();
                self.ap_coef = (t - 1.0) / (t + 1.0);
            }
            ColorFxKind::Flanger => {
                self.lfo = (self.lfo + 0.25 * CONTROL_EVERY as f32 / sr).fract();
            }
            ColorFxKind::DubEcho => {
                let beat = if bpm > 1.0 { 60.0 / bpm } else { 0.5 };
                let target = (beat * 0.75 * sr as f64) as f32;
                // Glide toward a new delay time (tape-style) instead of jumping.
                self.dub_delay += (target - self.dub_delay) * 0.05;
                let lp = if p < 0.0 { 1_500.0 } else { 5_000.0 };
                for f in self.dub_lp.iter_mut() {
                    f.low_pass(lp, 0.7, sr);
                }
                for f in self.dub_hp.iter_mut() {
                    f.high_pass(if p > 0.0 { 300.0 } else { 80.0 }, 0.7, sr);
                }
            }
            ColorFxKind::None => {}
        }
    }

    /// Process one stereo frame. `bpm` = master tempo (for the dub echo time).
    #[inline]
    pub fn process(&mut self, l: f32, r: f32, bpm: f64) -> (f32, f32) {
        let p = self.param.next();
        if self.kind == ColorFxKind::None {
            return (l, r);
        }
        if self.tick == 0 {
            self.update_controls(p, bpm);
        }
        self.tick = (self.tick + 1) % CONTROL_EVERY;
        let amount = p.abs();
        let x = [l, r];
        let mut y = x;
        match self.kind {
            ColorFxKind::Filter => {
                for c in 0..2 {
                    y[c] = self.filt[c].process(x[c]);
                }
            }
            ColorFxKind::Noise => {
                let level = amount * 0.3;
                for c in 0..2 {
                    let n = self.noise() * level;
                    y[c] = self.filt[c].process(x[c]) + self.noise_filt[c].process(n);
                }
            }
            ColorFxKind::Phaser => {
                let fb = 0.2 + 0.5 * amount;
                for c in 0..2 {
                    let mut s = x[c] + self.phaser_fb[c] * fb;
                    for st in self.ap[c].iter_mut() {
                        s = st.process(s, self.ap_coef);
                    }
                    self.phaser_fb[c] = s.clamp(-2.0, 2.0);
                    y[c] = x[c] * (1.0 - 0.5 * amount) + s * 0.5 * amount;
                }
            }
            ColorFxKind::Flanger => {
                let m = 0.5 - 0.5 * (std::f32::consts::TAU * self.lfo).cos();
                let delay = self.sr * (0.0003 + 0.006 * m);
                let (dl, dr) = self.flange.read(delay);
                let d = [dl, dr];
                // Knob side flips feedback polarity (left = hollow, right = metallic).
                let fb = p.signum() * 0.7 * amount;
                let w = [x[0] + d[0] * fb, x[1] + d[1] * fb];
                self.flange
                    .push(w[0].clamp(-2.0, 2.0), w[1].clamp(-2.0, 2.0));
                for c in 0..2 {
                    y[c] = x[c] * (1.0 - 0.5 * amount) + d[c] * 0.5 * amount;
                }
            }
            ColorFxKind::DubEcho => {
                let (el, er) = self.dub.read(self.dub_delay);
                let e = [el, er];
                let fb = (0.4 + 0.5 * amount).min(0.92);
                let mut w = [0.0f32; 2];
                for c in 0..2 {
                    let shaped = self.dub_hp[c].process(self.dub_lp[c].process(e[c]));
                    // tanh in the loop: tape-like saturation, keeps feedback bounded.
                    w[c] = (x[c] * amount + shaped * fb).tanh();
                    y[c] = x[c] + e[c] * amount.max(0.35);
                }
                self.dub.push(w[0], w[1]);
            }
            ColorFxKind::None => {}
        }
        (y[0], y[1])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_fx_stay_finite_on_noise() {
        for kind in 1..=5u8 {
            for p in [-0.9f32, 1.0] {
                let mut fx = ColorFx::new(48_000.0);
                fx.set(ColorFxKind::from_u8(kind), p);
                let mut seed = 99u32;
                let mut peak = 0.0f32;
                for _ in 0..48_000 * 10 {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let n = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
                    let (l, r) = fx.process(n * 0.5, -n * 0.5, 124.0);
                    assert!(l.is_finite() && r.is_finite(), "kind {kind} p {p}: NaN/inf");
                    peak = peak.max(l.abs()).max(r.abs());
                }
                assert!(peak < 8.0, "kind {kind} p {p}: runaway {peak}");
            }
        }
    }

    #[test]
    fn none_is_passthrough() {
        let mut fx = ColorFx::new(48_000.0);
        assert_eq!(fx.process(0.3, -0.2, 120.0), (0.3, -0.2));
    }
}
