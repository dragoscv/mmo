//! Feedback (howl) suppression: a bank of narrow detectors, and a notch on any that is howling.
//!
//! How a howl is recognised, and what that cannot do: a band is a candidate when it stands
//! `sensitivity` dB above the **median** of all bands, and it must stay that way for ~21 ms. The
//! median is the discriminator: a howl excites one band and leaves the crowd low, while music excites
//! many and lifts the median with it (measured: a 1 kHz howl stands 20 dB above the median, and a
//! sung note does not). A "louder than the next band" test was tried first and abandoned — the bands
//! sit 0.31 octave apart, so a tone between two centres excites both about equally (0.9 dB apart,
//! measured) and that test can never fire.
//!
//! What it cannot do: separate a howl from a **sustained pure tone**. At this resolution those are the
//! same signal, and every single-band detector has that limit. So the unit notches, holds for `hold`,
//! and releases; it does not guess.
//!
//! Notches are peaking filters at the band's centre, `depth` dB deep and Q 8, so the notch is narrower
//! than the band spacing and does not eat the voice's own range. A free slot is the identity filter,
//! so an idle suppressor is flat to the bit.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit, db_to_lin};
use crate::processor::{Processor, defaults, store};

const SPECS: &[ParamSpec] = &[
    ParamSpec::new("notches", 1.0, 8.0, 4.0, Unit::None),
    ParamSpec::new("sensitivity", 5.0, 30.0, 12.0, Unit::Db),
    ParamSpec::new("depth", 3.0, 30.0, 18.0, Unit::Db),
    ParamSpec::log("hold", 0.5, 10.0, 3.0, Unit::Seconds),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
];

const N: usize = 5;
/// Detection bands, log-spaced 200 Hz … 8 kHz.
const BANDS: usize = 18;
const BAND_LO: f32 = 200.0;
const BAND_HI: f32 = 8000.0;
/// Notch slots (the `notches` parameter chooses how many may be used).
const SLOTS: usize = 8;
/// How much narrower than the band spacing the notch is.
const NOTCH_Q: f32 = 8.0;
/// Detector bandwidth. Wider than the 0.31-octave band spacing would merge the bands; narrower slows
/// the response without buying separation, since a tone between two centres excites both either way.
const DETECT_Q: f32 = 8.0;
/// The top band must also be audible at all. Without this a howl that has stopped *decaying* still
/// keeps its ratio against a median that is decaying with it, so the notch is refreshed forever and
/// the hold never expires (found by the release test). -50 dBFS is far below any real howl.
const AUDIBLE: f32 = 3.0e-3;
/// How often the bank is examined (samples), and how long a band must persist before it is notched.
const EXAMINE_EVERY: usize = 128; // 2.7 ms at 48 kHz
const PERSIST_TICKS: u32 = 8; // ~21 ms
/// Per-sample smoothing of each band's mean square: ~100 ms rising, ~30 ms falling. The release has
/// to be the quicker of the two — it is what lets the notch go once the howl stops, and at 100 ms down
/// the level took 0.8 s to fall below [`AUDIBLE`], which delayed every release by that much.
const DETECT_UP: f32 = 2.0e-4;
const DETECT_DOWN: f32 = 6.7e-4;

pub struct Feedback {
    sr: f32,
    v: [f32; N],
    s: [Smoothed; N],
    mix: Smoothed,
    centre: [f32; BANDS],
    /// Mono detector bank and its mean square per band.
    det: [Biquad; BANDS],
    ms: [f32; BANDS],
    /// Notch slots: `[slot][channel]`, plus where each is aimed and how long it holds.
    notch: [[Biquad; 2]; SLOTS],
    slot_hz: [f32; SLOTS],
    slot_hold: [f32; SLOTS],
    active: usize,
    last_hz: f32,
    /// Persistent-candidate bookkeeping.
    candidate: usize,
    candidate_ticks: u32,
    countdown: usize,
}

