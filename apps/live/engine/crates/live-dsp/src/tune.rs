//! Pitch correction (natural → hard robotic snap), harmonizer (diatonic / chromatic / MIDI) and tuner.

use crate::param::{ParamSpec, Smoothed, Unit, one_pole_coef, pan_gains};
use crate::pitch::{KEY_NAMES, PitchInfo, SCALE_NAMES, Scale, Shifter, Yin};
use crate::processor::{Processor, defaults, store};

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
];

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
    v: [f32; 9],
    yin: Yin,
    shifter: Shifter,
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
        let v: [f32; 9] = defaults(TUNE_SPECS);
        Self {
            sr: sample_rate,
            v,
            yin: Yin::new(sample_rate),
            shifter: Shifter::new(v[5] > 0.5),
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

    /// Times the formant guard fell back since the last reset (0 when formant is off).
    pub fn guard_trips(&self) -> u32 {
        self.shifter.guard_trips()
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
        self.shifter.set_ratio(2f32.powf(self.semis / 12.0));
        self.shifter.control(QUANTUM);
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
            let wet = self.shifter.tick(x);
            let dry = self.dry[(self.dry_w + 1) % dlen];
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
        self.dry.fill(0.0);
        self.stable = None;
        self.semis = self.v[7];
    }
    fn latency(&self) -> usize {
        Shifter::latency()
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
