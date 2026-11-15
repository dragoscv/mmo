//! Character: the shapes a voice takes when it is not a voice — telephone, megaphone, radio,
//! lo-fi and robot.
//!
//! One effect rather than five, because they are the same three moves in different proportions: a
//! band (how much of the spectrum survives), a drive (how hard the surviving part is pushed) and,
//! for the robot only, a ring modulator. The band edges of every mode are measured in the tests
//! (`response_db`), so what the labels promise is what the filter does.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit};
use crate::processor::{Processor, defaults, store};

const MODES: &[&str] = &["clean", "telephone", "megaphone", "radio", "lofi", "robot"];

const SPECS: &[ParamSpec] = &[
    ParamSpec::choice("mode", MODES, 1),
    ParamSpec::new("drive", 0.0, 1.0, 0.35, Unit::Percent),
    // -1 = dark, 0 = neutral, +1 = bright (a tilt around 1 kHz).
    ParamSpec::new("tone", -1.0, 1.0, 0.0, Unit::None),
    // Ring-modulator frequency, robot only.
    ParamSpec::log("rate", 20.0, 2000.0, 60.0, Unit::Hz),
    // Lo-fi only: how far the sample rate is folded down (0 = off, 1 = the coarsest step).
    ParamSpec::new("grit", 0.0, 1.0, 0.5, Unit::Percent),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
];

const N: usize = 6;
const CONTROL: usize = 32;

/// Band edges and drive per mode: (high-pass Hz, low-pass Hz, band resonance, drive multiplier).
const SHAPE: [(f32, f32, f32, f32); 6] = [
    (20.0, 20000.0, 0.707, 1.0), // clean: no band, the drive is the effect
    (300.0, 3400.0, 0.707, 1.0), // telephone
    (500.0, 4000.0, 1.4, 1.8),   // megaphone: resonant, harder
    (300.0, 5000.0, 0.9, 1.4),   // radio
    (300.0, 6000.0, 0.707, 1.2), // lofi: the grit does the work
    (200.0, 4000.0, 0.707, 1.0), // robot
];

pub struct Character {
    sr: f32,
    v: [f32; N],
    s: [Smoothed; N],
    /// Per channel: high-pass, low-pass, tilt-low, tilt-high.
    f: [[Biquad; 4]; 2],
    mix: Smoothed,
    /// Ring-modulator phase, per channel (a few degrees apart so the robot is not mono-locked).
    phase: [f32; 2],
    /// Lo-fi sample-and-hold state.
    hold: [f32; 2],
    hold_count: f32,
}

impl Character {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; N] = defaults(SPECS);
        let ramp = (sample_rate * 0.03) as u32;
        let s = core::array::from_fn(|i| Smoothed::new(v[i], ramp));
        let mut c = Self {
            sr: sample_rate,
            v,
            s,
            f: [[Biquad::default(); 4]; 2],
            mix: Smoothed::new(v[5], ramp),
            phase: [0.0, std::f32::consts::FRAC_PI_4],
            hold: [0.0; 2],
            hold_count: 0.0,
        };
        c.recompute();
        c
    }

    fn mode(&self) -> usize {
        (self.s[0].value().round() as usize).min(MODES.len() - 1)
    }

    /// Tilt: a low shelf down / high shelf up as `tone` rises, and the reverse as it falls.
    fn tilt_db(&self) -> f32 {
        self.s[2].value() * 9.0
    }

    fn recompute(&mut self) {
        let sr = self.sr;
        let (hp, lp, q, _) = SHAPE[self.mode()];
        let tilt = self.tilt_db();
        let all = [
            Coefs::high_pass(hp, q, sr),
            Coefs::low_pass(lp, q, sr),
            // A tilt is two shelves: the bottom moves one way, the top the other.
            Coefs::low_shelf(1000.0, -tilt * 0.5, sr),
            Coefs::high_shelf(1000.0, tilt, sr),
        ];
        for ch in &mut self.f {
            for (b, c) in ch.iter_mut().zip(all) {
                b.set(c);
            }
        }
    }

    /// Magnitude of the band shaping at `freq` (drive, grit and the ring modulator excluded).
    pub fn response_db(&self, freq: f32) -> f32 {
        let m: f32 = self.f[0]
            .iter()
            .map(|b| b.coefs().magnitude(freq, self.sr))
            .product();
        20.0 * m.max(1e-9).log10()
    }
}

