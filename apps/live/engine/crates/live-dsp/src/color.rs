//! Saturation (tape / tube / soft clip) with tone control and parallel mix.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit, db_to_lin};
use crate::processor::{Processor, defaults, store};

const SPECS: &[ParamSpec] = &[
    ParamSpec::new("drive", 0.0, 36.0, 6.0, Unit::Db),
    ParamSpec::choice("character", &["tape", "tube", "soft_clip"], 0),
    ParamSpec::log("tone", 1000.0, 20000.0, 12000.0, Unit::Hz),
    ParamSpec::new("mix", 0.0, 1.0, 0.5, Unit::Percent),
    ParamSpec::new("output", -24.0, 12.0, 0.0, Unit::Db),
];

pub struct Saturator {
    sr: f32,
    v: [f32; 5],
    drive: Smoothed,
    mix: Smoothed,
    out: Smoothed,
    tone: [Biquad; 2],
    dc: [f32; 4],
}

impl Saturator {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 5] = defaults(SPECS);
        let mut s = Self {
            sr: sample_rate,
            v,
            drive: Smoothed::with_ms(db_to_lin(v[0]), 20.0, sample_rate),
            mix: Smoothed::with_ms(v[3], 20.0, sample_rate),
            out: Smoothed::with_ms(db_to_lin(v[4]), 20.0, sample_rate),
            tone: [Biquad::default(); 2],
            dc: [0.0; 4],
        };
        s.update_tone();
        s
    }

    fn update_tone(&mut self) {
        let c = Coefs::low_pass(self.v[2], 0.707, self.sr);
        for b in &mut self.tone {
            b.set(c);
        }
    }

    #[inline]
    fn shape(x: f32, character: u8) -> f32 {
        match character {
            // Tape: symmetric soft saturation.
            0 => x.tanh(),
            // Tube: asymmetric (adds even harmonics); DC removed afterwards.
            1 => {
                let y = x + 0.25 * x * x;
                y.tanh()
            }
            // Cubic soft clip.
            _ => {
                let c = x.clamp(-1.5, 1.5);
                c - c * c * c / 6.75
            }
        }
    }
}

impl Processor for Saturator {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            match i {
                0 => self.drive.set(db_to_lin(v)),
                2 => self.update_tone(),
                3 => self.mix.set(v),
                4 => self.out.set(db_to_lin(v)),
                _ => {}
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let ch = self.v[1] as u8;
        // One-pole DC blocker coefficient (~10 Hz).
        let rdc = 1.0 - (2.0 * core::f32::consts::PI * 10.0 / self.sr);
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let d = self.drive.next();
            let m = self.mix.next();
            let o = self.out.next();
            let comp = 1.0 / d.sqrt(); // keep perceived level roughly constant
            for (k, x) in [a, b].into_iter().enumerate() {
                let wet = Self::shape(*x * d, ch) * comp;
                // DC block
                let y = wet - self.dc[k * 2] + rdc * self.dc[k * 2 + 1];
                self.dc[k * 2] = wet;
                self.dc[k * 2 + 1] = y;
                let wet = self.tone[k].tick(y);
                *x = (*x + m * (wet - *x)) * o;
            }
        }
    }
    fn reset(&mut self) {
        self.dc = [0.0; 4];
        for b in &mut self.tone {
            b.reset();
        }
    }
}