impl Feedback {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; N] = defaults(SPECS);
        let ramp = (sample_rate * 0.03) as u32;
        let s = core::array::from_fn(|i| Smoothed::new(v[i], ramp));
        let mut f = Self {
            sr: sample_rate,
            v,
            s,
            mix: Smoothed::new(v[4], ramp),
            centre: core::array::from_fn(|i| {
                BAND_LO * (BAND_HI / BAND_LO).powf(i as f32 / (BANDS - 1) as f32)
            }),
            det: [Biquad::default(); BANDS],
            ms: [0.0; BANDS],
            notch: [[Biquad::default(); 2]; SLOTS],
            slot_hz: [0.0; SLOTS],
            slot_hold: [0.0; SLOTS],
            active: 0,
            last_hz: 0.0,
            candidate: usize::MAX,
            candidate_ticks: 0,
            countdown: EXAMINE_EVERY,
        };
        f.update();
        f
    }

    fn update(&mut self) {
        for (b, hz) in self.det.iter_mut().zip(self.centre) {
            b.set(Coefs::band_pass(hz, DETECT_Q, self.sr));
        }
        // A slot that is aimed at a frequency gets its notch; a free one is the identity.
        for slot in 0..SLOTS {
            let depth = -self.s[2].value();
            let c = if self.slot_hold[slot] > 0.0 {
                Coefs::peaking(self.slot_hz[slot], depth, NOTCH_Q, self.sr)
            } else {
                Coefs::identity()
            };
            for ch in 0..2 {
                self.notch[slot][ch].set(c);
            }
        }
    }

    /// Frequency of the most recent notch (0 when none), for the UI and the tests.
    pub fn notch_hz(&self) -> f32 {
        self.last_hz
    }

    /// How many notches are placed right now.
    pub fn active_notches(&self) -> usize {
        self.active
    }

    /// One examination of the detector bank: place, refresh or release notches.
    fn examine(&mut self) {
        let loudest = |x: &[f32; BANDS]| {
            let mut best = 0usize;
            for i in 0..BANDS {
                if x[i] > x[best] {
                    best = i;
                }
            }
            best
        };
        let levels: [f32; BANDS] = core::array::from_fn(|i| self.ms[i].max(0.0).sqrt());
        // A band that already carries a notch is skipped when looking for the next howl: otherwise the
        // loudest one is refreshed forever and a second howl is never addressed (the detector sees the
        // un-notched input, so the first howl stays loudest). With every band taken, refresh as usual.
        let mut taken = [false; BANDS];
        for s in 0..SLOTS {
            if self.slot_hold[s] <= 0.0 {
                continue;
            }
            let mut near = (f32::INFINITY, 0usize);
            for (b, hz) in self.centre.iter().enumerate() {
                let d = (self.slot_hz[s] / hz).ln().abs();
                if d < near.0 {
                    near = (d, b);
                }
            }
            // A howl excites its neighbours too (the bands are 0.31 octave apart and a narrow peak
            // straddles two), so the occupied stretch is the band and one either side — otherwise the
            // search simply notches the neighbouring band as a second "howl".
            taken[near.1] = true;
            if near.1 > 0 {
                taken[near.1 - 1] = true;
            }
            if near.1 + 1 < BANDS {
                taken[near.1 + 1] = true;
            }
        }
        let free = (0..BANDS).filter(|b| !taken[*b]);
        let top = if free.clone().next().is_some() {
            free.max_by(|a, b| levels[*a].partial_cmp(&levels[*b]).unwrap())
                .unwrap()
        } else {
            loudest(&levels)
        };
        // Median of a copy (a fixed stack array: no allocation on the audio thread).
        let mut sorted = levels;
        for i in 1..BANDS {
            let mut j = i;
            while j > 0 && sorted[j - 1] > sorted[j] {
                sorted.swap(j - 1, j);
                j -= 1;
            }
        }
        let median = sorted[BANDS / 2];
        let above = levels[top] > median * db_to_lin(self.s[1].value()) + 1e-9;

        if above && levels[top] > AUDIBLE {
            // A peak that straddles two detectors flips which of them is loudest between ticks; that
            // is still one howl, so a neighbouring band counts as the same candidate.
            let near =
                self.candidate != usize::MAX && (top as isize - self.candidate as isize).abs() <= 1;
            if near {
                self.candidate_ticks += 1;
            } else {
                self.candidate_ticks = 1;
            }
            self.candidate = top;
        } else {
            self.candidate = usize::MAX;
            self.candidate_ticks = 0;
        }

        let allowed = self.s[0].value().round().clamp(0.0, SLOTS as f32) as usize;
        // The hold is counted in examinations, not samples: it is decremented once per examination.
        let hold = self.s[3].value() * self.sr / EXAMINE_EVERY as f32;

        if self.candidate_ticks >= PERSIST_TICKS {
            // The howl is rarely on a band centre: interpolate between the top band and its louder
            // neighbour (a parabola through the three levels, in log frequency), or the notch lands
            // beside the howl and leaves it alive.
            let hz = self.interpolate(top, &levels);
            // Refresh the slot already aimed here, or take a free one.
            let existing = (0..allowed)
                .find(|s| self.slot_hold[*s] > 0.0 && (self.slot_hz[*s] / hz - 1.0).abs() < 0.05);
            let slot = existing.or_else(|| (0..allowed).find(|s| self.slot_hold[*s] == 0.0));
            if let Some(slot) = slot {
                let changed =
                    self.slot_hold[slot] == 0.0 || (self.slot_hz[slot] / hz - 1.0).abs() > 1e-3;
                self.slot_hz[slot] = hz;
                self.slot_hold[slot] = hold;
                self.last_hz = hz;
                if changed {
                    self.update();
                }
            }
        }

        // Age the slots; a notch whose howl is gone releases when its hold runs out.
        for slot in 0..SLOTS {
            if self.slot_hold[slot] > 0.0 {
                self.slot_hold[slot] -= 1.0;
                if self.slot_hold[slot] <= 0.0 {
                    self.slot_hold[slot] = 0.0;
                    self.slot_hz[slot] = 0.0;
                }
            }
        }
        let before = self.active;
        self.active = (0..allowed).filter(|s| self.slot_hold[*s] > 0.0).count();
        // A slot was freed (or the limit changed): rebuild the identity filters.
        if self.active != before && self.active < before {
            self.update();
        }
    }

    /// Parabolic peak interpolation across three bands, clamped to the middle band's span.
    fn interpolate(&self, top: usize, levels: &[f32; BANDS]) -> f32 {
        if top == 0 || top + 1 == BANDS {
            return self.centre[top];
        }
        let (y1, y2, y3) = (levels[top - 1], levels[top], levels[top + 1]);
        let denom = y1 - 2.0 * y2 + y3;
        if denom.abs() < 1e-12 {
            return self.centre[top];
        }
        let d = (0.5 * (y1 - y3) / denom).clamp(-0.5, 0.5);
        self.centre[top] * (self.centre[top + 1] / self.centre[top]).powf(d)
    }

    /// Magnitude response of the placed notches at `freq`, in dB (the tests and the UI curve).
    pub fn response_db(&self, freq: f32) -> f32 {
        if self.active == 0 {
            return 0.0;
        }
        let m: f32 = (0..SLOTS)
            .filter(|s| self.slot_hold[*s] > 0.0)
            .map(|s| self.notch[s][0].coefs().magnitude(freq, self.sr))
            .product();
        20.0 * m.max(1e-9).log10()
    }
}

