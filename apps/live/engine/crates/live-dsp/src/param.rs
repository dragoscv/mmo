//! Parameter descriptions, smoothing and small math helpers shared by every processor.

/// Physical unit of a parameter (drives UI formatting and remote clients).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    None,
    Db,
    Hz,
    Ms,
    Seconds,
    Ratio,
    Percent,
    Semitones,
    Cents,
    Bpm,
    Pan,
    /// 0 = off, 1 = on.
    Toggle,
    /// Integer index into `ParamSpec::choices`.
    Choice,
}

/// How a control maps its travel to the value range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Curve {
    Linear,
    /// Logarithmic travel (frequencies, times).
    Log,
}

/// Static description of one parameter of a processor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParamSpec {
    /// Stable machine id used by presets and remote clients (`snake_case`).
    pub id: &'static str,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: Unit,
    pub curve: Curve,
    /// Labels for `Unit::Choice` parameters, in index order.
    pub choices: &'static [&'static str],
}

impl ParamSpec {
    pub const fn new(id: &'static str, min: f32, max: f32, default: f32, unit: Unit) -> Self {
        Self {
            id,
            min,
            max,
            default,
            unit,
            curve: Curve::Linear,
            choices: &[],
        }
    }

    pub const fn log(id: &'static str, min: f32, max: f32, default: f32, unit: Unit) -> Self {
        Self {
            id,
            min,
            max,
            default,
            unit,
            curve: Curve::Log,
            choices: &[],
        }
    }

    pub const fn toggle(id: &'static str, default: bool) -> Self {
        Self {
            id,
            min: 0.0,
            max: 1.0,
            default: if default { 1.0 } else { 0.0 },
            unit: Unit::Toggle,
            curve: Curve::Linear,
            choices: &[],
        }
    }

    pub const fn choice(
        id: &'static str,
        choices: &'static [&'static str],
        default: usize,
    ) -> Self {
        Self {
            id,
            min: 0.0,
            max: (choices.len() - 1) as f32,
            default: default as f32,
            unit: Unit::Choice,
            curve: Curve::Linear,
            choices,
        }
    }

    /// Clamp (and round for discrete units) a raw value into range. NaN maps to the default.
    pub fn clamp(&self, v: f32) -> f32 {
        if !v.is_finite() {
            return self.default;
        }
        let c = v.clamp(self.min, self.max);
        match self.unit {
            Unit::Toggle | Unit::Choice => c.round(),
            _ => c,
        }
    }

    /// Map a normalised 0..1 control position to a value (respects `curve`).
    pub fn from_normalized(&self, n: f32) -> f32 {
        let n = if n.is_finite() {
            n.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let v = match self.curve {
            Curve::Log if self.min > 0.0 => self.min * (self.max / self.min).powf(n),
            _ => self.min + (self.max - self.min) * n,
        };
        self.clamp(v)
    }

    /// Inverse of [`ParamSpec::from_normalized`].
    pub fn to_normalized(&self, v: f32) -> f32 {
        let v = self.clamp(v);
        if self.max <= self.min {
            return 0.0;
        }
        match self.curve {
            Curve::Log if self.min > 0.0 => (v / self.min).ln() / (self.max / self.min).ln(),
            _ => (v - self.min) / (self.max - self.min),
        }
    }
}

/// Find a parameter index by id.
pub fn param_index(specs: &[ParamSpec], id: &str) -> Option<usize> {
    specs.iter().position(|p| p.id == id)
}

/// Linear per-sample ramp towards a target: removes zipper noise on every parameter change.
#[derive(Clone, Copy, Debug)]
pub struct Smoothed {
    cur: f32,
    target: f32,
    step: f32,
    remaining: u32,
    ramp: u32,
}

impl Smoothed {
    pub fn new(value: f32, ramp_samples: u32) -> Self {
        Self {
            cur: value,
            target: value,
            step: 0.0,
            remaining: 0,
            ramp: ramp_samples,
        }
    }

    /// Ramp length derived from a time in milliseconds.
    pub fn with_ms(value: f32, ms: f32, sample_rate: f32) -> Self {
        Self::new(value, ms_to_samples(ms, sample_rate) as u32)
    }

    pub fn set_ramp(&mut self, samples: u32) {
        self.ramp = samples;
    }

