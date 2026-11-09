//! Doubler (ADT) and chorus: modulated short delays, stereo spread.

use crate::delay_line::DelayLine;
use crate::param::{ParamSpec, Smoothed, Unit, ms_to_samples, pan_gains};
use crate::processor::{Processor, defaults, store};
use core::f32::consts::TAU;

// ─── Doubler ────────────────────────────────────────────────────────────────

const DOUBLER_SPECS: &[ParamSpec] = &[
    ParamSpec::new("delay", 5.0, 40.0, 18.0, Unit::Ms),
    ParamSpec::new("detune", 0.0, 30.0, 8.0, Unit::Cents),
    ParamSpec::new("width", 0.0, 1.0, 0.8, Unit::Percent),
    ParamSpec::new("mix", 0.0, 1.0, 0.35, Unit::Percent),
    ParamSpec::new("drift", 0.0, 1.0, 0.5, Unit::Percent),
];

/// Two artificially double-tracked voices panned left/right with independent slow drift,
/// so the copy never phases in sync with the lead.
pub struct Doubler {
    sr: f32,
    v: [f32; 5],
    line: DelayLine,
    phase: [f32; 2],
    mix: Smoothed,
    width: Smoothed,
    base: Smoothed,
}

impl Doubler {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 5] = defaults(DOUBLER_SPECS);
        Self {
            sr: sample_rate,
            v,
            line: DelayLine::new(ms_to_samples(60.0, sample_rate) as usize),
            phase: [0.0, 0.37],
            mix: Smoothed::with_ms(v[3], 20.0, sample_rate),
            width: Smoothed::with_ms(v[2], 20.0, sample_rate),
            base: Smoothed::with_ms(ms_to_samples(v[0], sample_rate), 50.0, sample_rate),
        }
    }
}

impl Processor for Doubler {
    fn specs(&self) -> &'static [ParamSpec] {
        DOUBLER_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, DOUBLER_SPECS, i, v) {
            match i {
                0 => self.base.set(ms_to_samples(v, self.sr)),
                2 => self.width.set(v),
                3 => self.mix.set(v),
                _ => {}
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        // A sinusoidal delay modulation of depth D samples at rate f gives a peak pitch deviation
        // of 2*pi*f*D/sr; solve for D from the detune in cents.
        let rates = [0.31 + 0.2 * self.v[4], 0.23 + 0.17 * self.v[4]];
        let ratio_dev = 2f32.powf(self.v[1] / 1200.0) - 1.0;
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let mono = 0.5 * (*a + *b);
            self.line.push(mono);
            let base = self.base.next();
            let w = self.width.next();
            let m = self.mix.next();
            let mut voices = [0.0f32; 2];
            for k in 0..2 {
                let depth = ratio_dev * self.sr / (TAU * rates[k]);
                let d = base * (1.0 + 0.35 * k as f32) + depth * (1.0 + self.phase[k].sin());
                voices[k] = self.line.read(d + 1.0);
                self.phase[k] += TAU * rates[k] / self.sr;
                if self.phase[k] > TAU {
                    self.phase[k] -= TAU;
                }
            }
            let (gl0, gr0) = pan_gains(-w);
            let (gl1, gr1) = pan_gains(w);
            let wl = voices[0] * gl0 + voices[1] * gl1;
            let wr = voices[0] * gr0 + voices[1] * gr1;
            *a += m * wl * 0.7;
            *b += m * wr * 0.7;
        }
    }
    fn reset(&mut self) {
        self.line.clear();
    }
    fn tail_seconds(&self) -> f32 {
        0.06
    }
}

// ─── Chorus ─────────────────────────────────────────────────────────────────

const CHORUS_SPECS: &[ParamSpec] = &[
    ParamSpec::log("rate", 0.05, 8.0, 0.8, Unit::Hz),
    ParamSpec::new("depth", 0.0, 10.0, 3.0, Unit::Ms),
    ParamSpec::new("delay", 2.0, 30.0, 12.0, Unit::Ms),
    ParamSpec::new("feedback", -0.9, 0.9, 0.0, Unit::Percent),
    ParamSpec::new("mix", 0.0, 1.0, 0.4, Unit::Percent),
    ParamSpec::new("spread", 0.0, 180.0, 90.0, Unit::None),
];

/// Stereo chorus: one LFO per channel offset by `spread` degrees.
pub struct Chorus {
    sr: f32,
    v: [f32; 6],
    lines: [DelayLine; 2],
    phase: f32,
    fb: [f32; 2],
    mix: Smoothed,
}

impl Chorus {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 6] = defaults(CHORUS_SPECS);
        let cap = ms_to_samples(45.0, sample_rate) as usize;
        Self {
            sr: sample_rate,
            v,
            lines: [DelayLine::new(cap), DelayLine::new(cap)],
            phase: 0.0,
            fb: [0.0; 2],
            mix: Smoothed::with_ms(v[4], 20.0, sample_rate),
        }
    }
}

impl Processor for Chorus {
    fn specs(&self) -> &'static [ParamSpec] {
        CHORUS_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, CHORUS_SPECS, i, v)
            && i == 4
        {
            self.mix.set(v);
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let inc = TAU * self.v[0] / self.sr;
        let depth = ms_to_samples(self.v[1], self.sr);
        let base = ms_to_samples(self.v[2], self.sr);
        let fb = self.v[3];
        let spread = self.v[5].to_radians();
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let m = self.mix.next();
            for (k, x) in [a, b].into_iter().enumerate() {
                let ph = self.phase + spread * k as f32;
                let d = base + depth * 0.5 * (1.0 + ph.sin());
                let wet = self.lines[k].read(d);
                self.lines[k].push(*x + fb * self.fb[k]);
                self.fb[k] = wet;
                *x += m * (wet - *x);
            }
            self.phase += inc;
            if self.phase > TAU {
                self.phase -= TAU;
            }
        }
    }
    fn reset(&mut self) {
        for l in &mut self.lines {
            l.clear();
        }
        self.fb = [0.0; 2];
    }
    fn tail_seconds(&self) -> f32 {
        0.05
    }
}
