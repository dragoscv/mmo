//! Period-synchronous pitch shifter ("fast pitch mode") for a monophonic voice.
//!
//! Lag-domain TD-PSOLA. The output is a crossfade between two reads of the input delay line,
//! each at a lag that is constant for the life of its grain (nothing is resampled). A new grain
//! starts about every synthesis period `P = T / ratio` (`T` = input period) and its lag is the
//! previous lag plus `P - m*T`, with `m` in {0, 1, 2, ...} chosen so the lag stays in
//! `[BASE_LAG, BASE_LAG + T)`: grains are one input period apart in the input and one synthesis
//! period apart in the output, `m = 0` repeats a period, `m = 2` skips one.
//!
//! Every grain is the previous one delayed by one synthesis period, so on a periodic input the
//! output is periodic with `T / ratio`. Between two repeats/skips the lag moves by `T/ratio - T`
//! per `T/ratio` output samples, which reads the input at exactly `ratio` x real time whatever
//! the period estimate is; an estimate that is off only shows at the repeat or skip.
//!
//! Three things are decided per grain from the newest period of input:
//!
//! * **Pulse alignment.** A voice is one pulse per period. Where the grains sit relative to the
//!   pulse decides whether neighbouring harmonics add or cancel in the output (version 1,
//!   measured: -4.2 dB at 330 Hz x 1.25 and 4 dB of spread over the onset phase at
//!   110 Hz x 1.06). The energy centre of the newest period (circular mean of `x^2`: the time
//!   at which neighbouring harmonics are in phase on average) says where the pulse of the
//!   current grain is, and the length of the crossfade is moved so that the next grain is at
//!   full weight when its pulse arrives. The lag advance stays nominal, so the pitch does not
//!   depend on it. A pure tone has no energy centre (`x^2` has no first harmonic): nothing
//!   is moved.
//! * **Window.** The two grains crossfade over the whole fade with weights that sum to one.
//!   On tone-like input the dip that two out-of-phase copies leave is filled by a power
//!   normalisation (a pure tone keeps its envelope). On pulse-like input that gain is left out:
//!   it would lift whatever lies between the pulses (measured on the voice fixture at
//!   880 Hz x 1.25: +12.3 dB in 2..5 kHz with it, +5.8 dB without, the old shifter +6.0 dB).
//!   How pulse-like the input is comes from how concentrated its energy is within the period
//!   ([`PsolaShifter::concentration`]).
//!   Below ratio 0.8 a grain of two synthesis periods would also play the neighbouring input
//!   periods (calculated weight cos²(π/2 · ratio): −20 dB at 0.8, −9 dB at 0.6; measured at
//!   0.5: the output is the unshifted input), so there the window turns into the classic
//!   PSOLA one: two INPUT periods long, with a gap between grains (blended in from 0.8,
//!   complete from 0.7 down).
//! * **Level.** Pitch-shifting a line spectrum changes its power (more or fewer pulses per
//!   second, harmonics landing elsewhere on the formants). The power of each output period is
//!   measured against the power of the input period it was made of, and a slow trim brings it
//!   back (-3 dB .. +2 dB, and never so far that the output peak passes the input peak by
//!   0.8 dB).
//!
//! Nothing is read ahead of the newest sample. The delay is [`BASE_LAG`] (one sample) until
//! the first correction and moves through one period while a correction is applied (see
//! [`PsolaShifter::delay`]). When the correction ends on a held note the lag stays where it is
//! (going back would cost one crossfade between two copies of the voice that are out of
//! phase); it goes back to one sample after 30 ms of unvoiced input, or when the caller asks
//! ([`PsolaShifter::settle`]).
//!
//! Dry tap: there is no fixed delay to compensate. While the delay is `latency()` the output
//! at ratio 1 is the input one sample ago, so a dry tap delayed by `latency()` is aligned.
//! After a correction on a held note the output at ratio 1 is the input `delay()` samples ago
//! (a whole number): a caller that mixes dry and wet reads its dry tap that far back, or calls
//! `settle()` first. During a correction the wet signal is at another pitch and no delay
//! aligns it with the dry one.
//!
//! The period comes from the caller ([`PsolaShifter::set_period`], e.g. the YIN detector every
//! 128 samples) and is tracked on the newest audio at every grain start: the period of the
//! previous grain keeps the lock while it still matches (a detector that is an octave or 10 %
//! off for a few blocks does not move it); otherwise the hint, half and double the hint are
//! tried, then a search over the whole range, and a shorter period that matches as well is
//! preferred. Only dips of the squared difference count: a lag that is short against the
//! signal's own period matches any smooth signal. A parabolic vertex gives the fraction.

use core::f32::consts::{PI, SQRT_2, TAU};

/// Smallest lag of a read tap: the 4-point interpolation of a fractional lag needs one sample
/// after the read point. It is the whole delay of the signal path at ratio 1 after a reset.
pub const BASE_LAG: usize = 1;
/// Lowest voice the buffers are sized for (Hz): the detector's floor.
const MIN_HZ: f32 = 70.0;
/// Shortest period accepted: half the detector's ceiling (1200 Hz), so an octave-high hint can
/// still be halved by the octave check.
const MAX_HZ: f32 = 2400.0;
/// Most terms in one squared-difference / correlation sum. The sums span one period; a longer
/// period is covered with a stride.
const CORR_TERMS: usize = 384;
/// The refinement looks for the period within this fraction of the hint...
const SEARCH: f32 = 0.12;
/// ...and within this fraction of the period it tracked itself one grain ago.
const OWN_SEARCH: f32 = 0.04;
/// The tracked period is taken without looking further when it matches this well and the hint
/// is within `AGREE` of it.
const OWN_GOOD: f32 = 0.03;
const AGREE: f32 = 0.06;
/// A candidate period is good when its squared difference is at most `GOOD_MUL` × the best
/// candidate's + `GOOD_ADD`, with that bar held between `GOOD_ABS` and `WIDE_ABOVE` (any
/// multiple of the period matches as well as the period, so "the best" alone cannot tell them
/// apart: the shortest good one is taken; a period that is too long only costs delay, one
/// that is too short is not a period, hence the upper bound of the bar).
const GOOD_ABS: f32 = 0.05;
const GOOD_MUL: f32 = 1.25;
const GOOD_ADD: f32 = 0.005;
/// The tracked period keeps the lock while it is good, or while its squared difference is at
/// most this multiple of the best candidate's (plus `STICKY_ADD`).
const STICKY_MUL: f32 = 2.0;
const STICKY_ADD: f32 = 0.01;
/// When no candidate matches better than this, the whole range is searched (at most once per
/// longest period).
const WIDE_ABOVE: f32 = 0.15;
/// A refined period that matches worse than this is not trusted: the hint is used as it is.
const TRUST_BELOW: f32 = 0.6;
/// A ratio closer to 1 than this (0.17 cents) is treated as exactly 1: nothing is shifted.
const UNITY: f32 = 1e-4;
/// Upper bound of the crossfade power normalisation (+3 dB).
const GAIN_MAX: f32 = SQRT_2;
/// Entries of the raised-cosine crossfade table.
const WIN_N: usize = 1024;
/// Pulse alignment fades in between these concentrations of the energy within the period
/// (see `energy_centre`; a pure tone gives about 0).
const ALIGN_LO: f32 = 0.03;
const ALIGN_HI: f32 = 0.08;
/// The input counts as tone-like below `PULSE_LO` and as pulse-like above `PULSE_HI`
/// (concentration of the energy within the period), with a linear blend between. Measured:
/// pure tones 0.000–0.001, the voice fixture 0.37 (330–880 Hz) to 0.80 (82 Hz).
const PULSE_LO: f32 = 0.10;
const PULSE_HI: f32 = 0.30;
/// Bounds of one crossfade length in synthesis periods: the alignment may shorten or lengthen a
/// fade this far; a larger misalignment is taken up over the following grains.
const FADE_MIN: f32 = 0.5;
const FADE_MAX: f32 = 1.5;
/// Range of the level trim (-3 dB .. +2 dB)...
const TRIM_MIN: f32 = 0.708;
const TRIM_MAX: f32 = 1.26;
/// ...and its ceiling from the peaks: trimmed output peak ≤ this × the input peak (+0.8 dB).
const PEAK_ROOM: f32 = 1.10;
/// Share of a new level measurement taken into the trim goal per grain.
const TRIM_RATE: f32 = 0.25;
/// Per-sample step by which the trim returns to exactly 1 when one tap plays.
const TRIM_RELAX: f32 = 0.0005;
/// Unvoiced for this long (seconds): the lag goes home...
const HOME_HOLD_S: f32 = 0.03;
/// ...with one crossfade of this length (seconds).
const HOME_FADE_S: f32 = 0.005;
/// Length in samples of the crossfade that moves a fractional lag to the nearest whole one
/// when a correction ends (the two taps are at most half a sample apart).
const ROUND_FADE: f32 = 64.0;
/// Input samples are limited to ± this (120 dB above full scale). The sums of squares over a
/// period then stay far inside the f32 range, so no input can produce a NaN or a panic.
const INPUT_MAX: f32 = 1.0e6;
/// The window of two input periods (see the module docs) is blended in below `GAP_FROM` and
/// complete from `GAP_FULL` down. At `GAP_FROM` and above nothing changes.
const GAP_FROM: f32 = 0.8;
const GAP_FULL: f32 = 0.7;