    pub fn set(&mut self, target: f32) {
        if target == self.target && self.remaining == 0 {
            return;
        }
        self.target = target;
        if self.ramp == 0 {
            self.cur = target;
            self.remaining = 0;
        } else {
            self.remaining = self.ramp;
            self.step = (target - self.cur) / self.ramp as f32;
        }
    }

    /// Jump to a value immediately.
    pub fn reset(&mut self, value: f32) {
        self.cur = value;
        self.target = value;
        self.remaining = 0;
    }

    #[inline]
    pub fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.remaining -= 1;
            if self.remaining == 0 {
                self.cur = self.target;
            } else {
                self.cur += self.step;
            }
        }
        self.cur
    }

    /// Advance `n` samples at once (for control-rate consumers) and return the new value.
    #[inline]
    pub fn advance(&mut self, n: u32) -> f32 {
        if self.remaining > 0 {
            if n >= self.remaining {
                self.remaining = 0;
                self.cur = self.target;
            } else {
                self.remaining -= n;
                self.cur += self.step * n as f32;
            }
        }
        self.cur
    }

    #[inline]
    pub fn value(&self) -> f32 {
        self.cur
    }

    #[inline]
    pub fn target(&self) -> f32 {
        self.target
    }

    #[inline]
    pub fn is_smoothing(&self) -> bool {
        self.remaining > 0
    }
}

const LN10_OVER_20: f32 = core::f32::consts::LN_10 / 20.0;
const TWENTY_OVER_LN10: f32 = 20.0 / core::f32::consts::LN_10;

#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    (db * LN10_OVER_20).exp()
}

#[inline]
pub fn lin_to_db(x: f32) -> f32 {
    if x > 1e-9 {
        TWENTY_OVER_LN10 * x.ln()
    } else {
        -180.0
    }
}

#[inline]
pub fn ms_to_samples(ms: f32, sample_rate: f32) -> f32 {
    (ms * 0.001 * sample_rate).max(0.0)
}

/// Per-sample coefficient for a one-pole follower reaching 1 - 1/e after `ms`.
#[inline]
pub fn one_pole_coef(ms: f32, sample_rate: f32) -> f32 {
    if ms <= 0.0 {
        1.0
    } else {
        1.0 - (-1.0 / (ms * 0.001 * sample_rate)).exp()
    }
}

/// Equal-power pan gains for -1 (left) .. +1 (right).
#[inline]
pub fn pan_gains(pan: f32) -> (f32, f32) {
    let p = (pan.clamp(-1.0, 1.0) + 1.0) * core::f32::consts::FRAC_PI_4;
    (p.cos(), p.sin())
}

/// Flush denormals to zero (cheap insurance for feedback paths).
#[inline]
pub fn undenormal(x: f32) -> f32 {
    if x.abs() < 1e-20 { 0.0 } else { x }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothed_reaches_target_exactly() {
        let mut s = Smoothed::new(0.0, 4);
        s.set(1.0);
        let v: Vec<f32> = (0..6).map(|_| s.next()).collect();
        assert!((v[0] - 0.25).abs() < 1e-6);
        assert_eq!(v[3], 1.0);
        assert_eq!(v[5], 1.0);
        assert!(!s.is_smoothing());
    }

    #[test]
    fn advance_matches_next() {
        let mut a = Smoothed::new(0.0, 100);
        let mut b = a;
        a.set(2.0);
        b.set(2.0);
        for _ in 0..37 {
            a.next();
        }
        assert!((a.value() - b.advance(37)).abs() < 1e-4);
    }

    #[test]
    fn db_roundtrip() {
        for db in [-60.0f32, -6.0, 0.0, 12.0] {
            assert!((lin_to_db(db_to_lin(db)) - db).abs() < 1e-3);
        }
    }

    #[test]
    fn spec_normalisation_roundtrip() {
        let s = ParamSpec::log("f", 20.0, 20000.0, 1000.0, Unit::Hz);
        for n in [0.0f32, 0.25, 0.5, 1.0] {
            assert!((s.to_normalized(s.from_normalized(n)) - n).abs() < 1e-4);
        }
        assert_eq!(s.clamp(f32::NAN), 1000.0);
        let c = ParamSpec::choice("c", &["a", "b", "c"], 1);
        assert_eq!(c.clamp(1.6), 2.0);
    }
}
