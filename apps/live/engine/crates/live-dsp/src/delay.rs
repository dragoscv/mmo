//! Stereo vocal delay: free time or tempo-synced, ping-pong, filtered feedback, ducking.

use crate::biquad::{Biquad, Coefs};
use crate::delay_line::DelayLine;
use crate::param::{
    ParamSpec, Smoothed, Unit, db_to_lin, ms_to_samples, one_pole_coef, undenormal,
};
use crate::processor::{Processor, defaults, store};

pub const SYNC_CHOICES: &[&str] = &[
    "off", "1/2", "1/4", "1/4d", "1/4t", "1/8", "1/8d", "1/8t", "1/16",
];

/// Beats (quarter notes) for each `SYNC_CHOICES` entry; 0 = free time.
const SYNC_BEATS: [f32; 9] = [0.0, 2.0, 1.0, 1.5, 2.0 / 3.0, 0.5, 0.75, 1.0 / 3.0, 0.25];

const SPECS: &[ParamSpec] = &[
    ParamSpec::log("time", 20.0, 2000.0, 375.0, Unit::Ms),
    ParamSpec::choice("sync", SYNC_CHOICES, 0),
    ParamSpec::new("bpm", 40.0, 240.0, 120.0, Unit::Bpm),
    ParamSpec::new("feedback", 0.0, 0.95, 0.35, Unit::Percent),
    ParamSpec::new("mix", 0.0, 1.0, 0.25, Unit::Percent),
    ParamSpec::toggle("ping_pong", true),
    ParamSpec::log("low_cut", 20.0, 2000.0, 250.0, Unit::Hz),
    ParamSpec::log("high_cut", 1000.0, 20000.0, 6000.0, Unit::Hz),
    ParamSpec::new("duck", 0.0, 24.0, 6.0, Unit::Db),
];

pub struct Delay {
    sr: f32,
    v: [f32; 9],
    lines: [DelayLine; 2],
    time: Smoothed,
    mix: Smoothed,
    fb_filter: [[Biquad; 2]; 2],
    env: f32,
    duck_att: f32,
    duck_rel: f32,
}

impl Delay {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 9] = defaults(SPECS);
        let cap = ms_to_samples(2100.0, sample_rate) as usize;
        let mut d = Self {
            sr: sample_rate,
            v,
            lines: [DelayLine::new(cap), DelayLine::new(cap)],
            time: Smoothed::with_ms(0.0, 80.0, sample_rate),
            mix: Smoothed::with_ms(v[4], 20.0, sample_rate),
            fb_filter: [[Biquad::default(); 2]; 2],
            env: 0.0,
            duck_att: one_pole_coef(5.0, sample_rate),
            duck_rel: one_pole_coef(250.0, sample_rate),
        };
        d.update();
        d.time.reset(d.time.target());
        d
    }

    /// Effective delay time in milliseconds (after tempo sync).
    pub fn time_ms(&self) -> f32 {
        let beats = SYNC_BEATS[self.v[1] as usize];
        if beats > 0.0 {
            beats * 60_000.0 / self.v[2]
        } else {
            self.v[0]
        }
    }

    fn update(&mut self) {
        self.time
            .set(ms_to_samples(self.time_ms().min(2000.0), self.sr));
        let hp = Coefs::high_pass(self.v[6], 0.707, self.sr);
        let lp = Coefs::low_pass(self.v[7], 0.707, self.sr);
        for ch in &mut self.fb_filter {
            ch[0].set(hp);
            ch[1].set(lp);
        }
    }
}

impl Processor for Delay {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 4 {
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
        let fb = self.v[3];
        let ping = self.v[5] > 0.5;
        let duck_db = self.v[8];
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let t = self.time.next();
            let m = self.mix.next();
            let x = a.abs().max(b.abs());
            let c = if x > self.env {
                self.duck_att
            } else {
                self.duck_rel
            };
            self.env += c * (x - self.env);
            // Duck the echoes while the singer is singing; they bloom in the gaps.
            let duck = db_to_lin(-duck_db * (self.env * 4.0).min(1.0));
            let dl = self.lines[0].read(t);
            let dr = self.lines[1].read(t);
            let hl = self.fb_filter[0][0].tick(dl);
            let fl = self.fb_filter[0][1].tick(hl);
            let hr = self.fb_filter[1][0].tick(dr);
            let fr = self.fb_filter[1][1].tick(hr);
            if ping {
                let mono = 0.5 * (*a + *b);
                self.lines[0].push(undenormal(mono + fr * fb));
                self.lines[1].push(undenormal(fl * fb));
            } else {
                self.lines[0].push(undenormal(*a + fl * fb));
                self.lines[1].push(undenormal(*b + fr * fb));
            }
            *a += m * duck * dl;
            *b += m * duck * dr;
        }
    }
    fn reset(&mut self) {
        for l in &mut self.lines {
            l.clear();
        }
        for ch in &mut self.fb_filter {
            for f in ch {
                f.reset();
            }
        }
        self.env = 0.0;
    }
    fn tail_seconds(&self) -> f32 {
        let fb = self.v[3].max(0.01);
        // Time for echoes to fall 60 dB.
        self.time_ms() * 0.001 * (-3.0 / fb.log10()).min(30.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempo_sync_quarter_at_120_is_500ms() {
        let mut d = Delay::new(48000.0);
        d.set_param(1, 2.0);
        d.set_param(2, 120.0);
        assert!((d.time_ms() - 500.0).abs() < 1e-3);
    }

    #[test]
    fn impulse_echo_arrives_on_time() {
        let mut d = Delay::new(48000.0);
        d.set_param(0, 100.0);
        d.set_param(4, 1.0);
        d.set_param(5, 0.0);
        d.set_param(8, 0.0);
        d.set_param(6, 20.0);
        d.set_param(7, 20000.0);
        let mut l = vec![0.0f32; 9600];
        let mut r = l.clone();
        l[0] = 1.0;
        r[0] = 1.0;
        d.process(&mut l, &mut r);
        let peak = l[1..]
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0
            + 1;
        assert!((peak as i32 - 4800).abs() <= 3, "peak at {peak}");
    }
}