impl Processor for Character {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 5 {
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
            let mode = self.mode();
            let drive = self.s[1].value() * SHAPE[mode].3;
            let grit = self.s[4].value();
            let hold_for = if mode == 4 { 1.0 + grit * 15.0 } else { 1.0 };
            let increment = self.s[3].value();
            // The drive law is `tanh(x·k)/k`: small-signal gain stays at **unity**, so switching a
            // mode does not jump in level, and only the loud part bends. Normalising by `tanh(k)`
            // instead would add up to +10 dB to quiet material — a hidden fader, not a character.
            let k = 1.0 + drive * 6.0;
            let step = std::f32::consts::TAU * increment / self.sr;
            let [c0, c1] = &mut self.f;
            for i in off..off + n {
                let (a, b) = (l[i], r[i]);
                // Band shaping first: what survives the mode.
                let mut x = a;
                let mut y = b;
                for (bl, br) in c0.iter_mut().zip(c1.iter_mut()) {
                    x = bl.tick(x);
                    y = br.tick(y);
                }
                // Lo-fi sample-and-hold.
                self.hold_count += 1.0;
                if self.hold_count >= hold_for {
                    self.hold_count = 0.0;
                    self.hold[0] = x;
                    self.hold[1] = y;
                }
                if mode == 4 {
                    x = self.hold[0];
                    y = self.hold[1];
                }
                // Ring modulator (robot).
                if mode == 5 {
                    let (sl, sr_) = (self.phase[0].sin(), self.phase[1].sin());
                    self.phase[0] = wrap(self.phase[0] + step);
                    self.phase[1] = wrap(self.phase[1] + step);
                    x *= sl;
                    y *= sr_;
                }
                x = (x * k).tanh() / k;
                y = (y * k).tanh() / k;
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
        self.phase = [0.0, std::f32::consts::FRAC_PI_4];
        self.hold = [0.0; 2];
        self.hold_count = 0.0;
    }
}

fn wrap(p: f32) -> f32 {
    let t = std::f32::consts::TAU;
    if p > t { p - t } else { p }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine};

    fn mode(name: &str) -> Character {
        let mut c = Character::new(48000.0);
        let i = MODES.iter().position(|m| *m == name).expect("known mode");
        c.set_param(0, i as f32);
        c.set_param(5, 1.0);
        settle(&mut c);
        c
    }

    /// Run silence until every ramp has reached its target: coefficients are recomputed while a
    /// parameter is moving, so `response_db` only reflects a change once the ramp is done (30 ms).
    fn settle(c: &mut Character) {
        for _ in 0..40 {
            let (mut l, mut r) = (vec![0.0f32; 480], vec![0.0f32; 480]);
            c.process(&mut l, &mut r);
        }
    }

    fn level(c: &mut Character, freq: f32) -> f32 {
        let n = 48000;
        let mut l = sine(freq, 48000.0, n, 0.4);
        let mut r = l.clone();
        let head = n / 4;
        c.process(&mut l[..head], &mut r[..head]);
        c.process(&mut l[head..], &mut r[head..]);
        rms(&l[head..])
    }

    /// Every mode has a defined band, and the label matches the filter.
    #[test]
    fn each_mode_shapes_the_band_it_promises() {
        let phone = mode("telephone");
        assert!(phone.response_db(80.0) < -20.0, "telephone kills the lows");
        assert!(
            phone.response_db(1000.0).abs() < 1.0,
            "and keeps the speech band"
        );
        // A 2nd-order low-pass at 3.4 kHz is about -17 dB at 9 kHz: strong, not infinite.
        assert!(
            phone.response_db(9000.0) < -15.0,
            "and the highs, got {:.1} dB",
            phone.response_db(9000.0)
        );

        let mega = mode("megaphone");
        assert!(
            mega.response_db(200.0) < -13.0,
            "megaphone cuts below its band"
        );
        assert!(mega.response_db(1200.0).abs() < 3.0);

        // A 2nd-order edge is about -19 dB an octave and a half out, so the criterion for every
        // mode is "the stopband is at least 15 dB down", not a figure guessed per mode.
        let radio = mode("radio");
        assert!(radio.response_db(100.0) < -15.0, "radio cuts the lows");
        assert!(radio.response_db(3000.0).abs() < 1.5);

        let lofi = mode("lofi");
        assert!(lofi.response_db(100.0) < -15.0, "lofi cuts the lows");
        assert!(lofi.response_db(3000.0).abs() < 1.5);

        let robot = mode("robot");
        assert!(robot.response_db(1000.0).abs() < 1.5);
    }

