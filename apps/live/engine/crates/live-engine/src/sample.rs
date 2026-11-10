//! Device sample formats and period maths for the native backends (pure, tested on every OS).

/// Wire format of a device buffer (little endian, interleaved).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fmt {
    F32,
    /// 32-bit container; `valid` significant bits, left-justified (24 or 32).
    I32 {
        valid: u8,
    },
    /// Packed 3-byte samples.
    I24,
    I16,
}

impl Fmt {
    pub fn bytes(self) -> usize {
        match self {
            Fmt::F32 | Fmt::I32 { .. } => 4,
            Fmt::I24 => 3,
            Fmt::I16 => 2,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Fmt::F32 => "f32",
            Fmt::I32 { valid: 24 } => "i24 in 32",
            Fmt::I32 { .. } => "i32",
            Fmt::I24 => "i24",
            Fmt::I16 => "i16",
        }
    }
}

/// Device bytes → f32 in [-1, 1). `src` holds `dst.len()` samples.
pub fn decode(fmt: Fmt, src: &[u8], dst: &mut [f32]) {
    let n = fmt.bytes();
    for (s, d) in src.chunks_exact(n).zip(dst.iter_mut()) {
        *d = match fmt {
            Fmt::F32 => f32::from_le_bytes([s[0], s[1], s[2], s[3]]),
            Fmt::I32 { .. } => {
                (i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64 / 2_147_483_648.0) as f32
            }
            Fmt::I24 => {
                let v = i32::from_le_bytes([0, s[0], s[1], s[2]]) >> 8;
                v as f32 / 8_388_608.0
            }
            Fmt::I16 => i16::from_le_bytes([s[0], s[1]]) as f32 / 32_768.0,
        };
    }
}

/// f32 → device bytes, clipped. `dst` holds `src.len()` samples.
pub fn encode(fmt: Fmt, src: &[f32], dst: &mut [u8]) {
    let n = fmt.bytes();
    for (s, d) in src.iter().zip(dst.chunks_exact_mut(n)) {
        let x = if s.is_finite() {
            s.clamp(-1.0, 1.0)
        } else {
            0.0
        };
        match fmt {
            Fmt::F32 => d.copy_from_slice(&x.to_le_bytes()),
            Fmt::I32 { valid } => {
                // Round at the device's bit depth, then left-justify in the 32-bit container.
                let valid = (valid as u32).clamp(1, 32);
                let scale = 1i64 << (valid - 1);
                let v = ((x as f64 * scale as f64).round() as i64).clamp(-scale, scale - 1);
                let v = (v << (32 - valid)) as i32;
                d.copy_from_slice(&v.to_le_bytes());
            }
            Fmt::I24 => {
                let v = ((x * 8_388_608.0).round() as i32).clamp(-8_388_608, 8_388_607);
                d.copy_from_slice(&v.to_le_bytes()[..3]);
            }
            Fmt::I16 => {
                let v = (x * 32_768.0).round() as i16;
                d.copy_from_slice(&v.to_le_bytes());
            }
        }
    }
}

/// Frames → 100 ns units (REFERENCE_TIME), rounded like the WASAPI docs.
pub fn frames_to_hns(frames: u32, rate: u32) -> i64 {
    (10_000_000.0 * frames as f64 / rate.max(1) as f64 + 0.5) as i64
}

pub fn hns_to_frames(hns: i64, rate: u32) -> u32 {
    (hns as f64 * rate as f64 / 10_000_000.0 + 0.5) as u32
}

/// Nearest multiple of `fundamental` to `want`, inside `[min, max]` (`max` 0 = no upper limit).
pub fn align_period(want: u32, fundamental: u32, min: u32, max: u32) -> u32 {
    let f = fundamental.max(1);
    let lo = min.max(f);
    let hi = if max == 0 { u32::MAX } else { max.max(lo) };
    let k = (want.saturating_add(f / 2) / f).max(1) * f;
    k.clamp(lo, hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(fmt: Fmt, tol: f32) {
        let src = [0.0f32, 0.5, -0.5, 0.999, -1.0, 0.123_456, -0.000_1];
        let mut bytes = vec![0u8; src.len() * fmt.bytes()];
        encode(fmt, &src, &mut bytes);
        let mut back = [0.0f32; 7];
        decode(fmt, &bytes, &mut back);
        for (a, b) in src.iter().zip(back) {
            assert!((a - b).abs() <= tol, "{fmt:?}: {a} vs {b}");
        }
    }

    #[test]
    fn formats_round_trip() {
        round_trip(Fmt::F32, 0.0);
        round_trip(Fmt::I32 { valid: 32 }, 1e-6);
        round_trip(Fmt::I32 { valid: 24 }, 2.0 / 8_388_608.0);
        round_trip(Fmt::I24, 2.0 / 8_388_608.0);
        round_trip(Fmt::I16, 2.0 / 32_768.0);
    }

    #[test]
    fn encode_clips_and_drops_nan() {
        let mut b = [0u8; 8];
        encode(Fmt::I16, &[2.0, -2.0, f32::NAN, f32::INFINITY], &mut b);
        assert_eq!(i16::from_le_bytes([b[0], b[1]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([b[2], b[3]]), i16::MIN);
        assert_eq!(i16::from_le_bytes([b[4], b[5]]), 0);
        assert_eq!(i16::from_le_bytes([b[6], b[7]]), 0);
        let mut p = [0u8; 6];
        encode(Fmt::I24, &[1.0, -1.0], &mut p);
        assert_eq!(p, [0xff, 0xff, 0x7f, 0x00, 0x00, 0x80]);
    }

    #[test]
    fn i24_in_32_is_left_justified() {
        let mut b = [0u8; 4];
        encode(Fmt::I32 { valid: 24 }, &[0.123_456_7], &mut b);
        assert_eq!(b[0], 0, "low byte must stay clear");
        let mut one = [0.0f32];
        decode(Fmt::I24, &[0x00, 0x00, 0x80], &mut one);
        assert_eq!(one[0], -1.0);
        let mut two = [0.0f32; 2];
        decode(
            Fmt::I32 { valid: 24 },
            &[0, 0, 0, 0x80, 0, 0, 0, 0x40],
            &mut two,
        );
        assert_eq!(two, [-1.0, 0.5]);
    }

    #[test]
    fn period_maths() {
        assert_eq!(frames_to_hns(480, 48_000), 100_000);
        assert_eq!(hns_to_frames(26_667, 48_000), 128);
        assert_eq!(hns_to_frames(frames_to_hns(64, 44_100), 44_100), 64);
        assert_eq!(align_period(64, 48, 96, 480), 96);
        assert_eq!(align_period(128, 48, 96, 480), 144);
        assert_eq!(align_period(4096, 48, 96, 480), 480);
        assert_eq!(align_period(100, 0, 0, 0), 100);
        assert_eq!(align_period(u32::MAX, 48, 96, 480), 480);
    }
}
