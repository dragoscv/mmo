//! Pitch correction (natural → hard robotic snap), harmonizer (diatonic / chromatic / MIDI) and tuner.

use crate::param::{ParamSpec, Smoothed, Unit, one_pole_coef, pan_gains};
use crate::pitch::{KEY_NAMES, PitchInfo, SCALE_NAMES, Scale, Shifter, Yin};
use crate::processor::{Processor, defaults, store};
use crate::psola::PsolaShifter;

/// Control quantum: detection + ratio update every 128 samples (2.67 ms at 48 kHz).
const QUANTUM: usize = 128;
/// Unvoiced longer than this resets the target (no "stuck" notes after a phrase).
const SILENCE_HOLD_MS: f32 = 200.0;

// ─── Autotune ───────────────────────────────────────────────────────────────

const TUNE_SPECS: &[ParamSpec] = &[
    ParamSpec::choice("key", KEY_NAMES, 0),
    // Chromatic by default: with a key nobody set, "C major" pulls a singer in another key to
    // wrong notes. The song key (setlist) or the user picks the scale.
    ParamSpec::choice("scale", SCALE_NAMES, 0),
    ParamSpec::new("amount", 0.0, 1.0, 1.0, Unit::Percent),
    ParamSpec::log("retune", 0.5, 400.0, 40.0, Unit::Ms),
    ParamSpec::new("humanize", 0.0, 1.0, 0.3, Unit::Percent),
    // Off by default: correction moves the pitch by less than a semitone, where formants barely
    // shift, and without the formant filter the output cannot exceed the input level.
    ParamSpec::toggle("formant", false),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
    ParamSpec::new("transpose", -12.0, 12.0, 0.0, Unit::Semitones),
    ParamSpec::new("sticky", 0.0, 100.0, 60.0, Unit::Cents),
    // "Fast pitch": the period-synchronous shifter (`psola`) instead of the grain shifter. 1 sample
    // of delay at rest instead of 256 (5.3 ms), but during a correction on a LOW note its delay runs
    // up to one period (82 Hz: 12.2 ms), more than the classic shifter's fixed 5.3 ms. `auto`
    // (default) picks the fast one where it cannot be later: notes whose period is at most the
    // classic delay (`FAST_PERIOD` = 256 samples, 187.5 Hz at 48 kHz).
    ParamSpec::choice("fast", FAST_NAMES, 1),
];

const FAST_NAMES: &[&str] = &["off", "auto", "on"];
/// Period at or below which `auto` uses the fast shifter: the classic shifter's own fixed delay, so
/// above it the fast one is never later on average (mean delay = half a period).
const FAST_PERIOD: f32 = Shifter::latency() as f32;
/// Leave the fast shifter only above this period (10 % up), so a vibrato around the boundary does
/// not crossfade back and forth.
const SLOW_PERIOD: f32 = FAST_PERIOD * 1.1;

/// Snapshot of what the corrector is doing (telemetry for the tuner UI).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TuneStatus {
    pub input: PitchInfo,
    /// Target MIDI note, or -1 when idle.
    pub target: i32,
    /// Current correction in cents (positive = shifted up).
    pub correction_cents: f32,
}

pub struct Autotune {
    sr: f32,
    v: [f32; 10],
    yin: Yin,
    shifter: Shifter,
    /// Period-synchronous shifter of the fast mode; only ticked while the mode is on or fading in.
    psola: PsolaShifter,
    /// Weight of the fast shifter on the wet path, 0 = classic. Ramped over 10 ms so the switch
    /// between two paths with a very different delay does not click.
    mode: Smoothed,
    /// What the last control step decided (in `auto`, from the detected period).
    want_fast: bool,
    /// `auto` only: the state the hysteresis band keeps (see [`FAST_PERIOD`], [`SLOW_PERIOD`]).
    auto_fast: bool,
    scale: Scale,
    stable: Option<i32>,
    semis: f32,
    silence_q: u32,
    q_pos: usize,
    mix: Smoothed,
    dry: Vec<f32>,
    dry_w: usize,
    status: TuneStatus,
}