/// Period-synchronous shifter for a monophonic voice. Mono, allocation-free after `new`.
pub struct PsolaShifter {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
    /// cos²(π/2 · i / WIN_N), i = 0..=WIN_N: weight of the grain fading out.
    win: Vec<f32>,
    ratio: f32,
    /// Caller's period hint in samples, 0 = unvoiced.
    hint: f32,
    /// Refined period the last grain was built on.
    period: f32,
    /// `period` was measured on audio at the last grain start (not copied from the hint).
    tracking: bool,
    min_t: f32,
    max_t: f32,
    /// Lag of the grain fading out / fading in (samples behind the newest input sample).
    lag_a: f32,
    lag_b: f32,
    /// One tap plays (`lag_b`): no crossfade is running.
    same: bool,
    /// Grains are running (voiced).
    active: bool,
    /// Position in the current crossfade, 0..1, advancing by `inc` = 1 / fade length.
    ph: f32,
    inc: f32,
    /// Normalised correlation of the two taps, for the crossfade power normalisation.
    rho: f32,
    /// Normalised squared difference at the refined period (0 = perfectly periodic).
    quality: f32,
    /// Concentration of the energy within the period at the last grain start (0..1).
    conc: f32,
    /// How pulse-like the input is, 0..1 (smoothed `conc` between PULSE_LO and PULSE_HI).
    pulse: f32,
    /// Share of the power normalisation in this fade ((1 − `pulse`) × (1 − `gap`)).
    fill: f32,
    /// Share of the two-input-period window in this fade: 0 at ratio 0.8 and above, 1 from
    /// ratio 0.7 down.
    gap: f32,
    /// Fade length / input period, at least 1: how much shorter than the fade the slopes of
    /// the two-input-period window are.
    stretch: f32,
    /// Level trim: current, goal, and of the running fade the sum of squares, the number of
    /// samples and the peak of the untrimmed output.
    trim: f32,
    trim_goal: f32,
    acc_y: f32,
    acc_n: f32,
    acc_pk: f32,
    /// Samples since the last search over the whole period range.
    since_wide: u32,
    /// Samples of unvoiced input with the lag away from home; the hold; the home fade in
    /// samples.
    idle: u32,
    hold: u32,
    home_len: f32,
}