    /// `clean` is a band-free shape: the drive is the whole effect.
    #[test]
    fn clean_leaves_the_spectrum_alone() {
        let c = mode("clean");
        assert!(c.response_db(80.0).abs() < 0.5);
        assert!(c.response_db(1000.0).abs() < 0.5);
        assert!(c.response_db(9000.0).abs() < 0.5);
    }

    /// A telephone band really removes the rumble of a real tone.
    #[test]
    fn telephone_removes_a_low_tone_and_keeps_a_mid_one() {
        let mut c = mode("telephone");
        let low = level(&mut c, 80.0);
        let mid = level(&mut c, 1000.0);
        assert!(low < 0.05, "80 Hz through a telephone: {low:.4}");
        assert!(mid > 0.1, "1 kHz through a telephone: {mid:.4}");
        assert!(
            mid / low > 10.0,
            "the band must reject the rumble by 20 dB: {:.1} dB",
            20.0 * (mid / low).log10()
        );
    }

    /// `tone` tilts the response and nothing else.
    #[test]
    fn tone_tilts_bright_and_dark() {
        let mut c = mode("clean");
        let flat_low = c.response_db(200.0);
        let flat_high = c.response_db(6000.0);
        c.set_param(2, 1.0);
        settle(&mut c);
        let bright_low = c.response_db(200.0);
        let bright_high = c.response_db(6000.0);
        assert!(bright_high > flat_high + 5.0, "the top rises");
        assert!(bright_low < flat_low - 1.0, "the bottom falls");
        c.set_param(2, -1.0);
        settle(&mut c);
        assert!(c.response_db(6000.0) < flat_high - 5.0, "and the reverse");
    }

    /// The robot's ring modulator moves the signal's energy off the carrier.
    #[test]
    fn the_robot_modulates_the_tone() {
        let mut c = mode("robot");
        c.set_param(3, 200.0);
        let n = 24000;
        let mut l = sine(400.0, 48000.0, n, 0.4);
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        // Ring modulation at 200 Hz on a 400 Hz carrier puts energy at 200 and 600: the output is
        // no longer a single sine at the input frequency, and it is not silent.
        assert!(rms(&l) > 0.05, "not silent");
        let crossings = l
            .windows(2)
            .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
            .count();
        let plain = sine(400.0, 48000.0, n, 0.4)
            .windows(2)
            .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
            .count();
        assert!(
            crossings != plain,
            "the robot must change the waveform, crossings {crossings} against {plain}"
        );
    }

    /// Whatever the mode, the output stays inside a sane range (no runaway drive).
    #[test]
    fn no_mode_runs_away() {
        for m in MODES {
            let mut c = mode(m);
            c.set_param(1, 1.0); // full drive
            c.set_param(5, 1.0);
            let n = 24000;
            let mut l = sine(300.0, 48000.0, n, 0.5);
            let mut r = l.clone();
            c.process(&mut l, &mut r);
            let peak = l.iter().fold(0.0f32, |a, v| a.max(v.abs()));
            assert!(peak <= 1.05, "{m} peaked at {peak:.3}");
            assert!(
                l.iter().all(|v| v.is_finite()),
                "{m} produced a non-finite sample"
            );
        }
    }

    /// `mix` at zero is a bypass.
    #[test]
    fn mix_at_zero_is_a_bypass() {
        let mut c = mode("telephone");
        c.set_param(5, 0.0);
        let mut l = sine(80.0, 48000.0, 48000, 0.4);
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        assert!(
            (rms(&l[12000..]) - 0.4 / 2f32.sqrt()).abs() < 0.02,
            "dry level kept"
        );
    }
}
