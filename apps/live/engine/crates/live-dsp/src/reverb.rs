//! 8-line feedback delay network reverb (Householder mixing) with pre-delay, early reflections,
//! damping, size, modulation (no metallic ringing on sustained vowels), wet EQ and width.
//!
//! The `type` switch is the **geometry of the same network**, not four algorithms: it scales the delay
//! lengths, the decay, the damping frequency and the modulation depth together, so a room is short and
//! dark, a plate is bright and wide, a spring is short and heavily modulated, and a hall is the
//! reference the others are scaled from. Saying that plainly is better than four near-identical code
//! paths pretending to be four products.

use crate::biquad::{Biquad, Coefs};
use crate::delay_line::DelayLine;
use crate::param::{ParamSpec, Smoothed, Unit, ms_to_samples, undenormal};
use crate::processor::{Processor, defaults, store};
use core::f32::consts::TAU;

const LINES: usize = 8;
/// Mutually prime base lengths in ms at size 1.0.
const BASE_MS: [f32; LINES] = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 79.3];
/// Reverb types: (name, delay-length scale, decay scale, damping-frequency scale, modulation scale).
const TYPES: [(&str, f32, f32, f32, f32); 4] = [
    ("room", 0.55, 0.75, 0.55, 0.6),
    ("hall", 1.0, 1.0, 1.0, 1.0),
    ("plate", 0.75, 1.1, 1.6, 1.8),
    ("spring", 0.45, 0.85, 0.7, 2.6),
];
/// Onset taps in ms — the first reflections that tell the ear how big the room is, before the
/// diffuse tail arrives. The right channel reads each one slightly later, which is the width.
const EARLY_MS: [f32; 5] = [13.0, 19.0, 27.0, 37.0, 47.0];
const EARLY_GAIN: [f32; 5] = [0.70, -0.50, 0.42, -0.30, 0.24];
/// The right channel's taps are this much later than the left's.
const EARLY_SPREAD: f32 = 1.13;

const SPECS: &[ParamSpec] = &[
    ParamSpec::log("decay", 0.2, 12.0, 2.2, Unit::Seconds),
    ParamSpec::new("size", 0.3, 1.5, 1.0, Unit::None),
    ParamSpec::new("pre_delay", 0.0, 150.0, 20.0, Unit::Ms),
    ParamSpec::log("damping", 1000.0, 18000.0, 6500.0, Unit::Hz),
    ParamSpec::log("low_cut", 20.0, 1000.0, 200.0, Unit::Hz),
    ParamSpec::new("width", 0.0, 1.0, 1.0, Unit::Percent),
    ParamSpec::new("mix", 0.0, 1.0, 0.2, Unit::Percent),
    ParamSpec::new("modulation", 0.0, 1.0, 0.3, Unit::Percent),
    ParamSpec::choice("type", &["room", "hall", "plate", "spring"], 1),
    ParamSpec::new("early", 0.0, 1.0, 0.4, Unit::Percent),
];