impl PsolaShifter {
    /// Buffers are sized for a 70 Hz voice at `sample_rate` (44.1 / 48 / 96 kHz and above).
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate.is_finite() && sample_rate >= 8000.0 {
            sample_rate.min(768_000.0)
        } else {
            48000.0
        };
        let max_t = sr / MIN_HZ;
        // Oldest sample read: the period search compares the newest period (at most `max_t`
        // samples) with the one up to 1.12 × `max_t` earlier; a tap is at most BASE_LAG + one
        // period back and the coherence sum spans one period from there.
        let need = (2.2 * max_t) as usize + 64;
        let size = need.next_power_of_two().max(1024);
        let win = (0..=WIN_N)
            .map(|i| {
                let c = (0.5 * PI * i as f32 / WIN_N as f32).cos();
                c * c
            })
            .collect();
        Self {
            buf: vec![0.0; size],
            mask: size - 1,
            w: 0,
            win,
            ratio: 1.0,
            hint: 0.0,
            period: max_t,
            tracking: false,
            min_t: (sr / MAX_HZ).max(8.0),
            max_t,
            lag_a: BASE_LAG as f32,
            lag_b: BASE_LAG as f32,
            same: true,
            active: false,
            ph: 0.0,
            inc: 1.0 / max_t,
            rho: 1.0,
            quality: 1.0,
            conc: 0.0,
            pulse: 0.0,
            fill: 1.0,
            gap: 0.0,
            stretch: 1.0,
            trim: 1.0,
            trim_goal: 1.0,
            acc_y: 0.0,
            acc_n: 0.0,
            acc_pk: 0.0,
            since_wide: u32::MAX,
            idle: 0,
            hold: (HOME_HOLD_S * sr) as u32,
            home_len: (HOME_FADE_S * sr).max(16.0),
        }
    }

    /// Output pitch = input pitch × `ratio` (0.25..4). Takes effect at the next grain, at most
    /// 1.5 synthesis periods later. Non-finite values count as 1, and so does a ratio within
    /// 0.17 cents of 1. Measured from 0.5 to 2; the level stays within 1 dB from 0.75 to 2 and
    /// falls below that (−2.7 dB at 0.5 on the voice fixture). Not measured outside 0.5..2.
    pub fn set_ratio(&mut self, ratio: f32) {
        self.ratio = if ratio.is_finite() && (ratio - 1.0).abs() >= UNITY {
            ratio.clamp(0.25, 4.0)
        } else {
            1.0
        };
    }

    /// The ratio set by [`Self::set_ratio`].
    pub fn ratio(&self) -> f32 {
        self.ratio
    }

    /// The detector's current estimate of the input period in samples (0 = unvoiced). Call
    /// whenever a new estimate exists (the detector's quantum, 128 samples in `tune.rs`);
    /// between calls the last one is used. Values outside 70–2400 Hz are folded by octaves into
    /// that range (twice the period of a 110 Hz voice lands on the period), negative and
    /// non-finite ones count as unvoiced.
    pub fn set_period(&mut self, samples: f32) {
        self.hint = if samples.is_finite() && samples > 0.0 {
            let mut h = samples;
            let mut n = 0;
            while h > self.max_t && n < 64 {
                h *= 0.5;
                n += 1;
            }
            while h < self.min_t && n < 128 {
                h *= 2.0;
                n += 1;
            }
            h.clamp(self.min_t, self.max_t)
        } else {
            0.0
        };
    }

    /// Period in samples the last grain was built on: the hint refined on the newest audio.
    pub fn period(&self) -> f32 {
        self.period
    }

    /// Normalised squared difference of the input one refined period apart, measured at the
    /// last grain start: 0 = perfectly periodic, 1 = uncorrelated. Not updated while there is
    /// nothing to shift (ratio 1 or unvoiced).
    pub fn quality(&self) -> f32 {
        self.quality
    }

    /// How concentrated the energy of the newest period was at the last grain start, 0..1
    /// (|circular mean of x²| / Σx²): 0.000–0.001 on pure tones, 0.37–0.80 on the voice
    /// fixture (the lower the pitch, the higher). Telemetry: pulse alignment, the power
    /// normalisation and the level trim follow it.
    pub fn concentration(&self) -> f32 {
        self.conc
    }

    /// Level trim applied right now (linear gain, 0.708..1.26; exactly 1 at ratio 1).
    /// Telemetry.
    pub fn level_trim(&self) -> f32 {
        self.trim
    }

    /// Current delay of the signal path in samples: the lag of the grain that carries most of
    /// the output right now. `latency()` ≤ `delay()` ≤ `latency()` + one period. It moves while
    /// a correction is applied (by `T/ratio − T` per grain, and by a whole period when a period
    /// is repeated or skipped). At ratio 1 on voiced input it stays where the correction left
    /// it (a whole number of samples: the output is the input, delayed by `delay()`). After
    /// 30 ms of unvoiced input, or on [`Self::settle`], it goes back to `latency()` with one
    /// crossfade.
    pub fn delay(&self) -> f32 {
        if !self.same && self.ph < 0.5 {
            self.lag_a
        } else {
            self.lag_b
        }
    }

    /// Smallest delay of the signal path in samples, [`BASE_LAG`] (1 sample): the delay after
    /// a reset until the first correction, on unvoiced input (from 35 ms after the voice
    /// stopped) and after [`Self::settle`]. During and after a correction the delay is
    /// `latency()` plus up to one period of the voice, see [`Self::delay`].
    pub fn latency(&self) -> usize {
        BASE_LAG
    }

    /// Largest value [`Self::delay`] can take, in samples: `latency()` + the longest period
    /// (70 Hz).
    pub fn max_delay(&self) -> usize {
        BASE_LAG + self.max_t.ceil() as usize
    }

    /// Bring the delay back to `latency()` now, with one crossfade (one period of the voice
    /// long, 5 ms when unvoiced). Does nothing while a correction is running (ratio ≠ 1 on
    /// voiced input) or when the delay is already `latency()`. On a held note the two copies
    /// are out of phase, so that one period is not the input (it is a blend of two copies of
    /// it): call it when that matters less than the delay, e.g. before mixing with a dry tap.
    pub fn settle(&mut self) {
        if !self.active && self.same && self.lag_b != BASE_LAG as f32 {
            let len = self.hint.max(self.home_len);
            self.tracking = false;
            self.fade_to(BASE_LAG as f32, len);
        }
    }

    /// Back to the just-built state (ratio and buffers included). Allocation-free.
    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.w = 0;
        self.ratio = 1.0;
        self.hint = 0.0;
        self.period = self.max_t;
        self.tracking = false;
        self.lag_a = BASE_LAG as f32;
        self.lag_b = BASE_LAG as f32;
        self.same = true;
        self.active = false;
        self.ph = 0.0;
        self.inc = 1.0 / self.max_t;
        self.rho = 1.0;
        self.quality = 1.0;
        self.conc = 0.0;
        self.pulse = 0.0;
        self.fill = 1.0;
        self.gap = 0.0;
        self.stretch = 1.0;
        self.trim = 1.0;
        self.trim_goal = 1.0;
        self.acc_y = 0.0;
        self.acc_n = 0.0;
        self.acc_pk = 0.0;
        self.since_wide = u32::MAX;
        self.idle = 0;
    }

    /// One sample in, one sample out. Allocation-free, never panics; a non-finite input sample
    /// is replaced by 0, a finite one is limited to ±1e6 (120 dB above full scale).
    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let x = if x.is_finite() {
            x.clamp(-INPUT_MAX, INPUT_MAX)
        } else {
            0.0
        };
        self.buf[self.w] = x;
        self.w = (self.w + 1) & self.mask;
        self.since_wide = self.since_wide.saturating_add(1);
        // Something to shift: a period to work on and a ratio that is not 1.
        let shift = self.hint > 0.0 && self.ratio != 1.0;
        if self.active {
            self.ph += self.inc;
            if self.ph >= 1.0 {
                if shift {
                    self.ph = (self.ph - 1.0).min(0.999);
                    self.launch();
                } else {
                    // The fade is complete and there is nothing left to shift: one tap from
                    // here on. A fractional lag moves to the nearest whole one (at most half a
                    // sample, one more fade), so that the output becomes the input, delayed.
                    self.active = false;
                    self.one_tap();
                    let whole = self.lag_b.round().max(BASE_LAG as f32);
                    if whole != self.lag_b {
                        self.fade_to(whole, ROUND_FADE);
                    }
                }
            }
        } else if !self.same {
            // On the way to a whole lag or home.
            self.ph += self.inc;
            if self.ph >= 1.0 {
                self.one_tap();
            }
        } else if shift {
            self.active = true;
            self.idle = 0;
            self.ph = 0.0;
            self.launch();
        } else if self.hint > 0.0 || self.lag_b == BASE_LAG as f32 {
            self.idle = 0;
        } else {
            // Unvoiced with the lag away from home: hold (the detector may only have blinked),
            // then one plain crossfade to the home lag.
            self.idle = self.idle.saturating_add(1);
            if self.idle >= self.hold {
                self.tracking = false;
                self.fade_to(BASE_LAG as f32, self.home_len);
            }
        }
        if self.same {
            // One tap. The level trim lets go; once it is 1 the output is the input, delayed.
            if self.trim != 1.0 {
                let d = 1.0 - self.trim;
                self.trim = if d.abs() <= TRIM_RELAX {
                    1.0
                } else {
                    self.trim + TRIM_RELAX.copysign(d)
                };
            }
            return self.trim * self.read(self.lag_b);
        }
        // Weights that sum to one over the whole fade...
        let wc = self.win_at(self.ph);
        let (mut wa, mut wb) = (wc, 1.0 - wc);
        if self.gap > 0.0 {
            // ...blended with the classic window: slopes one INPUT period long, a gap between.
            let ga = self.win_at(self.ph * self.stretch);
            let gb = self.win_at((1.0 - self.ph) * self.stretch);
            wa += self.gap * (ga - wa);
            wb += self.gap * (gb - wb);
        }
        // Power normalisation: two taps that correlate by `rho` sum to
        // wa² + wb² + 2·wa·wb·rho of the input power; bring that back to 1.
        // Never by more than 3 dB, and never so far that one tap alone comes out above its
        // input level. Applied in full to tone-like input, not at all to pulse-like input.
        let p = wa * wa + wb * wb + 2.0 * wa * wb * self.rho;
        let cap = GAIN_MAX.min(1.0 / wa.max(wb).max(1e-6)).max(1.0);
        let g = (1.0 / p.max(0.25).sqrt()).clamp(1.0, cap);
        let g = 1.0 + self.fill * (g - 1.0);
        let (a, b) = (self.read(self.lag_a), self.read(self.lag_b));
        let y = g * (wa * a + wb * b);
        // Level bookkeeping of this fade (see `launch`).
        self.acc_y += y * y;
        self.acc_n += 1.0;
        self.acc_pk = self.acc_pk.max(y.abs());
        self.trim += 0.5 * self.inc * (self.trim_goal - self.trim);
        self.trim * y
    }

    /// One tap from here on (`lag_b`).
    fn one_tap(&mut self) {
        self.same = true;
        self.lag_a = self.lag_b;
        self.idle = 0;
        self.fill = 1.0;
        self.gap = 0.0;
        self.stretch = 1.0;
        self.trim_goal = 1.0;
        self.acc_y = 0.0;
        self.acc_n = 0.0;
        self.acc_pk = 0.0;
    }

    /// One plain crossfade of `len` samples from the current lag to `lag`; one tap afterwards.
    fn fade_to(&mut self, lag: f32, len: f32) {
        self.lag_a = self.lag_b;
        self.lag_b = lag;
        self.active = false;
        self.same = false;
        self.ph = 0.0;
        self.inc = 1.0 / len.max(2.0);
        self.rho = self.coherence();
        self.fill = 1.0;
        self.gap = 0.0;
        self.stretch = 1.0;
        self.trim_goal = 1.0;
    }

    /// cos²(π/2 · u) for u in 0..=1, from the table.
    #[inline]
    fn win_at(&self, u: f32) -> f32 {
        let pos = u.clamp(0.0, 1.0) * WIN_N as f32;
        let i = (pos as usize).min(WIN_N - 1);
        self.win[i] + (pos - i as f32) * (self.win[i + 1] - self.win[i])
    }

    /// Start the next grain: track the period, place the new lag, set the crossfade length and
    /// the window.
    fn launch(&mut self) {
        let lo = BASE_LAG as f32;
        self.refine();
        let t = self.period;
        let ps = t / self.ratio;
        // Nominal advance P − m·T, folded into [lo, lo + T).
        let lag = lo + (self.lag_b + ps - t - lo).rem_euclid(t);
        self.lag_a = self.lag_b;
        self.lag_b = lag.clamp(lo, lo + t);
        let (c, conc) = self.energy_centre(t);
        self.conc = conc;
        let k = ((conc - ALIGN_LO) / (ALIGN_HI - ALIGN_LO)).clamp(0.0, 1.0);
        // Level: the mean power of the fade that just ended (one output period) against the
        // mean power of the input period it ended on (the period up to the tap of the grain
        // that is at full weight now). Tone-like input (k = 0) needs none.
        if self.acc_n >= 1.0 {
            let p_out = self.acc_y / self.acc_n;
            let (p_in, pk_in) = self.power_peak(self.lag_a, t);
            if p_out > 1e-12 && p_in > 1e-12 {
                let ceil = (PEAK_ROOM * pk_in / self.acc_pk.max(1e-9)).clamp(TRIM_MIN, TRIM_MAX);
                let m = (p_in / p_out).sqrt().clamp(TRIM_MIN, ceil);
                self.trim_goal += TRIM_RATE * (1.0 + k * (m - 1.0) - self.trim_goal);
            }
        }
        self.acc_y = 0.0;
        self.acc_n = 0.0;
        self.acc_pk = 0.0;
        // Fade length: one synthesis period, moved so that this fade ends when the pulse of
        // the grain fading in arrives. The grain at full weight now (`lag_a`) shows the energy
        // centre `d` samples from now; the next grain shows it one synthesis period later.
        let mut fade = ps;
        if k > 0.0 {
            let mut d = (self.lag_a - c).rem_euclid(t);
            if d > 0.5 * t {
                d -= t;
            }
            fade = (ps + k * d).clamp(FADE_MIN * ps, FADE_MAX * ps);
        }
        let fade = fade.max(2.0);
        self.inc = 1.0 / fade;
        // Tone-like or pulse-like: how much of the power normalisation this fade gets.
        let pulse = ((conc - PULSE_LO) / (PULSE_HI - PULSE_LO)).clamp(0.0, 1.0);
        self.pulse += 0.5 * (pulse - self.pulse);
        // Large down-shifts: the window of two input periods. No normalisation there: outside
        // the overlap it would only fatten the slopes.
        self.gap = ((GAP_FROM - self.ratio) / (GAP_FROM - GAP_FULL)).clamp(0.0, 1.0);
        self.stretch = (fade / t).max(1.0);
        self.fill = (1.0 - self.pulse) * (1.0 - self.gap);
        // Two grains at the same lag are one tap, unless the window leaves a gap between them
        // (at ratio 1/2 the lag does not move, yet every second period has to go).
        self.same = (self.lag_a - self.lag_b).abs() < 1e-4 && self.gap == 0.0;
        self.rho = if self.same { 1.0 } else { self.coherence() };
    }

    /// 4-point Hermite read `lag` samples behind the newest input sample (exact for whole lags).
    #[inline]
    fn read(&self, lag: f32) -> f32 {
        let m = self.mask;
        let whole = lag as usize;
        let f = lag - whole as f32;
        // Newest sample is at w − 1; `i0` is the sample at or after the read point.
        let i0 = self.w.wrapping_sub(1).wrapping_sub(whole) & m;
        if f == 0.0 {
            return self.buf[i0];
        }
        // Read point = i0 − f: between i0 − 1 (older) and i0.
        let xm1 = self.buf[i0.wrapping_sub(2) & m];
        let x0 = self.buf[i0.wrapping_sub(1) & m];
        let x1 = self.buf[i0];
        let x2 = self.buf[(i0 + 1) & m];
        let u = 1.0 - f;
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * u + c2) * u + c1) * u + x0
    }

    /// Normalised squared difference between the newest `win` samples (every `win.1`-th of
    /// `win.0`) and the ones `tau` earlier: 0 = identical, 1 = uncorrelated, 2 = inverted.
    fn diff(&self, tau: usize, win: (usize, usize)) -> f32 {
        let m = self.mask;
        let newest = self.w.wrapping_sub(1);
        let (mut d, mut e) = (0.0f32, 0.0f32);
        let mut n = 0;
        while n < win.0 {
            let i = newest.wrapping_sub(n);
            n += win.1;
            let a = self.buf[i & m];
            let b = self.buf[i.wrapping_sub(tau) & m];
            d += (a - b) * (a - b);
            e += a * a + b * b;
        }
        if e < 1e-12 { 1.0 } else { d / e }
    }

    /// Whole lag with the smallest `diff` within ±`spread` of `center` (every second lag, then
    /// the two neighbours of the best), and that difference.
    fn best_near(&self, center: f32, spread: f32, win: (usize, usize)) -> (usize, f32) {
        let lo = ((center * (1.0 - spread)).floor() as usize).max(2);
        let hi = ((center * (1.0 + spread)).ceil() as usize).max(lo);
        let mut best = (lo, f32::INFINITY);
        let mut tau = lo;
        while tau <= hi {
            let d = self.diff(tau, win);
            if d < best.1 {
                best = (tau, d);
            }
            tau += 2;
        }
        for t in [best.0 - 1, best.0 + 1] {
            if (lo..=hi).contains(&t) {
                let d = self.diff(t, win);
                if d < best.1 {
                    best = (t, d);
                }
            }
        }
        best
    }

    /// `best_near` as a dip: `None` when the minimum sits on an edge of the range and the
    /// difference keeps falling outside it. A lag that is short against the signal's own
    /// period matches any smooth signal (calculated: a 110 Hz tone differs from itself
    /// 20 samples earlier by 1 − cos(2π·20/436) = 0.04), so a small difference alone is not a
    /// period.
    fn dip_near(&self, center: f32, spread: f32, win: (usize, usize)) -> Option<(usize, f32)> {
        let lo = ((center * (1.0 - spread)).floor() as usize).max(2);
        let hi = ((center * (1.0 + spread)).ceil() as usize).max(lo);
        let r = self.best_near(center, spread, win);
        if r.0 <= lo && lo > 2 && self.diff(lo - 1, win) < r.1 {
            return None;
        }
        if r.0 >= hi && self.diff(hi + 1, win) < r.1 {
            return None;
        }
        Some(r)
    }

    /// Nothing to lock on (noise, silence, a transition): the hint is used as it is.
    fn untracked(&mut self, quality: f32) {
        self.quality = quality;
        self.period = self.hint;
        self.tracking = false;
    }

    /// Track the period on the newest audio into `self.period`: the period of the last grain
    /// while it still matches; else the shortest good one of the caller's hint, its half and
    /// its double; else a search over the whole range; then a half or a third of the result if
    /// that is good too.
    fn refine(&mut self) {
        let h = self.hint;
        let mut own = self.tracking;
        if own {
            let win = Self::span(self.period);
            if let Some((tau, d)) = self.dip_near(self.period, OWN_SEARCH, win)
                && d <= OWN_GOOD
                && (h - tau as f32).abs() <= AGREE * tau as f32
            {
                self.lock(tau, d, win);
                return;
            }
        }
        let mut cand = [(0.0f32, 0.0f32); 4];
        let mut n = 0;
        if own {
            cand[n] = (self.period, OWN_SEARCH);
            n += 1;
        }
        cand[n] = (h, SEARCH);
        n += 1;
        if h * 0.5 >= self.min_t {
            cand[n] = (h * 0.5, 0.5 * SEARCH);
            n += 1;
        }
        if h * 2.0 <= self.max_t {
            cand[n] = (h * 2.0, 0.5 * SEARCH);
            n += 1;
        }
        // One window for every candidate (the differences are normalised, so they compare):
        // one period of the longest one, so that it holds a pulse whichever is right.
        let longest = cand[..n].iter().fold(0.0f32, |m, c| m.max(c.0));
        let mut win = Self::span(longest);
        let mut res: [Option<(usize, f32)>; 4] = [None; 4];
        let mut d_min = f32::INFINITY;
        for i in 0..n {
            res[i] = self.dip_near(cand[i].0, cand[i].1, win);
            if let Some(r) = res[i] {
                d_min = d_min.min(r.1);
            }
        }
        // Nothing matches: the hint is wrong in a way its half and double do not cover (at low
        // pitch the detector's window is shorter than the period and it reports multiples of a
        // formant period). Look everywhere.
        if d_min > WIDE_ABOVE && self.since_wide as f32 >= self.max_t {
            self.since_wide = 0;
            let wide_win = Self::span(self.max_t);
            if let Some(r) = self.wide(wide_win)
                && r.1 < 0.5 * d_min
            {
                res[0] = Some(r);
                n = 1;
                own = false;
                d_min = r.1;
                win = wide_win;
            }
        }
        if !d_min.is_finite() {
            self.untracked(1.0);
            return;
        }
        // The bar for "good"; the best candidate itself always passes it.
        let good = (GOOD_MUL * d_min + GOOD_ADD)
            .clamp(GOOD_ABS, WIDE_ABOVE)
            .max(d_min);
        // The tracked period keeps the lock while it matches; else the shortest good one.
        let mut best = (usize::MAX, f32::INFINITY);
        match res[0] {
            Some(r) if own && r.1 <= good.max(STICKY_MUL * d_min + STICKY_ADD) => best = r,
            _ => {
                for r in res[..n].iter().flatten() {
                    if r.1 <= good && r.0 < best.0 {
                        best = *r;
                    }
                }
            }
        }
        if best.1 > TRUST_BELOW {
            self.untracked(best.1.min(2.0));
            return;
        }
        // Two or three periods match as well as one: take the one. The bar is set once, before
        // the loop, and capped: it does not grow with the candidates accepted on the way.
        //
        // The cap is a behavioural choice, not decoration: measured on a 200 Hz tone with noise at
        // the signal's own amplitude, removing it changes the period this tracker reports by a
        // factor of two (484.2 against 238.0 for a true 240) and the output checksum by 0.3 %, on
        // one noise sequence and not on another. Which of the two is better on a noisy stage was
        // not measured, so no test pins the cap; `noise_is_not_locked_as_a_period` pins the trust
        // check above it instead.
        let limit = (GOOD_MUL * best.1 + GOOD_ADD).clamp(GOOD_ABS, WIDE_ABOVE);
        for _ in 0..3 {
            let mut changed = false;
            for div in [2.0f32, 3.0] {
                let c = best.0 as f32 / div;
                if c < self.min_t {
                    continue;
                }
                if let Some(r) = self.dip_near(c, 0.04, win)
                    && r.1 <= limit
                {
                    best = r;
                    changed = true;
                    break;
                }
            }
            if !changed {
                break;
            }
        }
        self.lock(best.0, best.1, win);
    }

    /// Take `tau` (squared difference `d` over `win`) as the period, with the fraction from a
    /// parabolic vertex through its two neighbours.
    fn lock(&mut self, tau: usize, d: f32, win: (usize, usize)) {
        let tau = tau.max(2);
        let dm = self.diff(tau - 1, win);
        let dp = self.diff(tau + 1, win);
        let den = dm - 2.0 * d + dp;
        let frac = if den > 1e-9 {
            (0.5 * (dm - dp) / den).clamp(-1.0, 1.0)
        } else {
            0.0
        };
        self.quality = d;
        self.period = (tau as f32 + frac).clamp(self.min_t, self.max_t);
        self.tracking = true;
    }

    /// The deepest dip of `diff` over the whole period range (every 2nd lag below 64, every
    /// 4th above; a dip = a grid point the curve fell into and rises from; then the
    /// neighbours of the best), and its difference. `None` when the curve has no dip.
    fn wide(&self, win: (usize, usize)) -> Option<(usize, f32)> {
        let lo = (self.min_t as usize).max(2);
        // A few lags past the longest period, so that a dip at the top of the range is seen
        // rising again (`lock` clamps the period).
        let hi = (self.max_t as usize).max(lo) + 8;
        let mut best: Option<(usize, f32)> = None;
        let (mut prev_tau, mut prev) = (lo, self.diff(lo, win));
        let mut falling = false;
        let mut tau = lo + 2;
        while tau <= hi {
            let d = self.diff(tau, win);
            if falling && d >= prev && best.is_none_or(|b| prev < b.1) {
                best = Some((prev_tau, prev));
            }
            falling = d < prev;
            prev = d;
            prev_tau = tau;
            tau += if tau < 64 { 2 } else { 4 };
        }
        let (c, mut bd) = best?;
        let mut bt = c;
        for t in c.saturating_sub(3).max(lo)..=(c + 3).min(hi) {
            let d = self.diff(t, win);
            if d < bd {
                bd = d;
                bt = t;
            }
        }
        Some((bt, bd))
    }

    /// The newest `t` samples (one period, the fraction of the last sample included): the
    /// position of the energy centre in samples behind the newest sample (`0 ≤ c < t`) and its
    /// concentration |Σ x² e^{jθi}| / Σ x² with θ = 2π/t (1 = one sample carries everything,
    /// about 0 = spread evenly, or a pure tone, whose x² has no first harmonic). For a
    /// periodic signal the centre is the time at which neighbouring harmonics are in phase on
    /// average (energy-weighted group delay).
    fn energy_centre(&self, t: f32) -> (f32, f32) {
        let m = self.mask;
        let newest = self.w.wrapping_sub(1);
        let n = (t as usize).max(4);
        let frac = (t - n as f32).clamp(0.0, 1.0);
        let (sn, cs) = (TAU / t).sin_cos();
        let (mut cr, mut ci) = (1.0f32, 0.0f32);
        let (mut re, mut im, mut tot) = (0.0f32, 0.0f32, 0.0f32);
        for i in 0..=n {
            let x = self.buf[newest.wrapping_sub(i) & m];
            let wgt = if i == n { frac } else { 1.0 };
            let e = wgt * x * x;
            re += e * cr;
            im += e * ci;
            tot += e;
            let next = cr * cs - ci * sn;
            ci = cr * sn + ci * cs;
            cr = next;
        }
        if tot < 1e-30 {
            return (0.0, 0.0);
        }
        let conc = ((re * re + im * im).sqrt() / tot).min(1.0);
        let c = (im.atan2(re) / TAU * t).rem_euclid(t);
        (c, conc)
    }

    /// Mean power and peak of the `t` input samples that end `lag` samples behind the newest
    /// one (the fraction of the last sample included).
    fn power_peak(&self, lag: f32, t: f32) -> (f32, f32) {
        let m = self.mask;
        let start = self.w.wrapping_sub(1).wrapping_sub(lag.round() as usize);
        let n = (t as usize).max(4);
        let frac = (t - n as f32).clamp(0.0, 1.0);
        let (mut pw, mut pk) = (0.0f32, 0.0f32);
        for i in 0..n {
            let x = self.buf[start.wrapping_sub(i) & m];
            pw += x * x;
            pk = pk.max(x.abs());
        }
        let x = self.buf[start.wrapping_sub(n) & m];
        pw += frac * x * x;
        (pw / (n as f32 + frac), pk)
    }

    /// Window of a sum over one period of `period` samples: (length, stride).
    fn span(period: f32) -> (usize, usize) {
        let len = (period as usize).max(16);
        (len, len.div_ceil(CORR_TERMS))
    }

    /// Normalised correlation of the input at the two taps (whole lags) over the newest
    /// period; 1 when either side is silent.
    fn coherence(&self) -> f32 {
        let m = self.mask;
        let newest = self.w.wrapping_sub(1);
        let (ia, ib) = (self.lag_a.round() as usize, self.lag_b.round() as usize);
        let win = Self::span(self.period);
        let (mut ab, mut aa, mut bb) = (0.0f32, 0.0f32, 0.0f32);
        let mut n = 0;
        while n < win.0 {
            let i = newest.wrapping_sub(n);
            n += win.1;
            let a = self.buf[i.wrapping_sub(ia) & m];
            let b = self.buf[i.wrapping_sub(ib) & m];
            ab += a * b;
            aa += a * a;
            bb += b * b;
        }
        if aa < 1e-12 || bb < 1e-12 {
            1.0
        } else {
            (ab / (aa * bb).sqrt()).clamp(-1.0, 1.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pitch::Yin;
    use crate::test_util::{rms, sine, voice};

    const SR: f32 = 48000.0;

    /// Nothing matches well enough on noise, so the hint is used as it is: nothing may be locked.
    ///
    /// The search starts from the hint, so a missing trust check would lock a period that is *close*
    /// to it - which is why this is asserted on the reported `period`, not on the output: measured
    /// with the check removed, the reported period became 531.94 for a hint of 360 (and the output
    /// checksum changed by 9 %), while the code with the check reports the hint itself.
    #[test]
    fn noise_is_not_locked_as_a_period() {
        // Deterministic pseudo-noise: a plain LCG, so the test is the same on every run.
        let mut seed = 12_345u32;
        let noise = |seed: &mut u32| {
            *seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            ((*seed >> 8) as f32 / (1 << 24) as f32) * 2.0 - 1.0
        };
        let mut s = PsolaShifter::new(SR);
        s.set_ratio(1.03); // non-unity, so the period search runs at all
        let hint = 240.0;
        s.set_period(hint);
        let mut peak_in = 0.0f32;
        let mut peak_out = 0.0f32;
        for k in 0..48_000 {
            let x = 0.3 * noise(&mut seed);
            // The detector hands a new estimate every 128 samples, as `tune.rs` does.
            if k % 128 == 64 {
                s.set_period(hint);
            }
            peak_in = peak_in.max(x.abs());
            peak_out = peak_out.max(s.tick(x).abs());
        }
        assert_eq!(
            s.period(),
            hint,
            "the hint must be used as it is when nothing matches: reported {:.4}",
            s.period()
        );
        assert!(
            s.quality() > 0.6,
            "the fixture must not accidentally be periodic: quality {:.4}",
            s.quality()
        );
        // And nothing blows up on a signal with no period at all.
        assert!(
            peak_out < 1.5 * peak_in,
            "noise came out at {peak_out:.4} from {peak_in:.4}"
        );
    }

    /// Frequency of a clean tone from its rising zero crossings (linear interpolation).
    fn zero_cross_freq(x: &[f32]) -> f32 {
        let (mut first, mut last, mut n) = (None, 0.0f64, 0u32);
        for i in 1..x.len() {
            if x[i - 1] < 0.0 && x[i] >= 0.0 {
                let t = (i - 1) as f64 + f64::from(-x[i - 1]) / f64::from(x[i] - x[i - 1]);
                first.get_or_insert(t);
                last = t;
                n += 1;
            }
        }
        (f64::from(n.saturating_sub(1)) * f64::from(SR) / (last - first.unwrap_or(0.0))) as f32
    }

    /// Hann-windowed magnitude at one frequency.
    fn mag(x: &[f32], f: f64) -> f64 {
        let n = x.len() as f64;
        let (mut re, mut im) = (0.0f64, 0.0f64);
        let step = core::f64::consts::TAU * f / f64::from(SR);
        for (i, v) in x.iter().enumerate() {
            let w = 0.5 - 0.5 * (core::f64::consts::TAU * i as f64 / n).cos();
            let ph = step * i as f64;
            re += f64::from(*v) * w * ph.cos();
            im -= f64::from(*v) * w * ph.sin();
        }
        (re * re + im * im).sqrt()
    }

    /// Spectral peak within ±1 % of `guess` (golden-section search on the magnitude).
    fn spectral_peak(x: &[f32], guess: f32) -> f32 {
        let guess = f64::from(guess);
        let (mut a, mut b) = (guess * 0.99, guess * 1.01);
        let g = 0.618_033_988_75;
        let (mut c, mut d) = (b - g * (b - a), a + g * (b - a));
        let (mut fc, mut fd) = (mag(x, c), mag(x, d));
        for _ in 0..24 {
            if fc > fd {
                b = d;
                d = c;
                fd = fc;
                c = b - g * (b - a);
                fc = mag(x, c);
            } else {
                a = c;
                c = d;
                fc = fd;
                d = a + g * (b - a);
                fd = mag(x, d);
            }
        }
        (0.5 * (a + b)) as f32
    }

    fn cents(f: f32, want: f32) -> f32 {
        1200.0 * (f / want).log2()
    }

    fn db(a: f32, b: f32) -> f32 {
        20.0 * (a.max(1e-12) / b.max(1e-12)).log10()
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
    }

    fn max_step(x: &[f32]) -> f32 {
        x.windows(2).fold(0.0f32, |m, w| m.max((w[1] - w[0]).abs()))
    }

    /// The shifter over `x` with the exact period `SR / f0` given once up front.
    fn run_exact(x: &[f32], f0: f32, ratio: f32) -> Vec<f32> {
        let mut s = PsolaShifter::new(SR);
        s.set_ratio(ratio);
        s.set_period(SR / f0);
        x.iter().map(|v| s.tick(*v)).collect()
    }

    /// The shifter with the period from a `Yin` detector every 128 samples, the way `tune.rs`
    /// drives its shifter (detection first, then the 128 samples it is used for). Returns the
    /// output and `delay()` after every sample.
    fn run_yin(x: &[f32], ratio: f32) -> (Vec<f32>, Vec<f32>) {
        let mut s = PsolaShifter::new(SR);
        let mut yin = Yin::new(SR);
        s.set_ratio(ratio);
        let mut out = Vec::with_capacity(x.len());
        let mut lag = Vec::with_capacity(x.len());
        for (i, v) in x.iter().enumerate() {
            if i % 128 == 0 {
                let p = yin.detect();
                s.set_period(if p.voiced() { SR / p.frequency } else { 0.0 });
            }
            yin.push(*v);
            out.push(s.tick(*v));
            lag.push(s.delay());
        }
        (out, lag)
    }

    /// Both estimators on the steady part of a tone, in cents against `want`.
    fn tone_cents(y: &[f32], want: f32) -> (f32, f32) {
        let tail = &y[12000..];
        (
            cents(zero_cross_freq(tail), want),
            cents(spectral_peak(&tail[..16384], want), want),
        )
    }

    /// Requirement 1 on pure tones, low notes included, with the exact period and with the
    /// detector's: both estimators within 3 cents of f0 × ratio and of each other.
    #[test]
    fn pitch_is_within_three_cents_on_tones() {
        let mut worst = (0.0f32, 0.0f32, 0.0f32, "");
        for f0 in [82.0f32, 110.0, 220.0, 880.0] {
            let x = sine(f0, SR, 36000, 0.5);
            for ratio in [0.8f32, 0.94, 0.99, 1.01, 1.06, 1.25] {
                let want = f0 * ratio;
                let runs = [
                    ("exact", run_exact(&x, f0, ratio)),
                    ("yin", run_yin(&x, ratio).0),
                ];
                for (mode, y) in &runs {
                    let (zc, sp) = tone_cents(y, want);
                    assert!(
                        (zc - sp).abs() < 1.0,
                        "{mode} f0 {f0} ratio {ratio}: estimators disagree {zc:+.2} / {sp:+.2}"
                    );
                    let e = zc.abs().max(sp.abs());
                    if e > worst.2 {
                        worst = (f0, ratio, e, mode);
                    }
                }
            }
        }
        println!("measured: tones, worst of both estimators {worst:?} (f0, ratio, cents, mode)");
        assert!(worst.2 < 3.0, "worst: {worst:?} (f0, ratio, cents, mode)");
    }

    /// The old `Shifter` loses small corrections at 110 Hz (its ignored test
    /// `shifter_applies_small_corrections_at_110_hz`: ratio 0.99 / 1.01 comes out at the input
    /// pitch). Same signal, same estimator, same points.
    #[test]
    fn applies_small_corrections_at_110_hz() {
        let x = sine(110.0, SR, 4 * 48000, 0.5);
        let mut worst = 0.0f32;
        for ratio in [0.98f32, 0.99, 1.01, 1.02] {
            for (mode, y) in [
                ("exact", run_exact(&x, 110.0, ratio)),
                ("yin", run_yin(&x, ratio).0),
            ] {
                let c = cents(zero_cross_freq(&y[48000..]), 110.0 * ratio);
                worst = worst.max(c.abs());
                assert!(c.abs() < 0.5, "{mode} 110 Hz ratio {ratio}: {c:+.2} cents");
            }
        }
        println!("measured: 110 Hz tone, ratios 0.98..1.02, worst {worst:.3} cents");
    }

    /// Requirement 1 on the harmonic voice fixture, 82 Hz included: the first two harmonics of
    /// the output, found as spectral peaks, sit within 3 cents of the target.
    #[test]
    fn pitch_is_within_three_cents_on_the_voice_fixture() {
        let mut worst = 0.0f32;
        for f0 in [82.0f32, 110.0, 220.0] {
            let x = voice(f0, 0.0, SR, 36000, 0.25);
            for ratio in [0.94f32, 0.99, 1.01, 1.06] {
                let want = f0 * ratio;
                let runs = [
                    ("exact", run_exact(&x, f0, ratio)),
                    ("yin", run_yin(&x, ratio).0),
                ];
                for (mode, y) in &runs {
                    let tail = &y[12000..12000 + 16384];
                    let h1 = cents(spectral_peak(tail, want), want);
                    let h2 = cents(spectral_peak(tail, 2.0 * want), 2.0 * want);
                    worst = worst.max(h1.abs()).max(h2.abs());
                    assert!(
                        h1.abs() < 3.0 && h2.abs() < 3.0,
                        "{mode} voice f0 {f0} ratio {ratio}: h1 {h1:+.2} h2 {h2:+.2} cents"
                    );
                }
            }
        }
        println!("measured: voice fixture, harmonics 1 and 2, worst {worst:.2} cents");
    }

    /// Requirement 2: at ratio 1 the output IS the input delayed by `latency()`, sample for
    /// sample, on a tone and on the voice fixture, exact period or detector.
    #[test]
    fn transparent_at_ratio_one() {
        let lat = PsolaShifter::new(SR).latency();
        for (name, x) in [
            ("tone", sine(110.0, SR, 24000, 0.5)),
            ("voice", voice(220.0, 40.0, SR, 24000, 0.25)),
        ] {
            let runs = [
                ("exact", run_exact(&x, 110.0, 1.0)),
                ("yin", run_yin(&x, 1.0).0),
            ];
            for (mode, y) in &runs {
                for n in lat..x.len() {
                    assert_eq!(y[n], x[n - lat], "{name}/{mode} sample {n}");
                }
            }
        }
    }

    /// Lag (0..=max) of the largest cross-correlation of `y` against `x` over the last `n`
    /// samples.
    fn measured_delay(x: &[f32], y: &[f32], max: usize, n: usize) -> usize {
        let end = x.len().min(y.len());
        let mut best = (0usize, f32::NEG_INFINITY);
        for lag in 0..=max {
            let mut c = 0.0f32;
            for i in end - n..end {
                c += y[i] * x[i - lag];
            }
            if c > best.1 {
                best = (lag, c);
            }
        }
        best.0
    }

    /// A tone gliding up one octave per second from `f_start`: samples and the frequency at
    /// every sample.
    fn glide(f_start: f32, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut phase = 0.0f64;
        let mut x = Vec::with_capacity(n);
        let mut f = Vec::with_capacity(n);
        for i in 0..n {
            let fi = f_start * 2f32.powf(i as f32 / SR);
            phase += core::f64::consts::TAU * f64::from(fi) / f64::from(SR);
            x.push((0.5 * phase.sin()) as f32);
            f.push(fi);
        }
        (x, f)
    }

    /// A tone with ±`depth` cents of 5.5 Hz vibrato around `f0`: samples and frequency.
    fn vibrato(f0: f32, depth: f32, n: usize) -> (Vec<f32>, Vec<f32>) {
        let mut phase = 0.0f64;
        let mut x = Vec::with_capacity(n);
        let mut f = Vec::with_capacity(n);
        for i in 0..n {
            let m = (core::f32::consts::TAU * 5.5 * i as f32 / SR).sin();
            let fi = f0 * 2f32.powf(depth * m / 1200.0);
            phase += core::f64::consts::TAU * f64::from(fi) / f64::from(SR);
            x.push((0.5 * phase.sin()) as f32);
            f.push(fi);
        }
        (x, f)
    }

    /// Requirement 3: the delay is `latency()` at ratio 1 after a reset (measured by
    /// cross-correlation), `delay()` stays within one period above it during a correction and
    /// tells the truth afterwards (cross-correlation on a glide, which has one peak only), and
    /// it is back at `latency()` after unvoiced input.
    #[test]
    fn delay_is_stated_truthfully() {
        let (x, f) = glide(150.0, 96000);
        let mut s = PsolaShifter::new(SR);
        let mut yin = Yin::new(SR);
        let lat = s.latency();
        let mut y = vec![0.0f32; x.len()];
        let mut moved = 0.0f32;
        for i in 0..x.len() {
            if i % 128 == 0 {
                let p = yin.detect();
                let voiced = p.voiced() && i < 60000;
                s.set_period(if voiced { SR / p.frequency } else { 0.0 });
            }
            match i {
                24000 => s.set_ratio(0.94),
                36000 => s.set_ratio(1.0),
                _ => {}
            }
            yin.push(x[i]);
            y[i] = s.tick(x[i]);
            if i == 23999 {
                assert_eq!(measured_delay(&x[..=i], &y[..=i], 400, 4096), lat);
                assert_eq!(s.delay(), lat as f32);
            }
            if (24000..36000).contains(&i) {
                let period = SR / f[i];
                // The period shrinks during the glide and the older grain was placed up to two
                // synthesis periods ago: allow the period of 20 ms earlier.
                let bound = lat as f32 + SR / f[i - 960] + 1.0;
                assert!(
                    s.delay() >= lat as f32 && s.delay() <= bound,
                    "sample {i}: delay {} with a period of {period}",
                    s.delay()
                );
                moved = moved.max(s.delay() - lat as f32);
            }
            if i == 47999 {
                // Ratio 1 again for 250 ms: a pure delay of `delay()` samples.
                let d = measured_delay(&x[..=i], &y[..=i], 400, 4096);
                assert!(
                    (d as f32 - s.delay()).abs() <= 0.5,
                    "measured {d}, delay() says {}",
                    s.delay()
                );
            }
        }
        assert!(moved > 20.0, "the correction never moved the lag ({moved})");
        // 750 ms unvoiced: home again, and the output is the input `latency()` samples ago.
        assert_eq!(s.delay(), lat as f32);
        for n in 90000..x.len() {
            assert_eq!(y[n], x[n - lat]);
        }
    }

    /// Requirement 4: RMS within ±1 dB of the input, no sample more than 1 dB above the input
    /// peak, on tones and on the voice fixture, at all seven pitches of the measurement grid.
    #[test]
    fn level_stays_within_one_db() {
        let (mut lo, mut hi, mut pk_hi) = (0.0f32, 0.0f32, f32::NEG_INFINITY);
        for f0 in [82.0f32, 110.0, 147.0, 220.0, 330.0, 440.0, 880.0] {
            for (name, x) in [
                ("tone", sine(f0, SR, 24000, 0.5)),
                ("voice", voice(f0, 20.0, SR, 24000, 0.25)),
            ] {
                let (xr, xp) = (rms(&x[9600..]), peak(&x));
                for ratio in [0.8f32, 0.9, 0.98, 1.02, 1.12, 1.25] {
                    let y = run_exact(&x, f0, ratio);
                    let lvl = db(rms(&y[9600..]), xr);
                    let pk = db(peak(&y[2400..]), xp);
                    lo = lo.min(lvl);
                    hi = hi.max(lvl);
                    pk_hi = pk_hi.max(pk);
                    assert!(
                        lvl.abs() <= 1.0,
                        "{name} f0 {f0} ratio {ratio}: {lvl:+.2} dB rms"
                    );
                    assert!(pk <= 1.0, "{name} f0 {f0} ratio {ratio}: peak {pk:+.2} dB");
                }
            }
        }
        println!("measured: level {lo:+.2}..{hi:+.2} dB rms, highest peak {pk_hi:+.2} dB");
    }

    /// The level must not depend on where in the period the grains happen to start. Version 1
    /// (no pulse alignment) measured −3.98..−0.02 dB over eight onset phases at 110 Hz × 1.06.
    /// Here voicing starts k/8 of a period after 0.25 s, k = 0..7, and the output level from
    /// 0.75 s on is compared (the measurement harness, ONSET PHASE, shows a spread of 0.01 dB
    /// at these three points).
    #[test]
    fn level_does_not_depend_on_the_onset_phase() {
        for (f0, ratio) in [(110.0f32, 1.06f32), (110.0, 1.25), (220.0, 0.8)] {
            let x = voice(f0, 0.0, SR, 72000, 0.25);
            let xr = rms(&x[36000..]);
            let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
            for k in 0..8 {
                let start = 12000 + (k as f32 * SR / f0 / 8.0) as usize;
                let mut s = PsolaShifter::new(SR);
                s.set_ratio(ratio);
                let mut y = Vec::with_capacity(x.len());
                for (i, v) in x.iter().enumerate() {
                    if i == start {
                        s.set_period(SR / f0);
                    }
                    y.push(s.tick(*v));
                }
                let lvl = db(rms(&y[36000..]), xr);
                lo = lo.min(lvl);
                hi = hi.max(lvl);
            }
            println!(
                "measured: voice {f0} Hz x {ratio}: {lo:+.3}..{hi:+.3} dB over 8 onset phases"
            );
            assert!(
                hi - lo < 0.25,
                "voice f0 {f0} ratio {ratio}: {lo:+.2}..{hi:+.2} dB over 8 onset phases"
            );
        }
    }

    /// Requirement 5: unvoiced input passes at `latency()`, switching between voiced and
    /// unvoiced adds no step the signal would not make itself, silence drains to exact zeros
    /// and a NaN does not poison the state.
    #[test]
    fn unvoiced_silence_and_nan_are_handled() {
        let lat = PsolaShifter::new(SR).latency();
        let x = voice(150.0, 30.0, SR, 48000, 0.25);
        let period = SR / 150.0;
        let mut s = PsolaShifter::new(SR);
        s.set_ratio(1.03);
        let mut y = vec![0.0f32; x.len()];
        for (i, v) in x.iter().enumerate() {
            // Voiced / unvoiced every 100 ms.
            if i % 4800 == 0 {
                s.set_period(if (i / 4800) % 2 == 0 { period } else { 0.0 });
            }
            y[i] = s.tick(*v);
        }
        // NaN and infinity count as a zero sample: same output as a run that was fed the zero.
        let run = |bad: f32| -> Vec<f32> {
            let mut s = PsolaShifter::new(SR);
            s.set_ratio(1.03);
            s.set_period(period);
            x[..12000]
                .iter()
                .enumerate()
                .map(|(i, v)| s.tick(if i == 6000 || i == 6100 { bad } else { *v }))
                .collect()
        };
        let clean = run(0.0);
        assert!(clean.iter().all(|v| v.is_finite()));
        assert_eq!(run(f32::NAN), clean);
        assert_eq!(run(f32::NEG_INFINITY), clean);
        // A crossfade of two delayed copies moves by at most the gain times the input's own
        // largest step, plus the distance between the copies (≤ 2 × peak) times the window
        // slope (π/2 per fade; the shortest fade is FADE_MIN synthesis periods, and the 5 ms
        // fade home is longer than that here).
        let fade = FADE_MIN * period / 1.03;
        let bound = TRIM_MAX * GAIN_MAX * (max_step(&x) + 2.0 * peak(&x) * 0.5 * PI / fade);
        let step = max_step(&y[lat..]);
        assert!(step <= bound, "step {step} > bound {bound}");
        // Unvoiced from the start: a pure delay, whatever the ratio.
        let mut s = PsolaShifter::new(SR);
        s.set_ratio(0.9);
        for (i, v) in x.iter().enumerate() {
            let o = s.tick(*v);
            if i >= lat {
                assert_eq!(o, x[i - lat]);
            }
        }
        // Silence after a phrase: exact zeros once the longest lag has passed.
        let mut s = PsolaShifter::new(SR);
        s.set_period(period);
        s.set_ratio(1.05);
        for v in &x {
            s.tick(*v);
        }
        for i in 0..4096 {
            let o = s.tick(0.0);
            if i > s.max_delay() + 8 {
                assert_eq!(o, 0.0, "sample {i} after the phrase");
            }
        }
    }

    /// Interpolated times of the rising zero crossings of `x`.
    fn crossings(x: &[f32]) -> Vec<f64> {
        let mut t = Vec::new();
        for i in 1..x.len() {
            if x[i - 1] < 0.0 && x[i] >= 0.0 {
                t.push((i - 1) as f64 + f64::from(-x[i - 1]) / f64::from(x[i] - x[i - 1]));
            }
        }
        t
    }

    /// Pitch error in cents of `y` over `from..to` against `ratio` × the input pitch, for an
    /// input whose frequency at every sample is `f` and an output that is the input
    /// `lag[n]` samples ago: cycles counted in the output between its first and last rising
    /// zero crossing, against the integral of `ratio · f(n − lag[n])` over the same span.
    fn tracking_cents(
        y: &[f32],
        f: &[f32],
        lag: &[f32],
        ratio: f32,
        from: usize,
        to: usize,
    ) -> f32 {
        let c = crossings(&y[from..to]);
        let (first, last) = (c[0] + from as f64, c[c.len() - 1] + from as f64);
        let mut want = 0.0f64;
        for n in first.ceil() as usize..last.ceil() as usize {
            let src = (n as f32 - lag[n]).max(0.0) as usize;
            want += f64::from(ratio * f[src]) / f64::from(SR);
        }
        (1200.0 * ((c.len() - 1) as f64 / want).log2()) as f32
    }

    /// Requirement 6: a glide of one octave per second and a ±50 cent 5.5 Hz vibrato, driven
    /// by the detector: sample-exact at ratio 1, within 2 cents of ratio × input pitch with a
    /// correction (every 250 ms window; the requirement is 5 cents, the measurement harness
    /// shows at most 1.08 cents).
    #[test]
    fn glide_and_vibrato_follow() {
        let n = 72000;
        for (name, (x, f)) in [
            ("glide", glide(150.0, n)),
            ("vibrato", vibrato(220.0, 50.0, n)),
        ] {
            let (y, _) = run_yin(&x, 1.0);
            for i in BASE_LAG..n {
                assert_eq!(y[i], x[i - BASE_LAG], "{name} ratio 1 sample {i}");
            }
            for ratio in [0.97f32, 1.03] {
                let (y, lag) = run_yin(&x, ratio);
                let mut worst = 0.0f32;
                for k in 1..n / 12000 {
                    let e = tracking_cents(&y, &f, &lag, ratio, k * 12000, (k + 1) * 12000);
                    worst = if e.abs() > worst.abs() { e } else { worst };
                }
                println!("measured: {name} ratio {ratio}: worst 250 ms window {worst:+.2} cents");
                assert!(worst.abs() < 2.0, "{name} ratio {ratio}: {worst:+.2} cents");
            }
        }
    }

    /// Requirement 7: a period hint an octave off (×2, ÷2) or 10 % off for 50 ms leaves the
    /// output finite and within +3 dB of the input level, the tracked period stays on the true
    /// one, and the pitch is right over the 341 ms that contain the bad hint.
    #[test]
    fn wrong_period_hints_stay_bounded_and_recover() {
        let f0 = 165.0f32;
        let t = SR / f0;
        for (sig, x) in [
            ("tone", sine(f0, SR, 60000, 0.5)),
            ("voice", voice(f0, 0.0, SR, 60000, 0.25)),
        ] {
            let (xr, xp) = (rms(&x[9600..]), peak(&x));
            for (name, bad) in [("x2", 2.0 * t), ("/2", 0.5 * t), ("+10%", 1.1 * t)] {
                let mut s = PsolaShifter::new(SR);
                s.set_ratio(1.06);
                s.set_period(t);
                let mut y = vec![0.0f32; x.len()];
                let mut off = 0.0f32;
                for (i, v) in x.iter().enumerate() {
                    match i {
                        24000 => s.set_period(bad),
                        26400 => s.set_period(t),
                        _ => {}
                    }
                    y[i] = s.tick(*v);
                    if (24000..26400).contains(&i) {
                        off = off.max((s.period() / t - 1.0).abs());
                    }
                }
                assert!(y.iter().all(|v| v.is_finite()));
                assert!(
                    off < 0.02,
                    "{sig} {name}: the tracked period left the true one by {:.1} %",
                    100.0 * off
                );
                let during = &y[24000..28800];
                let (lvl, pk) = (db(rms(during), xr), db(peak(during), xp));
                assert!(
                    lvl < 3.0 && lvl > -3.0 && pk < 3.0,
                    "{sig} {name}: {lvl:+.2} dB rms, {pk:+.2} dB peak"
                );
                let want = f0 * 1.06;
                let sp = cents(spectral_peak(&y[20000..20000 + 16384], want), want);
                println!(
                    "measured: {sig} hint {name}: period off {:.2} %, {lvl:+.2} dB rms, \
                     {pk:+.2} dB peak, {sp:+.2} cents",
                    100.0 * off
                );
                assert!(sp.abs() < 3.0, "{sig} {name}: {sp:+.2} cents");
            }
        }
    }

    /// Requirement 7 on a low note: a hint that is far too short at the onset (a detector
    /// answering with a formant: 2000 Hz for the first 10 ms or 50 ms of an 82 Hz note) must
    /// not capture the period tracker. Any smooth signal matches itself at a short lag, so a
    /// small squared difference alone is not a period: only a dip counts.
    #[test]
    fn a_short_wrong_hint_at_the_onset_does_not_capture_a_low_note() {
        let f0 = 82.0f32;
        let t = SR / f0;
        for wrong_for in [480usize, 2400] {
            for (sig, x) in [
                ("tone", sine(f0, SR, 48000, 0.5)),
                ("voice", voice(f0, 0.0, SR, 48000, 0.25)),
            ] {
                let mut s = PsolaShifter::new(SR);
                s.set_ratio(1.06);
                s.set_period(SR / 2000.0);
                let mut y = vec![0.0f32; x.len()];
                for (i, v) in x.iter().enumerate() {
                    if i == wrong_for {
                        s.set_period(t);
                    }
                    y[i] = s.tick(*v);
                    if i >= 7200 {
                        let off = (s.period() / t - 1.0).abs();
                        assert!(
                            off < 0.02,
                            "{sig}, hint wrong for {wrong_for} samples, sample {i}: tracked \
                             period {} against {t}",
                            s.period()
                        );
                    }
                }
                let want = f0 * 1.06;
                let sp = cents(spectral_peak(&y[24000..24000 + 16384], want), want);
                println!("measured: {sig}, hint wrong for {wrong_for} samples: {sp:+.2} cents");
                assert!(
                    sp.abs() < 3.0,
                    "{sig}, hint wrong for {wrong_for} samples: {sp:+.2} cents"
                );
            }
        }
    }

    /// The trap behind the test above, on the function itself. A 110 Hz tone differs from
    /// itself 17 samples earlier by less than the bar for a good period, yet 17 samples is not
    /// its period: the difference keeps falling below the search range, and `dip_near` refuses
    /// the candidate. The true period is a dip and is accepted.
    #[test]
    fn a_lag_that_matches_only_because_the_signal_is_smooth_is_not_a_period() {
        let mut s = PsolaShifter::new(SR);
        for v in sine(110.0, SR, 4096, 0.5) {
            s.tick(v);
        }
        let t = SR / 110.0;
        let win = PsolaShifter::span(t);
        let (tau, d) = s.best_near(20.0, SEARCH, win);
        println!("measured: 110 Hz tone, lag {tau}: difference {d:.4} (bar {GOOD_ABS})");
        assert!(
            d < GOOD_ABS,
            "lag {tau}: difference {d}, not below the bar: the test lost its trap"
        );
        assert!(s.dip_near(20.0, SEARCH, win).is_none());
        let (tau, d) = s.dip_near(t, SEARCH, win).expect("the period is a dip");
        assert!(
            (tau as f32 - t).abs() <= 1.0 && d < 1e-3,
            "tau {tau}, d {d}"
        );
    }

    /// The crossfade's power normalisation is for tone-like input. On a pulse-like voice it
    /// lifts what lies between the pulses: at 880 Hz × 1.25 the measurement harness showed
    /// +12.3 dB in 2..5 kHz with it and +5.8 dB without (old `Shifter`: +6.0 dB; moving the
    /// harmonics under the formants changes the band by itself). Here: the power of the
    /// harmonics that fall in 2..5 kHz, output against input (1024-sample Hann frames), must
    /// not exceed what the old shifter does at the same point by more than 3 dB.
    #[test]
    fn high_band_of_a_high_voice_is_not_lifted() {
        let (f0, ratio) = (880.0f32, 1.25f32);
        let x = voice(f0, 0.0, SR, 36000, 0.25);
        let y = run_exact(&x, f0, ratio);
        let mut old = crate::pitch::Shifter::new(false);
        old.set_ratio(ratio);
        let y_old: Vec<f32> = x.iter().map(|v| old.tick(*v)).collect();
        let band = |s: &[f32], f: f32| -> f64 {
            let mut p = 0.0f64;
            for frame in s[12000..12000 + 16 * 1024].chunks(1024) {
                let mut k = 1.0f32;
                while k * f < 5000.0 {
                    if k * f >= 2000.0 {
                        let m = mag(frame, f64::from(k * f));
                        p += m * m;
                    }
                    k += 1.0;
                }
            }
            p
        };
        let db10 = |a: f64, b: f64| 10.0 * (a.max(1e-30) / b.max(1e-30)).log10();
        let rise = db10(band(&y, f0 * ratio), band(&x, f0));
        let rise_old = db10(band(&y_old, f0 * ratio), band(&x, f0));
        println!(
            "measured: harmonics in 2..5 kHz, new {rise:+.2} dB, old shifter {rise_old:+.2} dB"
        );
        assert!(
            rise < rise_old + 3.0,
            "harmonics in 2..5 kHz: {rise:+.2} dB against the input, old shifter {rise_old:+.2} dB"
        );
    }

    /// `settle()` brings the delay back to `latency()` on a held note after a correction, and
    /// from then on the output is the input one sample ago; without it the delay stays where
    /// the correction left it.
    #[test]
    fn settle_brings_the_delay_home() {
        let x = voice(196.0, 0.0, SR, 48000, 0.25);
        let t = SR / 196.0;
        for settle in [false, true] {
            let mut s = PsolaShifter::new(SR);
            s.set_period(t);
            s.set_ratio(0.97);
            let mut y = vec![0.0f32; x.len()];
            for (i, v) in x.iter().enumerate() {
                if i == 20000 {
                    s.set_ratio(1.0);
                }
                if i == 24000 {
                    assert!(s.delay() > 8.0, "the correction left no lag to settle");
                    if settle {
                        s.settle();
                    }
                }
                y[i] = s.tick(*v);
            }
            if settle {
                assert_eq!(s.delay(), BASE_LAG as f32);
                for n in 30000..x.len() {
                    assert_eq!(y[n], x[n - BASE_LAG], "sample {n}");
                }
            } else {
                let d = s.delay();
                assert!(d > 8.0 && d.fract() == 0.0, "delay {d}");
                for n in 30000..x.len() {
                    assert_eq!(y[n], x[n - d as usize], "sample {n}");
                }
            }
        }
    }

    /// Ratios below 0.8, which a transposition or a harmony voice can ask for: an octave down
    /// must contain the lower octave. With a window of two synthesis periods the lag does not
    /// move at ratio 0.5 and the output is the unshifted input (nothing at half the pitch); the
    /// window of two input periods puts it there. The bound only separates "there" from "not
    /// there"; the measured level is printed.
    #[test]
    fn an_octave_down_contains_the_lower_octave() {
        let f0 = 220.0f32;
        let x = voice(f0, 0.0, SR, 48000, 0.25);
        let y = run_exact(&x, f0, 0.5);
        let (xs, ys) = (&x[24000..24000 + 16384], &y[24000..24000 + 16384]);
        let want = 0.5 * f0;
        let f_out = spectral_peak(ys, want);
        let f_in = spectral_peak(xs, f0);
        let fund = 20.0 * (mag(ys, f64::from(f_out)) / mag(xs, f64::from(f_in))).log10();
        let c = cents(f_out, want);
        println!(
            "measured: voice 220 Hz x 0.5: fundamental {fund:+.1} dB against the input's, \
             {c:+.2} cents"
        );
        assert!(
            fund > -20.0,
            "level at half the pitch: {fund:+.1} dB against the input's fundamental"
        );
        assert!(c.abs() < 5.0, "{c:+.2} cents");
    }

    /// Requirement 8, "no panics on any input", for samples that are finite but absurd (1e30,
    /// f32::MAX): their squares overflow. Without the input limit the output of this test
    /// becomes NaN during the burst. With it the output stays finite and the shifter works
    /// again once the burst has left its buffer.
    #[test]
    fn huge_finite_input_does_not_poison_or_panic() {
        let f0 = 147.0f32;
        let x = voice(f0, 0.0, SR, 96000, 0.25);
        for huge in [1.0e30f32, f32::MAX, -f32::MAX] {
            let mut s = PsolaShifter::new(SR);
            s.set_ratio(1.06);
            s.set_period(SR / f0);
            let mut y = Vec::with_capacity(x.len());
            for (i, v) in x.iter().enumerate() {
                let burst = (24000..24600).contains(&i) && i % 7 != 0;
                let o = s.tick(if burst { huge } else { *v });
                assert!(o.is_finite(), "{huge:e}: sample {i} is {o}");
                y.push(o);
            }
            assert!(
                s.level_trim().is_finite(),
                "{huge:e}: the level trim is not finite"
            );
            let lvl = db(rms(&y[72000..]), rms(&x[72000..]));
            println!("measured: {huge:e} burst: {lvl:+.2} dB rms one second later");
            assert!(
                lvl.abs() < 1.0,
                "{huge:e}: {lvl:+.2} dB rms one second after the burst"
            );
        }
    }

    /// Requirement 8: no allocation in `tick` / `set_*` / `reset` at 44.1, 48 and 96 kHz with
    /// the longest period, no panic on hostile input, and `reset()` restores the initial state.
    #[test]
    fn does_not_allocate_and_resets() {
        for sr in [44100.0f32, 48000.0, 96000.0] {
            let x = voice(70.0, 20.0, sr, 8192, 0.3);
            let mut s = PsolaShifter::new(sr);
            let shifted = |s: &mut PsolaShifter| -> Vec<f32> {
                s.set_ratio(1.1);
                s.set_period(sr / 70.0);
                x.iter().map(|v| s.tick(*v)).collect()
            };
            let fresh = shifted(&mut s);
            assert!(fresh.iter().zip(&x).any(|(a, b)| (a - b).abs() > 0.01));
            assert_no_alloc::assert_no_alloc(|| {
                for ratio in [0.25f32, 0.8, 1.25, 4.0, f32::NAN, -1.0] {
                    s.set_ratio(ratio);
                    for (i, v) in x.iter().enumerate() {
                        if i % 128 == 0 {
                            let hint = [sr / 70.0, 1.0, 1e9, f32::NAN, -5.0, sr / 2400.0];
                            s.set_period(hint[(i / 128) % hint.len()]);
                        }
                        let v = if i % 1000 == 999 { f32::INFINITY } else { *v };
                        assert!(s.tick(v).is_finite());
                    }
                    s.set_period(0.0);
                    for v in &x {
                        let _ = s.tick(*v);
                    }
                }
                s.reset();
            });
            assert_eq!((s.ratio(), s.delay()), (1.0, BASE_LAG as f32));
            let again = shifted(&mut s);
            assert_eq!(
                fresh, again,
                "{sr} Hz: reset did not restore the initial state"
            );
        }
    }
}
