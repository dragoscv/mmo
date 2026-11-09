//! Value transforms: response curves, ranges, inversion and relative-encoder decoding.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Response curve applied to a normalised control value in `0.0..=1.0`.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Curve {
    #[default]
    Linear,
    /// Audio-taper: `(10^(2x) - 1) / 99` — fine resolution at the bottom (volume faders).
    Log,
    /// Inverse of `log`: fine resolution at the top.
    Exp,
    /// Smoothstep `3x² - 2x³` — fine resolution around both ends, steep in the middle.
    SCurve,
}

impl Curve {
    pub fn apply(self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        match self {
            Curve::Linear => x,
            Curve::Log => (10f32.powf(2.0 * x) - 1.0) / 99.0,
            Curve::Exp => (1.0 + 99.0 * x).log10() / 2.0,
            Curve::SCurve => x * x * (3.0 - 2.0 * x),
        }
    }
}

/// How a continuous input value is turned into the action value.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct ValueTransform {
    pub curve: Curve,
    /// Output range `[min, max]` the curved value is mapped to.
    pub range: [f32; 2],
    /// Flip the input (`1 - x`) before the curve.
    pub invert: bool,
    /// Multiplier for relative deltas (encoders, jogs).
    pub scale: f32,
}

impl Default for ValueTransform {
    fn default() -> Self {
        Self {
            curve: Curve::Linear,
            range: [0.0, 1.0],
            invert: false,
            scale: 1.0,
        }
    }
}

impl ValueTransform {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    /// Map a normalised absolute input to the output range.
    pub fn absolute(&self, normalised: f32) -> f32 {
        let x = if self.invert {
            1.0 - normalised.clamp(0.0, 1.0)
        } else {
            normalised.clamp(0.0, 1.0)
        };
        let y = self.curve.apply(x);
        self.range[0] + (self.range[1] - self.range[0]) * y
    }

    /// Scale (and optionally invert) a relative delta.
    pub fn relative(&self, delta: f32) -> f32 {
        let d = delta * self.scale;
        if self.invert { -d } else { d }
    }
}

/// Encoding of relative (endless) encoders and jog wheels on a 7-bit value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelativeEncoding {
    /// 1..=63 = +1..+63, 65..=127 = -63..-1 (`0x7F` = -1). Pioneer browse knobs use this.
    TwosComplement,
    /// Bit 6 = sign (set = negative), bits 0..5 = magnitude (`0x41` = -1).
    SignMagnitude,
    /// 64 = no movement; `value - 64` is the delta (`0x41` = +1, `0x3F` = -1). Pioneer jogs.
    Offset64,
}

impl RelativeEncoding {
    /// Decode a 7-bit relative value into a signed delta.
    pub fn decode(self, v: u8) -> i32 {
        let v = i32::from(v & 0x7F);
        match self {
            RelativeEncoding::TwosComplement => {
                if v >= 64 {
                    v - 128
                } else {
                    v
                }
            }
            RelativeEncoding::SignMagnitude => {
                let mag = v & 0x3F;
                if v & 0x40 != 0 { -mag } else { mag }
            }
            RelativeEncoding::Offset64 => v - 64,
        }
    }

    /// Guess the encoding from a burst of raw values (MIDI learn). Values clustered around
    /// 64 are offset-64; values near 0 / 127 are two's complement; values near 1 and 65 are
    /// sign-magnitude. Relative controls repeat a few small step values while absolute ones
    /// sweep through distinct values, so at most half of the values may be distinct.
    /// Returns `None` if the values look absolute.
    pub fn detect(values: &[u8]) -> Option<Self> {
        if values.len() < 3 {
            return None;
        }
        let mut distinct: Vec<u8> = values.to_vec();
        distinct.sort_unstable();
        distinct.dedup();
        if distinct.len() > (values.len() / 2).max(3) {
            return None;
        }
        let near = |v: u8, c: i32, w: i32| (i32::from(v) - c).abs() <= w;
        let all = |f: &dyn Fn(u8) -> bool| values.iter().all(|&v| f(v));
        if all(&|v| near(v, 64, 8) && v != 64) {
            return Some(Self::Offset64);
        }
        if all(&|v| (1..=8).contains(&v) || (120..=127).contains(&v)) {
            return Some(Self::TwosComplement);
        }
        if all(&|v| (1..=8).contains(&v) || (65..=72).contains(&v)) {
            return Some(Self::SignMagnitude);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings() {
        assert_eq!(RelativeEncoding::Offset64.decode(0x41), 1);
        assert_eq!(RelativeEncoding::Offset64.decode(0x3F), -1);
        assert_eq!(RelativeEncoding::TwosComplement.decode(0x01), 1);
        assert_eq!(RelativeEncoding::TwosComplement.decode(0x7F), -1);
        assert_eq!(RelativeEncoding::SignMagnitude.decode(0x41), -1);
        assert_eq!(RelativeEncoding::SignMagnitude.decode(0x03), 3);
    }

    #[test]
    fn curves_hit_endpoints() {
        for c in [Curve::Linear, Curve::Log, Curve::Exp, Curve::SCurve] {
            assert!((c.apply(0.0)).abs() < 1e-6);
            assert!((c.apply(1.0) - 1.0).abs() < 1e-5);
        }
        assert!(Curve::Log.apply(0.5) < 0.5);
        let t = ValueTransform {
            range: [-1.0, 1.0],
            invert: true,
            ..Default::default()
        };
        assert!((t.absolute(0.0) - 1.0).abs() < 1e-6);
    }
}