impl Autotune {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; 10] = defaults(TUNE_SPECS);
        Self {
            sr: sample_rate,
            v,
            yin: Yin::new(sample_rate),
            shifter: Shifter::new(v[5] > 0.5),
            psola: PsolaShifter::new(sample_rate),
            mode: Smoothed::with_ms(
                if v[9] as usize == 2 { 1.0 } else { 0.0 },
                10.0,
                sample_rate,
            ),
            want_fast: v[9] as usize == 2,
            auto_fast: false,
            scale: Scale::new(v[0] as usize, v[1] as usize),
            stable: None,
            semis: 0.0,
            silence_q: 0,
            q_pos: 0,
            mix: Smoothed::with_ms(v[6], 20.0, sample_rate),
            // Dry path delayed by the shifter latency so the mix knob never combs.
            dry: vec![0.0; Shifter::latency() + 1],
            dry_w: 0,
            status: TuneStatus {
                target: -1,
                ..Default::default()
            },
        }
    }

    pub fn status(&self) -> TuneStatus {
        self.status
    }

    /// The fast (period-synchronous) shifter is selected.
    fn fast(&self) -> bool {
        self.want_fast
    }

    /// Times the formant guard fell back since the last reset (0 when formant is off).
    pub fn guard_trips(&self) -> u32 {
        // The fast shifter has no formant guard: it does not filter the output.
        if self.fast() {
            0
        } else {
            self.shifter.guard_trips()
        }
    }

    fn control(&mut self) {
        let info = self.yin.detect();
        self.status.input = info;
        let quantum_ms = QUANTUM as f32 * 1000.0 / self.sr;
        let transpose = self.v[7];
        if !info.voiced() {
            self.silence_q += 1;
            if self.silence_q as f32 * quantum_ms > SILENCE_HOLD_MS || info.rms < 0.0008 {
                self.stable = None;
                self.status.target = -1;
                self.semis = transpose;
            }
        } else {
            self.silence_q = 0;
            let exact = info.midi;
            let mut target = self.scale.nearest(exact);
            // Sticky: keep the previous note unless the new one is clearly closer.
            if let Some(s) = self.stable {
                let sticky = self.v[8] / 100.0;
                if target != s && (s as f32 - exact).abs() < (target as f32 - exact).abs() + sticky
                {
                    target = s;
                }
            }
            self.stable = Some(target);
            self.status.target = target;
            let delta = target as f32 - exact;
            // Humanize: leave small deviations alone (vibrato, scoops) proportionally.
            let dead = 30.0 * self.v[4];
            let dev = delta.abs() * 100.0;
            let knee = if dev <= dead {
                0.0
            } else {
                let x = ((dev - dead) / 30.0).min(1.0);
                x * x * (3.0 - 2.0 * x)
            };
            let goal = delta * self.v[2] * knee + transpose;
            // Retune speed: one-pole glide of the correction at control rate (0.5 ms = hard snap).
            let a = one_pole_coef(self.v[3], self.sr / QUANTUM as f32);
            self.semis += a * (goal - self.semis);
        }
        self.status.correction_cents = self.semis * 100.0;
        let ratio = 2f32.powf(self.semis / 12.0);
        self.shifter.set_ratio(ratio);
        self.shifter.control(QUANTUM);
        self.psola.set_ratio(ratio);
        // The fast shifter wants the period in samples; unvoiced (0) lets it fall back to its
        // one-sample delay instead of holding a stale period.
        let period = if info.voiced() && info.frequency > 0.0 {
            self.sr / info.frequency
        } else {
            0.0
        };
        self.psola.set_period(period);
        // Which shifter feeds the wet path. `auto` keeps the classic one on low notes, where the
        // fast one's delay during a correction can exceed the classic shifter's fixed 256 samples.
        self.want_fast = match self.v[9] as usize {
            0 => false,
            2 => true,
            _ => {
                // `formant` is implemented in the classic shifter only, so with it on `auto` must not
                // choose a path that would drop it silently (`on` is the user overriding this).
                if self.v[5] > 0.5 {
                    self.auto_fast = false;
                } else if period > 0.0 {
                    // Hysteresis: enter at or below the classic delay, leave only 10 % above it.
                    self.auto_fast = if self.auto_fast {
                        period <= SLOW_PERIOD
                    } else {
                        period <= FAST_PERIOD
                    };
                }
                // Unvoiced (a pause) keeps whatever the last note chose: no flapping in silence.
                self.auto_fast
            }
        };
        self.mode.set(if self.want_fast { 1.0 } else { 0.0 });
    }
}