impl Processor for Feedback {
    fn specs(&self) -> &'static [ParamSpec] {
        SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, SPECS, i, v) {
            if i == 4 {
                self.mix.set(v);
            } else {
                self.s[i].set(v);
                self.update();
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let len = l.len().min(r.len());
        // Without this a parameter change is stored as a target that nothing ever advances, so
        // `depth`, `sensitivity`, `notches` and `hold` would silently stay at their defaults.
        for s in &mut self.s {
            s.advance(len as u32);
        }
        for i in 0..len {
            let (a, b) = (l[i], r[i]);
            let mono = 0.5 * (a + b);
            // The bank runs at the full rate: feeding the filters one sample in 128 would sample a
            // 1 kHz tone at 375 Hz, i.e. above their Nyquist, and every band level would be an
            // alias of something else. Only the *decision* is decimated.
            for (m, level) in self.ms.iter_mut().zip(self.det.iter_mut()) {
                let y = level.tick(mono);
                let x2 = y * y;
                *m += (x2 - *m) * if x2 > *m { DETECT_UP } else { DETECT_DOWN };
            }
            if self.countdown == 0 {
                self.countdown = EXAMINE_EVERY;
                self.examine();
            }
            self.countdown -= 1;
            let (mut x, mut y) = (a, b);
            for slot in self.notch.iter_mut() {
                x = slot[0].tick(x);
                y = slot[1].tick(y);
            }
            let m = self.mix.next();
            l[i] = a + m * (x - a);
            r[i] = b + m * (y - b);
        }
    }
    fn reset(&mut self) {
        for b in &mut self.det {
            b.reset();
        }
        self.ms = [0.0; BANDS];
        for slot in &mut self.notch {
            for b in slot {
                b.reset();
            }
        }
        self.slot_hz = [0.0; SLOTS];
        self.slot_hold = [0.0; SLOTS];
        self.active = 0;
        self.last_hz = 0.0;
        self.candidate = usize::MAX;
        self.candidate_ticks = 0;
        self.countdown = EXAMINE_EVERY;
    }
    fn gain_reduction_db(&self) -> f32 {
        -self.s[2].value() * self.active.min(1) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine};

    /// Deterministic broadband noise (a poor man's music: no isolated band).
    fn noise(n: usize, level: f32) -> Vec<f32> {
        let mut s = 1u32;
        let mut raw: Vec<f32> = (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 23) as f32 - 1.0
            })
            .collect();
        let k = level / rms(&raw).max(1e-9);
        for v in raw.iter_mut() {
            *v *= k;
        }
        raw
    }

    /// A sustained tone standing alone is exactly what the detector is for: it gets a notch.
    #[test]
    fn a_howling_tone_is_notched() {
        let mut f = Feedback::new(48000.0);
        let mut l = sine(1000.0, 48000.0, 48000, 0.3);
        let mut r = l.clone();
        let head = 12000;
        f.process(&mut l[..head], &mut r[..head]);
        assert_eq!(f.active_notches(), 1, "one tone, one notch");
        let hz = f.notch_hz();
        assert!(
            (hz / 1000.0 - 1.0).abs() < 0.15,
            "the notch is at {hz:.0} Hz, not 1 kHz"
        );
        assert!(
            f.response_db(1000.0) < -12.0,
            "the notch must be deep: {:.1} dB",
            f.response_db(1000.0)
        );
        // And it really attenuates the tone.
        f.process(&mut l[head..], &mut r[head..]);
        let after = rms(&l[head..]);
        assert!(
            after < 0.3 * 0.4,
            "1 kHz came out at {after:.4} against 0.3 in"
        );
    }

    /// After the howl goes quiet, the notch releases and the chain is flat again.
    #[test]
    fn the_notch_releases_after_its_hold() {
        let mut f = Feedback::new(48000.0);
        f.set_param(3, 0.5); // a short hold, so the test does not need ten seconds
        let mut l = sine(2000.0, 48000.0, 24000, 0.3);
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        assert_eq!(f.active_notches(), 1);

        // Silence for longer than the hold.
        let mut quiet = vec![0.0f32; 48000];
        let mut r = quiet.clone();
        f.process(&mut quiet, &mut r);
        assert_eq!(f.active_notches(), 0, "the notch must let go");
        assert!(
            f.response_db(2000.0).abs() < 0.01,
            "and the path is flat again"
        );
    }

    /// Broadband material is not touched: no band stands alone, so nothing is notched.
    #[test]
    fn music_is_not_notched() {
        let mut f = Feedback::new(48000.0);
        let mut l = noise(48000, 0.05);
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        assert_eq!(f.active_notches(), 0, "noise must not be treated as a howl");
        let after = rms(&l[24000..]);
        assert!(
            (after / 0.05 - 1.0).abs() < 0.05,
            "broadband level changed: {after:.4} against 0.05"
        );
    }

    /// The slot count is a limit, not advice: one slot takes the loudest howl only, two take both.
    #[test]
    fn the_notch_count_is_respected() {
        // Two howls at once, far enough apart that each is its own band.
        let two_howls = || -> (Vec<f32>, Vec<f32>) {
            let n = 96000;
            let l: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / 48000.0;
                    (core::f32::consts::TAU * 800.0 * t).sin() * 0.3
                        + (core::f32::consts::TAU * 3150.0 * t).sin() * 0.22
                })
                .collect();
            (l.clone(), l)
        };
        let run = |slots: f32| {
            let mut f = Feedback::new(48000.0);
            f.set_param(0, slots);
            let (mut l, mut r) = two_howls();
            f.process(&mut l, &mut r);
            f.active_notches()
        };
        assert_eq!(run(1.0), 1, "the limit must hold at one");
        assert_eq!(run(4.0), 2, "with room for four, both howls are notched");
    }

    /// An idle suppressor is the identity: no colour when nothing is howling.
    #[test]
    fn idle_is_flat_and_silence_stays_silent() {
        let f = Feedback::new(48000.0);
        for hz in [200.0f32, 1000.0, 4000.0, 8000.0] {
            assert!(f.response_db(hz).abs() < 1e-6, "{hz} Hz is not flat");
        }
        let mut f = Feedback::new(48000.0);
        let mut l = vec![0.0f32; 96000];
        let mut r = l.clone();
        f.process(&mut l, &mut r);
        assert!(rms(&l) < 1e-9, "silence produced {}", rms(&l));
        assert_eq!(f.active_notches(), 0);
    }
}
