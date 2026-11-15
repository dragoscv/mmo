//! Noise suppression: a **per-band downward expander**.
//!
//! A broadband gate cannot do this job: it opens on any loud sound, so a rumble during a phrase keeps
//! the hiss open with it, and it chatters on a voice that dips. Splitting into three bands with a
//! Linkwitz-Riley crossover (the same 4th-order pair the de-esser uses) lets each band carry its own
//! noise floor, so hiss is taken down while the voice's own band stays open.
//!
//! The detector is an **RMS follower** (20 ms up, `release` down), not a peak follower: the floor and
//! the comparison have to measure the same quantity, and a peak detector on noise tracks crests well
//! above the RMS that a level measurement compares against — pairing the two halves the usable depth.
//!
//! Each band holds a floor and applies a 2:1 downward expansion below `threshold` dB above it, capped
//! at `depth` dB and scaled by `amount`. The floor is **captured, not chased**: three bands cannot tell
//! a sustained note from a room that got louder, so a tracker that always followed the level would
//! learn a held phrase as "the noise" and pull the voice down with it (measured: a 15 dB loss on a
//! 1 kHz tone with a fast tracker). `learn` on captures the floor from the signal as it is now
//! (~20 ms); `learn` off lets it drift very slowly (~5 s) in either direction, so a room that changes
//! over a set is eventually followed but a phrase never is. With no learn and no drift the floor is 0
//! and nothing is attenuated, which is the safe default.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit, db_to_lin, lin_to_db};
use crate::processor::{Processor, defaults, store};

const SPECS: &[ParamSpec] = &[
    ParamSpec::new("amount", 0.0, 1.0, 0.6, Unit::Percent),
    ParamSpec::new("depth", 0.0, 40.0, 18.0, Unit::Db),
    ParamSpec::new("threshold", 3.0, 30.0, 9.0, Unit::Db),
    ParamSpec::log("release", 20.0, 1000.0, 180.0, Unit::Ms),
    ParamSpec::toggle("learn", false),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
];

const N: usize = 6;
/// Bands: below `CROSSOVERS[0]`, between them, above `CROSSOVERS[1]`.
const BANDS: usize = 3;
const CROSSOVERS: [f32; 2] = [300.0, 3000.0];
/// Expansion ratio below the knee: 2:1 downwards.
const RATIO: f32 = 2.0;
const CONTROL: usize = 32;
/// Capturing the floor (`learn` on), and how far it drifts when it is off.
const LEARN_S: f32 = 0.02;
const DRIFT_S: f32 = 5.0;

pub struct Denoise {
    sr: f32,
    v: [f32; N],
    s: [Smoothed; N],
    mix: Smoothed,
    /// Per channel: [crossover][low | high][stage]; the high side of a crossover feeds the next one.
    xf: [[[[Biquad; 2]; 2]; 2]; 2],
    /// Per channel per band: mean square of the band, learned floor, applied gain.
    ms: [[f32; BANDS]; 2],
    floor: [[f32; BANDS]; 2],
    gain: [[f32; BANDS]; 2],
    /// Detector coefficients: rising (20 ms) and falling (`release`), plus the floor's capture and
    /// drift rates.
    atk: f32,
    rel: f32,
    learn_a: f32,
    drift: f32,
}

impl Denoise {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; N] = defaults(SPECS);
        let ramp = (sample_rate * 0.03) as u32;
        let s = core::array::from_fn(|i| Smoothed::new(v[i], ramp));
        let mut d = Self {
            sr: sample_rate,
            v,
            s,
            mix: Smoothed::new(v[4], ramp),
            xf: [[[[Biquad::default(); 2]; 2]; 2]; 2],
            ms: [[0.0; BANDS]; 2],
            floor: [[0.0; BANDS]; 2],
            gain: [[1.0; BANDS]; 2],
            atk: 1.0,
            rel: 0.0,
            learn_a: 0.0,
            drift: 0.0,
        };
        d.recompute();
        d
    }

    fn recompute(&mut self) {
        let sr = self.sr;
        let q = core::f32::consts::FRAC_1_SQRT_2;
        for (c, f) in CROSSOVERS.iter().enumerate() {
            let lp = Coefs::low_pass(*f, q, sr);
            let hp = Coefs::high_pass(*f, q, sr);
            for ch in 0..2 {
                for st in 0..2 {
                    self.xf[ch][c][0][st].set(lp);
                    self.xf[ch][c][1][st].set(hp);
                }
            }
        }
        // RMS follower: 20 ms up, the parameter down.
        self.atk = 1.0 - (-1.0f32 / (0.020 * sr)).exp();
        let ms = self.s[3].value().max(1.0);
        self.rel = 1.0 - (-1.0f32 / (ms * 0.001 * sr)).exp();
        self.learn_a = 1.0 - (-1.0f32 / (LEARN_S * sr)).exp();
        self.drift = 1.0 - (-1.0f32 / (DRIFT_S * sr)).exp();
    }

    /// Current gain per band in dB (0 = low, 1 = mid, 2 = high), left channel: what the meters and the
    /// UI show, and how the tests check that the bands really act on their own.
    pub fn band_gain_db(&self) -> [f32; BANDS] {
        core::array::from_fn(|b| lin_to_db(self.gain[0][b].max(1e-9)))
    }
}