impl Processor for Autotune {
    fn specs(&self) -> &'static [ParamSpec] {
        TUNE_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, TUNE_SPECS, i, v) {
            match i {
                0 | 1 => self.scale = Scale::new(self.v[0] as usize, self.v[1] as usize),
                5 => self.shifter.set_formant(v > 0.5),
                6 => self.mix.set(v),
                // 9 (`fast`) needs nothing here: `control` reads it at the next quantum (2.7 ms
                // at 48 kHz) and ramps `mode` itself.
                _ => {}
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let dlen = self.dry.len();
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            if self.q_pos == 0 {
                self.control();
            }
            self.q_pos = (self.q_pos + 1) % QUANTUM;
            let x = 0.5 * (*a + *b);
            self.yin.push(x);
            let mode = self.mode.next();
            let wet = if mode > 0.0 {
                // Both paths run while the crossfade is moving (and only then when the mode is
                // off), so switching does not step: the classic shifter is 255 samples later.
                let old = self.shifter.tick(x);
                let fast = self.psola.tick(x);
                old + mode * (fast - old)
            } else {
                self.shifter.tick(x)
            };
            // The dry tap follows the active shifter's delay, crossfaded the same way, so the mix
            // knob never combs. `dlen - 1` back = the classic 256 samples, one back = the fast one.
            let dry = if mode > 0.0 {
                let old = self.dry[(self.dry_w + 1) % dlen];
                let fast = self.dry[(self.dry_w + dlen - 1) % dlen];
                old + mode * (fast - old)
            } else {
                self.dry[(self.dry_w + 1) % dlen]
            };
            self.dry[self.dry_w] = x;
            self.dry_w = (self.dry_w + 1) % dlen;
            let m = self.mix.next();
            let y = dry + m * (wet - dry);
            *a = y;
            *b = y;
        }
    }
    fn reset(&mut self) {
        self.yin.reset();
        self.shifter.reset();
        self.psola.reset();
        self.dry.fill(0.0);
        self.stable = None;
        self.semis = self.v[7];
    }
    fn latency(&self) -> usize {
        if self.fast() {
            self.psola.latency()
        } else {
            Shifter::latency()
        }
    }
    fn tune_status(&self) -> Option<TuneStatus> {
        Some(self.status)
    }
}

// ─── Harmonizer ─────────────────────────────────────────────────────────────

pub const HARMONY_VOICES: usize = 4;
const HARMONY_MODES: &[&str] = &["diatonic", "chromatic", "midi"];

/// 1 key + 1 scale + 1 mode + 1 dry + 1 formant, then per voice: interval, level, pan, note.
const HARM_SPECS: &[ParamSpec] = &[
    ParamSpec::choice("key", KEY_NAMES, 0),
    // Stays major: diatonic harmonies need a real scale (a "third" in chromatic is 2 semitones).
    ParamSpec::choice("scale", SCALE_NAMES, 1),
    ParamSpec::choice("mode", HARMONY_MODES, 0),
    ParamSpec::new("dry", 0.0, 1.0, 1.0, Unit::Percent),
    ParamSpec::toggle("formant", false),
    ParamSpec::new("v1_interval", -12.0, 12.0, 2.0, Unit::None),
    ParamSpec::new("v1_level", 0.0, 1.0, 0.5, Unit::Percent),
    ParamSpec::new("v1_pan", -1.0, 1.0, -0.6, Unit::Pan),
    ParamSpec::new("v1_note", 0.0, 127.0, 0.0, Unit::None),
    ParamSpec::new("v2_interval", -12.0, 12.0, -3.0, Unit::None),
    ParamSpec::new("v2_level", 0.0, 1.0, 0.5, Unit::Percent),
    ParamSpec::new("v2_pan", -1.0, 1.0, 0.6, Unit::Pan),
    ParamSpec::new("v2_note", 0.0, 127.0, 0.0, Unit::None),
    ParamSpec::new("v3_interval", -12.0, 12.0, 4.0, Unit::None),
    ParamSpec::new("v3_level", 0.0, 1.0, 0.0, Unit::Percent),
    ParamSpec::new("v3_pan", -1.0, 1.0, -0.3, Unit::Pan),
    ParamSpec::new("v3_note", 0.0, 127.0, 0.0, Unit::None),
    ParamSpec::new("v4_interval", -12.0, 12.0, -5.0, Unit::None),
    ParamSpec::new("v4_level", 0.0, 1.0, 0.0, Unit::Percent),
    ParamSpec::new("v4_pan", -1.0, 1.0, 0.3, Unit::Pan),
    ParamSpec::new("v4_note", 0.0, 127.0, 0.0, Unit::None),
];
const HARM_N: usize = 21;

pub struct Harmonizer {
    sr: f32,
    v: [f32; HARM_N],
    yin: Yin,
    voices: [Shifter; HARMONY_VOICES],
    levels: [Smoothed; HARMONY_VOICES],
    dry: Smoothed,
    scale: Scale,
    src: Option<f32>,
    silence_q: u32,
    q_pos: usize,
    delay: Vec<f32>,
    delay_w: usize,
}

