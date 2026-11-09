//! MixAI timecode generator (for cutting control vinyl / burning control CDs, and for tests).
//!
//! Signal definition, as a function of the record position φ in carrier cycles:
//!
//! ```text
//! L(φ) = level · A(φ) · sin(2πφ)        R(φ) = level · A(φ) · cos(2πφ)
//! ```
//!
//! so L lags R by 90° when playing forwards. `A(φ)` is 1 for a 1 bit and `zero_level` for a
//! 0 bit of cycle ⌊φ⌋, with a raised-cosine transition over ±0.15 cycles around each cycle
//! boundary (flat middle → robust bit sampling, no clicks on the cutting lathe).

use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::Arc;

use crate::code::{MixAiCode, PositionCode};

/// Default peak level (−1.9 dBFS) — leaves headroom for the cutting chain.
pub const DEFAULT_LEVEL: f32 = 0.8;
/// Half-width of the amplitude transition around each cycle boundary, in cycles.
const RAMP: f64 = 0.15;

/// Renders a timecode signal from any [`PositionCode`].
#[derive(Debug, Clone)]
pub struct TimecodeGenerator {
    code: Arc<dyn PositionCode>,
    sample_rate: f64,
    level: f32,
}

impl TimecodeGenerator {
    /// New generator with the given code, output sample rate and peak level (0..1].
    pub fn new(code: Arc<dyn PositionCode>, sample_rate: u32, level: f32) -> Self {
        Self {
            code,
            sample_rate: sample_rate as f64,
            level: level.clamp(0.0, 1.0),
        }
    }

    /// The code being rendered.
    pub fn code(&self) -> &Arc<dyn PositionCode> {
        &self.code
    }

    fn amp_of(&self, cycle: i64) -> f64 {
        let len = self.code.len_cycles() as i64;
        if self.code.bit(cycle.rem_euclid(len) as u32) {
            1.0
        } else {
            self.code.zero_level() as f64
        }
    }

    /// Envelope `A(φ)` (without `level`).
    pub fn envelope(&self, phi: f64) -> f64 {
        let c = phi.floor();
        let f = phi - c;
        let c = c as i64;
        let blend = |a: f64, b: f64, t: f64| {
            let w = 0.5 - 0.5 * (std::f64::consts::PI * t).cos();
            a + (b - a) * w
        };
        if f < RAMP {
            blend(
                self.amp_of(c - 1),
                self.amp_of(c),
                (f + RAMP) / (2.0 * RAMP),
            )
        } else if f > 1.0 - RAMP {
            blend(
                self.amp_of(c),
                self.amp_of(c + 1),
                (f - (1.0 - RAMP)) / (2.0 * RAMP),
            )
        } else {
            self.amp_of(c)
        }
    }

    /// Stereo sample `(L, R)` at record position `phi` (cycles).
    pub fn sample_at(&self, phi: f64) -> (f32, f32) {
        let a = self.envelope(phi) * self.level as f64;
        let (s, c) = (std::f64::consts::TAU * phi).sin_cos();
        ((a * s) as f32, (a * c) as f32)
    }

    /// Render interleaved stereo at constant `speed` starting at `start_cycle`, filling `out`
    /// (`out.len() / 2` frames). Returns the position after the last frame.
    pub fn render(&self, start_cycle: f64, speed: f64, out: &mut [f32]) -> f64 {
        let step = speed * self.code.carrier_hz() / self.sample_rate;
        let mut phi = start_cycle;
        for f in out.chunks_exact_mut(2) {
            let (l, r) = self.sample_at(phi);
            f[0] = l;
            f[1] = r;
            phi += step;
        }
        phi
    }

    /// Write `minutes` of timecode from cycle 0 at nominal speed as 16-bit PCM stereo WAV.
    pub fn write_wav<W: Write>(&self, mut w: W, minutes: f64) -> io::Result<()> {
        let max = max_minutes_for(self.code.as_ref());
        if minutes.is_nan() || minutes <= 0.0 || minutes > max {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("minutes must be in (0, {max:.2}] for this code"),
            ));
        }
        let frames = (minutes * 60.0 * self.sample_rate).round() as u64;
        let data_len = frames * 4;
        let riff_len = u32::try_from(36 + data_len)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "WAV larger than 4 GiB"))?;
        let sr = self.sample_rate as u32;
        w.write_all(b"RIFF")?;
        w.write_all(&riff_len.to_le_bytes())?;
        w.write_all(b"WAVEfmt ")?;
        w.write_all(&16u32.to_le_bytes())?;
        w.write_all(&1u16.to_le_bytes())?; // PCM
        w.write_all(&2u16.to_le_bytes())?; // stereo
        w.write_all(&sr.to_le_bytes())?;
        w.write_all(&(sr * 4).to_le_bytes())?;
        w.write_all(&4u16.to_le_bytes())?;
        w.write_all(&16u16.to_le_bytes())?;
        w.write_all(b"data")?;
        w.write_all(&(data_len as u32).to_le_bytes())?;
        let step = self.code.carrier_hz() / self.sample_rate;
        let to_i16 = |x: f32| (x.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        for n in 0..frames {
            let (l, r) = self.sample_at(n as f64 * step);
            w.write_all(&to_i16(l).to_le_bytes())?;
            w.write_all(&to_i16(r).to_le_bytes())?;
        }
        w.flush()
    }
}

fn max_minutes_for(code: &dyn PositionCode) -> f64 {
    code.len_cycles() as f64 / code.carrier_hz() / 60.0
}

/// Longest MixAI timecode that stays unique (2^20 − 1 cycles at 1 kHz ≈ 17.48 min).
pub fn max_minutes() -> f64 {
    ((1u64 << crate::code::MIXAI_LFSR_BITS) - 1) as f64 / crate::code::MIXAI_CARRIER_HZ / 60.0
}

/// Write `minutes` of MixAI timecode to `path` (16-bit stereo PCM WAV).
pub fn write_timecode_wav(path: &Path, minutes: f64, sample_rate: u32) -> io::Result<()> {
    let generator = TimecodeGenerator::new(Arc::new(MixAiCode::new()), sample_rate, DEFAULT_LEVEL);
    generator.write_wav(BufWriter::new(File::create(path)?), minutes)
}