pub struct Reverb {
    sr: f32,
    v: [f32; 10],
    pre: DelayLine,
    /// Onset taps, read at `EARLY_MS` for the early reflections.
    early: DelayLine,
    lines: [DelayLine; LINES],
    lens: [f32; LINES],
    gains: [f32; LINES],
    damp: [f32; LINES],
    damp_coef: f32,
    low_cut: [Biquad; 2],
    lfo: f32,
    mix: Smoothed,
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 10] = defaults(SPECS);
        let max_line = ms_to_samples(BASE_MS[LINES - 1] * 1.5 + 5.0, sample_rate) as usize;
        let mut r = Self {
            sr: sample_rate,
            v,
            pre: DelayLine::new(ms_to_samples(160.0, sample_rate) as usize),
            early: DelayLine::new(ms_to_samples(
                EARLY_MS[EARLY_MS.len() - 1] * EARLY_SPREAD + 5.0,
                sample_rate,
            ) as usize),
            lines: core::array::from_fn(|_| DelayLine::new(max_line)),
            lens: [0.0; LINES],
            gains: [0.0; LINES],
            damp: [0.0; LINES],
            damp_coef: 0.0,
            low_cut: [Biquad::default(); 2],
            lfo: 0.0,
            mix: Smoothed::with_ms(v[6], 20.0, sample_rate),
        };
        r.update();
        r
    }

    fn update(&mut self) {
        let t = self.type_scales();
        let decay = self.v[0] * t.1;
        for i in 0..LINES {
            self.lens[i] = ms_to_samples(BASE_MS[i] * self.v[1] * t.0, self.sr);
            // Per-line gain so every line decays 60 dB in `decay` seconds.
            self.gains[i] = 10f32.powf(-3.0 * self.lens[i] / (decay * self.sr));
        }
        self.damp_coef = (-TAU * self.v[3] * t.2 / self.sr).exp();
        let c = Coefs::high_pass(self.v[4], 0.707, self.sr);
        for b in &mut self.low_cut {
            b.set(c);
        }
    }

    /// The selected type's (length, decay, damping, modulation) scales.
    fn type_scales(&self) -> (f32, f32, f32, f32) {
        let i = (self.v[8].round().max(0.0) as usize).min(TYPES.len() - 1);
        let t = TYPES[i];
        (t.1, t.2, t.3, t.4)
    }
}