impl Harmonizer {
    pub fn new(sample_rate: f32) -> Self {
        let v: [f32; HARM_N] = defaults(HARM_SPECS);
        Self {
            sr: sample_rate,
            v,
            yin: Yin::new(sample_rate),
            voices: core::array::from_fn(|_| Shifter::new(false)),
            levels: core::array::from_fn(|k| Smoothed::with_ms(v[6 + k * 4], 30.0, sample_rate)),
            dry: Smoothed::with_ms(v[3], 20.0, sample_rate),
            scale: Scale::new(v[0] as usize, v[1] as usize),
            src: None,
            silence_q: 0,
            q_pos: 0,
            delay: vec![0.0; Shifter::latency() + 1],
            delay_w: 0,
        }
    }

    fn voice_target(&self, k: usize, src: f32) -> Option<f32> {
        let base = 5 + k * 4;
        let interval = self.v[base].round() as i32;
        match self.v[2] as u8 {
            0 => {
                if interval == 0 {
                    return None;
                }
                let root = self.scale.nearest(src);
                let n = self.scale.degree_offset(root, interval);
                // Keep the singer's own detune/vibrato on the harmony line.
                Some(n as f32 + (src - root as f32))
            }
            1 => (interval != 0).then_some(src + interval as f32),
            _ => {
                let note = self.v[base + 3];
                (note >= 1.0).then_some(note)
            }
        }
    }

    fn control(&mut self) {
        let info = self.yin.detect();
        if info.voiced() {
            self.silence_q = 0;
            self.src = Some(info.midi);
        } else {
            self.silence_q += 1;
            if self.silence_q as f32 * QUANTUM as f32 * 1000.0 / self.sr > SILENCE_HOLD_MS {
                self.src = None;
            }
        }
        for k in 0..HARMONY_VOICES {
            let ratio = match self
                .src
                .and_then(|s| self.voice_target(k, s).map(|t| (s, t)))
            {
                Some((s, t)) => 2f32.powf((t - s) / 12.0),
                None => 1.0,
            };
            self.voices[k].set_ratio(ratio);
            self.voices[k].control(QUANTUM);
        }
    }
}

impl Processor for Harmonizer {
    fn specs(&self) -> &'static [ParamSpec] {
        HARM_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if let Some(v) = store(&mut self.v, HARM_SPECS, i, v) {
            match i {
                0 | 1 => self.scale = Scale::new(self.v[0] as usize, self.v[1] as usize),
                3 => self.dry.set(v),
                4 => {
                    for s in &mut self.voices {
                        s.set_formant(v > 0.5);
                    }
                }
                _ if i >= 5 && (i - 5) % 4 == 1 => self.levels[(i - 5) / 4].set(v),
                _ => {}
            }
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mut pans = [(0.0f32, 0.0f32); HARMONY_VOICES];
        for (k, p) in pans.iter_mut().enumerate() {
            *p = pan_gains(self.v[7 + k * 4]);
        }
        let dlen = self.delay.len();
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            if self.q_pos == 0 {
                self.control();
            }
            self.q_pos = (self.q_pos + 1) % QUANTUM;
            let x = 0.5 * (*a + *b);
            self.yin.push(x);
            // Delay the lead by the shifter latency so lead + harmonies stay phase-aligned.
            let dl = self.delay[(self.delay_w + 1) % dlen];
            self.delay[self.delay_w] = x;
            self.delay_w = (self.delay_w + 1) % dlen;
            let d = self.dry.next();
            let mut ol = 0.0;
            let mut or = 0.0;
            for k in 0..HARMONY_VOICES {
                let lvl = self.levels[k].next();
                let y = self.voices[k].tick(x);
                if lvl > 0.0 && self.src.is_some() {
                    ol += y * lvl * pans[k].0;
                    or += y * lvl * pans[k].1;
                }
            }
            *a = dl * d + ol;
            *b = dl * d + or;
        }
    }
    fn reset(&mut self) {
        self.yin.reset();
        for s in &mut self.voices {
            s.reset();
        }
        self.delay.fill(0.0);
        self.src = None;
    }
    fn latency(&self) -> usize {
        Shifter::latency()
    }
}

// ─── Tuner (analysis only) ──────────────────────────────────────────────────

const TUNER_SPECS: &[ParamSpec] = &[ParamSpec::new("reference", 415.0, 466.0, 440.0, Unit::Hz)];

/// Pass-through analyser feeding the tuner display.
pub struct Tuner {
    v: [f32; 1],
    yin: Yin,
    q_pos: usize,
    last: PitchInfo,
}

impl Tuner {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            v: [440.0],
            yin: Yin::new(sample_rate),
            q_pos: 0,
            last: PitchInfo::default(),
        }
    }

    /// Last reading, re-referenced to the `reference` A4.
    pub fn info(&self) -> PitchInfo {
        let mut p = self.last;
        if p.frequency > 0.0 {
            p.midi = 12.0 * (p.frequency / self.v[0]).log2() + 69.0;
        }
        p
    }
}