impl Processor for Denoise {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 5 {
                self.mix.set(v);
            } else {
                self.s[i].set(v);
                if i == 3 {
                    self.recompute();
                }
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
            let rel = self.rel;
            let atk = self.atk;
            // Capturing is fast; drifting is slow, in both directions.
            let fstep = if self.v[4] > 0.5 {
                self.learn_a
            } else {
                self.drift
            };
            // The expansion law, read once per block (the parameters are already smoothed):
            // `threshold` dB above the learned floor, 2:1 downwards, capped at depth x amount.
            let thr_lin = db_to_lin(self.s[2].value());
            let max_cut = -self.s[1].value() * self.s[0].value();
            for i in off..off + n {
                let (a, b) = (l[i], r[i]);
                let m = self.mix.next();
                let mut out = [0.0f32; 2];
                for ch in 0..2 {
                    let mut bands = [0.0f32; BANDS];
                    let x = if ch == 0 { a } else { b };
                    // Split into three bands with two Linkwitz-Riley crossovers.
                    let mut high = x;
                    for c in 0..2 {
                        let mut lo = high;
                        let mut hi = high;
                        for st in 0..2 {
                            lo = self.xf[ch][c][0][st].tick(lo);
                            hi = self.xf[ch][c][1][st].tick(hi);
                        }
                        bands[c] = lo;
                        high = hi;
                    }
                    bands[2] = high;
                    let mut sum = 0.0;
                    for b in 0..BANDS {
                        let x2 = bands[b] * bands[b];
                        let m = &mut self.ms[ch][b];
                        *m += (x2 - *m) * if x2 > *m { atk } else { rel };
                        let env = m.max(0.0).sqrt();
                        let f = &mut self.floor[ch][b];
                        *f += (env - *f) * fstep;
                        let over = lin_to_db((env + 1e-12) / (*f * thr_lin + 1e-9));
                        let want = if over >= 0.0 {
                            1.0
                        } else {
                            db_to_lin((over * RATIO).max(max_cut))
                        };
                        let g = &mut self.gain[ch][b];
                        // A short ramp on the gain itself, so an expansion edge is not a click.
                        *g += (want - *g) * 0.01;
                        sum += bands[b] * *g;
                    }
                    out[ch] = sum;
                }
                l[i] = a + m * (out[0] - a);
                r[i] = b + m * (out[1] - b);
            }
            off += n;
        }
    }
    fn reset(&mut self) {
        for ch in &mut self.xf {
            for c in ch {
                for side in c {
                    for b in side {
                        b.reset();
                    }
                }
            }
        }
        self.ms = [[0.0; BANDS]; 2];
        self.floor = [[0.0; BANDS]; 2];
        self.gain = [[1.0; BANDS]; 2];
    }
    fn gain_reduction_db(&self) -> f32 {
        let mut deepest = 0.0f32;
        for ch in 0..2 {
            for b in 0..BANDS {
                deepest = deepest.max(-lin_to_db(self.gain[ch][b].max(1e-6)));
            }
        }
        deepest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine};

    /// Deterministic broadband noise at a chosen RMS.
    fn noise(n: usize, rms_level: f32, seed: u32) -> Vec<f32> {
        let mut s = seed | 1;
        let mut raw: Vec<f32> = (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 23) as f32 - 1.0
            })
            .collect();
        let k = rms_level / rms(&raw).max(1e-9);
        for v in raw.iter_mut() {
            *v *= k;
        }
        raw
    }

    /// Level of one frequency in a signal (a single-bin DFT), for measuring a band.
    fn tone_level(x: &[f32], freq: f32, sr: f32) -> f32 {
        let (mut re, mut im) = (0.0f32, 0.0f32);
        for (i, v) in x.iter().enumerate() {
            let p = core::f32::consts::TAU * freq * i as f32 / sr;
            re += v * p.cos();
            im += v * p.sin();
        }
        2.0 * (re * re + im * im).sqrt() / x.len().max(1) as f32
    }

    fn denoiser() -> Denoise {
        let mut d = Denoise::new(48000.0);
        d.set_param(5, 1.0); // mix
        d.set_param(0, 1.0); // full depth: the default 0.6 is deliberately gentle
        d
    }

    /// Capture the floor from `signal`, the way the Learn button does, then stop learning.
    fn learn(d: &mut Denoise, signal: &[f32]) {
        d.set_param(4, 1.0);
        let (mut l, mut r) = (signal.to_vec(), signal.to_vec());
        d.process(&mut l, &mut r);
        d.set_param(4, 0.0);
    }

    /// Noise on its own is pushed down by about the full `depth`, and a voice over it is untouched.
    /// The floor is captured first (the Learn gesture), then held: that is what makes a sustained
    /// phrase safe, since a tracker that kept following the level would learn the phrase as noise.
    #[test]
    fn noise_is_pushed_down_while_the_voice_passes() {
        let sr = 48000.0;
        let mut d = denoiser();
        let room = noise(24000, 0.01, 7);
        learn(&mut d, &room);

        // The same noise alone: it must come down.
        let quiet = noise(48000, 0.01, 13);
        let mut l = quiet.clone();
        let mut r = quiet.clone();
        d.process(&mut l, &mut r);
        let after = rms(&l[24000..]);
        let cut = 20.0 * (after / 0.01).log10();
        assert!(
            cut < -12.0,
            "the noise floor should drop by more than 12 dB, it moved {cut:.1} dB ({after:.5})"
        );
        assert!(
            d.band_gain_db().iter().all(|g| *g < -12.0),
            "every band should be down: {:?}",
            d.band_gain_db()
        );

        // A voice over the same noise comes through essentially unchanged.
        let voice = sine(220.0, sr, 48000, 0.5);
        let sung: Vec<f32> = voice
            .iter()
            .zip(noise(48000, 0.01, 11))
            .map(|(v, n)| v + n)
            .collect();
        let mut l = sung.clone();
        let mut r = sung.clone();
        d.process(&mut l, &mut r);
        let with_voice = rms(&l);
        assert!(
            (with_voice - 0.354).abs() < 0.06,
            "the voice was altered: {with_voice:.4} against 0.354"
        );
    }

    /// The point of the band split, read from the per-band gains: a loud mid tone does not hold the
    /// low band open, so a quiet rumble under it is still expanded away, while the band carrying the
    /// voice stays at unity. A broadband gate cannot do this — it opens on the tone and takes the
    /// rumble with it.
    #[test]
    fn bands_are_handled_independently() {
        let sr = 48000.0;
        let mut d = denoiser();
        // Capture the low band's floor from the quiet rumble on its own.
        learn(&mut d, &sine(60.0, sr, 24000, 0.004));

        // A loud 1 kHz tone (the voice) plus the same quiet 60 Hz rumble underneath it.
        let n = 48000;
        let loud: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / sr;
                (core::f32::consts::TAU * 1000.0 * t).sin() * 0.5
                    + (core::f32::consts::TAU * 60.0 * t).sin() * 0.004
            })
            .collect();
        let mut l = loud.clone();
        let mut r = loud.clone();
        d.process(&mut l, &mut r);

        let gain = d.band_gain_db();
        assert!(
            gain[1].abs() < 1.0,
            "the band carrying the voice must stay open, it is at {:.1} dB",
            gain[1]
        );
        assert!(
            gain[0] < -3.0,
            "the low band must still be expanding under a loud neighbour, it is at {:.1} dB",
            gain[0]
        );
        // And the rumble really is quieter in the output than in the input.
        let low_after = tone_level(&l[24000..], 60.0, sr);
        assert!(
            low_after < 0.004 * 0.7,
            "the rumble came out at {low_after:.5}, not below 70 % of its 0.004 input"
        );
    }

    /// `mix` at zero is a bypass, and nothing ever comes out non-finite.
    #[test]
    fn mix_and_stability() {
        let mut d = denoiser();
        d.set_param(5, 0.0);
        let mut l = sine(300.0, 48000.0, 24000, 0.3);
        let mut r = l.clone();
        d.process(&mut l, &mut r);
        assert!(
            (rms(&l[12000..]) - 0.3 / 2f32.sqrt()).abs() < 0.01,
            "dry level kept"
        );

        let mut d = denoiser();
        let mut l = vec![0.0f32; 4096];
        let mut r = l.clone();
        d.process(&mut l, &mut r);
        assert!(l.iter().all(|v| v.is_finite()), "silence must stay finite");
        assert!(r.iter().all(|v| v.is_finite()));
    }

    /// Silence in, silence out: no self-noise from the expansion.
    #[test]
    fn silence_stays_silent() {
        let mut d = denoiser();
        let mut l = vec![0.0f32; 48000];
        let mut r = l.clone();
        d.process(&mut l, &mut r);
        assert!(rms(&l) < 1e-6, "silence produced {}", rms(&l));
    }
}