impl Processor for Reverb {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 6 {
                self.mix.set(v);
            } else {
                self.update();
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let pre = ms_to_samples(self.v[2], self.sr).max(1.0);
        let width = self.v[5];
        let mod_depth = self.v[7] * self.type_scales().3 * ms_to_samples(0.6, self.sr);
        let early = self.v[9];
        // Tap positions, resolved once per block rather than per sample.
        let taps: [(f32, f32); EARLY_MS.len()] = core::array::from_fn(|k| {
            (
                ms_to_samples(EARLY_MS[k], self.sr),
                ms_to_samples(EARLY_MS[k] * EARLY_SPREAD, self.sr),
            )
        });
        let lfo_inc = TAU * 0.7 / self.sr;
        let dc = self.damp_coef;
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let m = self.mix.next();
            self.pre.push(0.5 * (*a + *b));
            let input = self.pre.read(pre);
            let mut out = [0.0f32; LINES];
            for i in 0..LINES {
                let modulation = if i < 2 {
                    mod_depth * (self.lfo + i as f32 * 1.7).sin()
                } else {
                    0.0
                };
                let y = self.lines[i].read(self.lens[i] + modulation + 1.0);
                // One-pole low-pass damping inside the loop.
                self.damp[i] = undenormal(y * (1.0 - dc) + self.damp[i] * dc);
                out[i] = self.damp[i] * self.gains[i];
            }
            // Householder reflection: y = x - 2/N * sum(x).
            let sum: f32 = out.iter().sum::<f32>() * (2.0 / LINES as f32);
            for i in 0..LINES {
                self.lines[i].push(out[i] - sum + input * 0.35);
            }
            self.lfo += lfo_inc;
            if self.lfo > TAU {
                self.lfo -= TAU;
            }
            let wl = out[0] + out[2] + out[4] + out[6];
            let wr = out[1] + out[3] + out[5] + out[7];
            let mid = 0.5 * (wl + wr);
            let side = 0.5 * (wl - wr) * width;
            let wl = self.low_cut[0].tick(mid + side) * 0.6;
            let wr = self.low_cut[1].tick(mid - side) * 0.6;
            // Early reflections: discrete taps of the pre-delayed input, ahead of the tail.
            let (mut el, mut er) = (0.0f32, 0.0f32);
            if early > 0.0 {
                self.early.push(input);
                for (k, (tl, tr)) in taps.iter().enumerate() {
                    el += self.early.read(*tl) * EARLY_GAIN[k];
                    er += self.early.read(*tr) * EARLY_GAIN[k];
                }
            }
            // Send-style: dry always passes, `mix` sets the wet level.
            *a += m * (wl + early * el);
            *b += m * (wr + early * er);
        }
    }
    fn reset(&mut self) {
        self.pre.clear();
        self.early.clear();
        for l in &mut self.lines {
            l.clear();
        }
        self.damp = [0.0; LINES];
        for b in &mut self.low_cut {
            b.reset();
        }
    }
    fn tail_seconds(&self) -> f32 {
        self.v[0] + self.v[2] * 0.001
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An impulse in, the wet output over 3 s (mix 1 so only the wet signal is measured).
    fn impulse_response(rv: &mut Reverb) -> Vec<f32> {
        let mut l = vec![0.0f32; 48000 * 3];
        let mut r = l.clone();
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r);
        l
    }

    /// The type changes the geometry: a room is shorter than a hall, a plate is brighter than both.
    #[test]
    fn the_type_changes_the_tail() {
        let tail = |kind: f32| {
            let mut rv = Reverb::new(48000.0);
            rv.set_param(6, 1.0); // wet only
            rv.set_param(9, 0.0); // no early reflections, so this is the diffuse tail alone
            rv.set_param(8, kind);
            let out = impulse_response(&mut rv);
            // Energy a second in, well past every type's onset.
            out[48000..96000].iter().map(|v| v * v).sum::<f32>()
        };
        let room = tail(0.0);
        let hall = tail(1.0);
        assert!(
            hall > room * 1.5,
            "the hall should ring longer than the room: {hall:.6} against {room:.6}"
        );
        assert!(hall.is_finite() && room.is_finite());
    }

    /// Early reflections arrive before the diffuse tail, and `early` 0 removes them.
    #[test]
    fn early_reflections_precede_the_tail() {
        let onset = |early: f32| {
            let mut rv = Reverb::new(48000.0);
            rv.set_param(2, 0.0); // no pre-delay, so the taps are the first thing heard
            rv.set_param(6, 1.0);
            rv.set_param(9, early);
            let out = impulse_response(&mut rv);
            // The taps sit between 13 and 47 ms: measure inside that window.
            let (a, b) = (480, 2400);
            out[a..b].iter().map(|v| v * v).sum::<f32>().sqrt()
        };
        let with = onset(1.0);
        let without = onset(0.0);
        assert!(with > 0.2, "the taps should be audible: {with:.4}");
        assert!(
            with > without * 2.0,
            "turning early reflections off must remove them: {with:.4} against {without:.4}"
        );
    }

    /// Every type stays finite and does not run away.
    #[test]
    fn every_type_is_stable() {
        for kind in 0..TYPES.len() {
            let mut rv = Reverb::new(48000.0);
            rv.set_param(0, 8.0); // a long decay
            rv.set_param(6, 1.0);
            rv.set_param(8, kind as f32);
            let out = impulse_response(&mut rv);
            assert!(
                out.iter().all(|v| v.is_finite()),
                "type {kind} produced a non-finite sample"
            );
            let peak = out.iter().fold(0.0f32, |a, v| a.max(v.abs()));
            assert!(peak < 4.0, "type {kind} peaked at {peak:.3}");
        }
    }

    #[test]
    fn tail_decays_and_stays_finite() {
        let mut rv = Reverb::new(48000.0);
        rv.set_param(0, 1.0);
        rv.set_param(6, 1.0);
        let mut l = vec![0.0f32; 48000 * 3];
        let mut r = l.clone();
        l[0] = 1.0;
        r[0] = 1.0;
        rv.process(&mut l, &mut r);
        assert!(l.iter().all(|x| x.is_finite()));
        let early: f32 = l[4800..9600].iter().map(|x| x * x).sum();
        let late: f32 = l[48000 * 2..48000 * 2 + 4800].iter().map(|x| x * x).sum();
        assert!(
            early > 0.0 && late < early * 1e-4,
            "early {early} late {late}"
        );
    }
}