impl Processor for Tuner {
    fn specs(&self) -> &'static [ParamSpec] {
        TUNER_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        store(&mut self.v, TUNER_SPECS, i, v);
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (a, b) in l.iter().zip(r.iter()) {
            self.yin.push(0.5 * (a + b));
            self.q_pos += 1;
            if self.q_pos >= QUANTUM * 4 {
                self.q_pos = 0;
                self.last = self.yin.detect();
            }
        }
    }
    fn reset(&mut self) {
        self.yin.reset();
        self.last = PitchInfo::default();
    }
    fn tune_status(&self) -> Option<TuneStatus> {
        let info = self.info();
        Some(TuneStatus {
            input: info,
            target: if info.voiced() {
                info.midi.round() as i32
            } else {
                -1
            },
            correction_cents: 0.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine, voice};

    fn detect(buf: &[f32]) -> f32 {
        let mut y = Yin::new(48000.0);
        for x in &buf[buf.len() - 2048..] {
            y.push(*x);
        }
        y.detect().frequency
    }

    #[test]
    fn autotune_snaps_flat_note_to_scale() {
        let mut t = Autotune::new(48000.0);
        t.set_param(1, 1.0); // C major
        t.set_param(3, 0.5); // hard retune
        t.set_param(4, 0.0);
        // A4 30 cents flat (in C major, target A4 = 440).
        let f = 440.0 * 2f32.powf(-0.30 / 12.0);
        let mut l = sine(f, 48000.0, 48000, 0.4);
        let mut r = l.clone();
        t.process(&mut l, &mut r);
        let got = detect(&l);
        assert!((got - 440.0).abs() < 3.0, "got {got}");
        assert_eq!(t.status().target, 69);
    }

    #[test]
    fn autotune_defaults_are_chromatic_without_formant() {
        let t = Autotune::new(48000.0);
        assert_eq!(t.param(1), 0.0, "scale must default to chromatic");
        assert_eq!(t.param(5), 0.0, "formant must default to off");
        assert_eq!(t.param(9), 1.0, "the fast shifter must default to auto");
        assert_eq!(FAST_NAMES[t.param(9) as usize], "auto");
        assert_eq!(t.latency(), 256, "the classic shifter is the default");
    }

    /// `auto`: the fast shifter for notes whose period is at most the classic delay (187.5 Hz at
    /// 48 kHz), the classic one below - with a 10 % band, so a vibrato does not flap.
    #[test]
    fn fast_mode_is_automatic_around_the_classic_delay() {
        let latency_after = |f: f32| {
            let mut t = Autotune::new(48000.0);
            // 40 ms of the tone is enough for the detector and the crossfade.
            let mut l = sine(f, 48000.0, 1920, 0.4);
            let mut r = l.clone();
            t.process(&mut l, &mut r);
            t.latency()
        };
        // Period 109 samples at 440 Hz, 218 at 220 Hz: both at or below 256 -> fast.
        assert_eq!(
            latency_after(440.0),
            1,
            "440 Hz should take the fast shifter"
        );
        assert_eq!(
            latency_after(220.0),
            1,
            "220 Hz should take the fast shifter"
        );
        // Period 436 samples at 110 Hz, 585 at 82 Hz: above 256 -> classic.
        assert_eq!(
            latency_after(110.0),
            256,
            "110 Hz should keep the classic shifter"
        );
        assert_eq!(
            latency_after(82.0),
            256,
            "82 Hz should keep the classic shifter"
        );
        // Forced modes ignore the pitch.
        for (mode, want) in [(0.0, 256usize), (2.0, 1)] {
            let mut t = Autotune::new(48000.0);
            t.set_param(9, mode);
            let mut l = sine(110.0, 48000.0, 1920, 0.4);
            let mut r = l.clone();
            t.process(&mut l, &mut r);
            assert_eq!(t.latency(), want, "mode {mode} at 110 Hz");
        }
    }

    /// The fast mode must actually be fast: an impulse comes out 1 sample later instead of 256.
    #[test]
    fn fast_mode_moves_the_voice_a_hundred_times_closer() {
        let delay = |fast: bool| {
            let mut t = Autotune::new(48000.0);
            t.set_param(9, if fast { 2.0 } else { 0.0 });
            // Warm up so the 10 ms crossfade between the two paths has settled, then one impulse.
            let (mut l, mut r) = (vec![0.0f32; 2048], vec![0.0f32; 2048]);
            t.process(&mut l, &mut r);
            l[0] = 1.0;
            r[0] = 1.0;
            t.process(&mut l, &mut r);
            let (mut best, mut at) = (0.0f32, 0usize);
            for (i, v) in l.iter().enumerate() {
                if v.abs() > best {
                    best = v.abs();
                    at = i;
                }
            }
            (at, best)
        };
        let (fast, fast_peak) = delay(true);
        let (classic, classic_peak) = delay(false);
        assert!(fast <= 4, "fast mode delayed the voice by {fast} samples");
        assert!(
            classic >= 200,
            "the classic shifter should still delay by ~256, got {classic}"
        );
        assert!(
            fast_peak > 0.05 && classic_peak > 0.05,
            "no output: {fast_peak} / {classic_peak}"
        );
    }

    /// The defect the classic shifter has and the fast one must not: a small correction on a low
    /// note is LOST (its ignored test `shifter_applies_small_corrections_at_110_hz`).
    #[test]
    fn fast_mode_applies_a_small_correction_at_110_hz() {
        let error_cents = |fast: bool| {
            let mut t = Autotune::new(48000.0);
            t.set_param(2, 0.0); // amount: no scale correction, only the transpose below
            t.set_param(3, 0.5); // retune 40 ms
            t.set_param(7, 0.25); // +25 cents
            // Forced, not auto: at 110 Hz auto deliberately keeps the classic shifter, and this is
            // the test of what the fast one does there when it is asked for.
            t.set_param(9, if fast { 2.0 } else { 0.0 });
            let mut l = sine(110.0, 48000.0, 96000, 0.4);
            let mut r = l.clone();
            t.process(&mut l, &mut r);
            let got = detect(&l);
            let want = 110.0 * 2f32.powf(0.25 / 12.0);
            1200.0 * (got / want).log2()
        };
        let fast = error_cents(true);
        let classic = error_cents(false);
        println!("110 Hz +25 cents: fast {fast:.2} cents off, classic {classic:.2} cents off");
        assert!(
            fast.abs() < 8.0,
            "the fast shifter must land within 8 cents at 110 Hz, got {fast:.2}"
        );
    }

    /// `formant` is implemented on the classic path only, so `auto` must not pick a path that would
    /// ignore it: with `formant` on, a high note stays on the classic shifter (chain latency 256
    /// against 1), while an explicit `fast = on` still wins. Measured 2026-11-14; before this rule the
    /// setting was dropped silently above 187.5 Hz.
    #[test]
    fn formant_on_keeps_auto_on_the_classic_path() {
        let chain = |formant: f32, fast: f32| {
            let mut t = Autotune::new(48000.0);
            t.set_param(5, formant); // formant
            t.set_param(9, fast); // off / auto / on
            let patch = voice(440.0, 20.0, 48000.0, 9600, 0.3);
            let mut l = patch.clone();
            let mut r = patch;
            t.process(&mut l, &mut r);
            t.latency()
        };
        assert_eq!(
            chain(0.0, 1.0),
            1,
            "formant off, auto, 440 Hz: the fast path"
        );
        assert_eq!(
            chain(1.0, 1.0),
            256,
            "formant on, auto, 440 Hz: must stay classic"
        );
        assert_eq!(
            chain(1.0, 2.0),
            1,
            "formant on, fast on: the explicit choice wins"
        );
        assert_eq!(chain(1.0, 0.0), 256, "formant on, fast off: classic");
    }

    /// What a partial `mix` does on a low note. The dry tap follows the active shifter's declared
    /// delay (one sample for the fast path, 256 for the classic one), so if a path's output arrives
    /// at a different phase than that delay implies, half of each should cancel. Measured
    /// 2026-11-14: with the classic path at 110 Hz `mix` 0.5 comes out at 0.0386 against 0.2828 for
    /// either side alone — 17 dB down, a setting that nearly mutes a male voice. At 220 Hz and above
    /// the classic path does not do this and neither does the fast path anywhere, so the test pins
    /// the fast path at every pitch and the low-pitch classic numbers as measured.
    #[test]
    fn a_partial_mix_does_not_cancel() {
        let level = |f0: f32, mode: f32, mix: f32| {
            let mut t = Autotune::new(48000.0);
            t.set_param(2, 0.0);
            t.set_param(3, 0.5);
            t.set_param(6, mix); // mix
            t.set_param(7, 0.25);
            t.set_param(9, mode);
            let long = sine(f0, 48000.0, 3 * 48000, 0.4);
            let mut out = Vec::with_capacity(long.len());
            for chunk in long.chunks(480) {
                let (mut l, mut r) = (chunk.to_vec(), chunk.to_vec());
                t.process(&mut l, &mut r);
                out.extend_from_slice(&l);
            }
            rms(&out[48000..])
        };
        let mut cancelled: Vec<(f32, &str, f32)> = Vec::new();
        for f0 in [110.0f32, 220.0, 440.0] {
            for (name, mode) in [("classic", 0.0f32), ("fast", 2.0)] {
                let (dry, half, wet) = (
                    level(f0, mode, 0.0),
                    level(f0, mode, 0.5),
                    level(f0, mode, 1.0),
                );
                println!(
                    "{f0:.0} Hz {name}: mix 0 {dry:.4}, mix 0.5 {half:.4}, mix 1 {wet:.4} ({:.1} dB)",
                    20.0 * (half / dry.min(wet)).log10()
                );
                if half < 0.5 * dry.min(wet) {
                    cancelled.push((f0, name, half));
                }
            }
        }
        // The fast path is the one that could be asked to take over low notes, so it must be clean
        // everywhere; the classic path's low-pitch cancellation is recorded, not asserted away.
        assert!(
            !cancelled.iter().any(|(_, name, _)| *name == "fast"),
            "the period-synchronous path cancels at a partial mix: {cancelled:?}"
        );
        assert!(
            cancelled.len() <= 1,
            "a partial mix now cancels in more cases than the recorded 110 Hz classic one: {cancelled:?}"
        );
        if cancelled.is_empty() {
            println!(
                "the classic path no longer cancels at a partial mix: the recorded defect is gone"
            );
        }
    }

    /// The other half of the threshold at ~187.5 Hz: what each path costs in delay on a low note.
    /// Measured in the steady state, because the attack of a note is not representative — the
    /// period-synchronous path falls back to its one-sample delay until the detector has a period,
    /// so a note starting after silence makes it look earlier than it is. Here a 110 Hz tone is
    /// amplitude-modulated at 30 Hz and the two envelopes are correlated: the lag of the best match
    /// is the delay, independent of the attack.
    #[test]
    fn the_fast_path_costs_delay_on_a_low_note() {
        let delay = |mode: f32| {
            let mut t = Autotune::new(48000.0);
            t.set_param(2, 0.0);
            t.set_param(3, 0.5);
            t.set_param(7, 0.25);
            t.set_param(9, mode);
            let n = 4 * 48000;
            let mut x = Vec::with_capacity(n);
            for i in 0..n {
                let time = i as f32 / 48000.0;
                let am = 1.0 + 0.4 * (std::f32::consts::TAU * 30.0 * time).cos();
                x.push(0.4 * am * (std::f32::consts::TAU * 110.0 * time).sin());
            }
            let mut l = x.clone();
            let mut r = x.clone();
            t.process(&mut l, &mut r);
            // Envelopes: a 32-sample moving RMS of each signal.
            let env = |s: &[f32]| {
                let mut e = vec![0.0f32; s.len()];
                let mut acc = 0.0f32;
                for i in 0..s.len() {
                    acc += s[i] * s[i];
                    if i >= 32 {
                        acc -= s[i - 32] * s[i - 32];
                    }
                    e[i] = (acc / 32.0).sqrt();
                }
                e
            };
            let (ey, ex) = (env(&l), env(&x));
            // One second in the middle: the correction has settled and the note is long.
            let (from, to) = (2 * 48000, 3 * 48000);
            let mut best = (0.0f32, 0usize);
            for lag in 0..700usize {
                let mut dot = 0.0f32;
                for i in from..to {
                    dot += ey[i] * ex[i - lag];
                }
                if dot > best.0 {
                    best = (dot, lag);
                }
            }
            best.1 as f32
        };
        let (auto, on, off) = (delay(1.0), delay(2.0), delay(0.0));
        println!("110 Hz, delay of the envelope: auto {auto:.0} samples, on {on:.0}, off {off:.0}");
        assert!(
            (auto - off).abs() < 1.0,
            "auto must be the classic path here too"
        );
        // Measured 2026-11-14: 287 against 57, so the fast path is ~4.8 ms further behind in the
        // steady state. That is what the ~187.5 Hz line buys; the pitch side of the trade is in
        // `what_auto_costs_on_a_low_note`. Loose bound on purpose: it guards the direction, not a
        // figure, and the method is envelope correlation, not the phase delay the chain declares.
        assert!(
            on - off > 100.0,
            "the fast path is expected to sit further behind on a low note ({on:.0} against {off:.0}); the reason for the auto threshold disappeared, revisit it"
        );
    }

    /// What the shipped default costs on a low note, as one number. `fast` defaults to `auto`, and
    /// auto keeps the classic shifter below ~187.5 Hz (a period longer than a grain), which is where
    /// the classic shifter loses small corrections: at 110 Hz a +25 cent transpose comes out at the
    /// input pitch instead of the target. Measured in three runs of the same signal, processed in
    /// blocks the way the engine does, so the owner can weigh moving that line. The assertion pins
    /// the ROUTING (auto must agree with the classic path), not the defect: the day the line moves,
    /// this test has to be updated deliberately.
    #[test]
    fn what_auto_costs_on_a_low_note() {
        let error_cents = |mode: f32| {
            let mut t = Autotune::new(48000.0);
            t.set_param(2, 0.0); // amount: no scale correction, only the transpose below
            t.set_param(3, 0.5); // retune 40 ms
            t.set_param(7, 0.25); // +25 cents
            t.set_param(9, mode); // off / auto / on
            let long = sine(110.0, 48000.0, 4 * 48000, 0.4);
            let mut out = Vec::with_capacity(long.len());
            for chunk in long.chunks(480) {
                let (mut l, mut r) = (chunk.to_vec(), chunk.to_vec());
                t.process(&mut l, &mut r);
                out.extend_from_slice(&l);
            }
            let want = 110.0 * 2f32.powf(0.25 / 12.0);
            1200.0 * (detect(&out) / want).log2()
        };
        let (auto, on, off) = (error_cents(1.0), error_cents(2.0), error_cents(0.0));
        println!("110 Hz +25 cents: auto {auto:+.2} cents off, on {on:+.2}, off {off:+.2}");
        assert!(
            (auto - off).abs() < 1.0,
            "auto must be the classic path at 110 Hz (auto {auto:+.2}, classic {off:+.2}); if the threshold moved, update this test and docs/live/latency.md"
        );
    }

    /// Switching the mode while a note is sung must not step: both paths run during the 10 ms
    /// crossfade, so the output moves by no more than a sine of that frequency does.
    #[test]
    fn switching_fast_mode_does_not_click() {
        let mut t = Autotune::new(48000.0);
        // One continuous sine, sliced: a sine restarted per block would step at every boundary.
        let block = 480; // 10 ms
        let long = sine(440.0, 48000.0, block * 40, 0.4);
        let mut out: Vec<f32> = Vec::new();
        for (k, chunk) in long.chunks(block).enumerate() {
            let mut l = chunk.to_vec();
            let mut r = l.clone();
            // Off for 10 blocks, then on while the sine is running.
            if k == 10 {
                t.set_param(9, 2.0);
            }
            t.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        let worst = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        let input_step = 2.0 * std::f32::consts::PI * 440.0 / 48000.0 * 0.4;
        assert!(
            worst < 4.0 * input_step,
            "switch stepped by {worst:.4}, the sine itself by {input_step:.4}"
        );
    }

    /// Hard correction of a voice-like signal with vibrato: never much louder than the input,
    /// with formant off (default) and on. This is the case that used to sit on the limiter.
    #[test]
    fn autotune_keeps_the_voice_level() {
        for formant in [0.0f32, 1.0] {
            for f0 in [220.0, 440.0, 523.25] {
                let mut t = Autotune::new(48000.0);
                t.set_param(3, 0.5); // hard retune
                t.set_param(4, 0.0); // no humanize
                t.set_param(5, formant);
                let x = voice(f0, 40.0, 48000.0, 3 * 48000, 0.25);
                let (mut l, mut r) = (x.clone(), x.clone());
                t.process(&mut l, &mut r);
                assert!(l.iter().all(|v| v.is_finite()));
                for (k, (wi, wo)) in x[24000..]
                    .chunks(4800)
                    .zip(l[24000..].chunks(4800))
                    .enumerate()
                {
                    let gain_db = 20.0 * (rms(wo) / rms(wi).max(1e-9)).log10();
                    assert!(
                        gain_db < 6.0,
                        "formant {formant} f0 {f0} window {k}: {gain_db:.1} dB over the input"
                    );
                }
                let peak = l[24000..].iter().fold(0.0f32, |m, v| m.max(v.abs()));
                assert!(peak < 0.7, "formant {formant} f0 {f0}: peak {peak}");
            }
        }
    }

    #[test]
    fn harmonizer_adds_diatonic_third() {
        let mut h = Harmonizer::new(48000.0);
        h.set_param(3, 0.0); // no dry
        h.set_param(10, 0.0); // voice 2 off, voice 1 = +2 degrees
        let mut l = sine(261.63, 48000.0, 48000, 0.4); // C4
        let mut r = l.clone();
        h.process(&mut l, &mut r);
        let got = detect(&l);
        // E4 = 329.63 Hz
        assert!((got - 329.63).abs() < 5.0, "got {got}");
    }

    #[test]
    fn tuner_reads_reference() {
        let mut t = Tuner::new(48000.0);
        let mut l = sine(442.0, 48000.0, 9600, 0.4);
        let mut r = l.clone();
        t.process(&mut l, &mut r);
        assert!(t.info().cents().abs() > 5.0);
        t.set_param(0, 442.0);
        assert!(t.info().cents().abs() < 2.0);
    }
}
