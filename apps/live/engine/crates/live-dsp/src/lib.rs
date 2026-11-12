//! MixAI Live realtime vocal DSP.
//!
//! Every processor is stereo, works in place on blocks of any length, allocates only in its
//! constructor and smooths every audible parameter change. See ADR-0015 and `docs/live/`.

// DSP loops index several parallel fixed-size arrays at once; iterator chains hide that.
#![allow(clippy::needless_range_loop)]
// `Smoothed::next` is a per-sample ramp, not an Iterator (it never ends).
#![allow(clippy::should_implement_trait)]

pub mod biquad;
pub mod chain;
pub mod color;
pub mod delay;
pub mod delay_line;
pub mod dynamics;
pub mod eq;
pub mod modulation;
pub mod param;
pub mod pitch;
pub mod processor;
pub mod reverb;
pub mod tune;

pub use chain::{Chain, FxKind, Insert};
pub use param::{Curve, ParamSpec, Smoothed, Unit, db_to_lin, lin_to_db};
pub use pitch::{PitchInfo, Scale};
pub use processor::Processor;
pub use tune::{Autotune, Harmonizer, TuneStatus, Tuner};

#[cfg(test)]
#[global_allocator]
static ALLOC: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

#[cfg(test)]
pub(crate) mod test_util {
    pub fn sine(freq: f32, sr: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (core::f32::consts::TAU * freq * i as f32 / sr).sin())
            .collect()
    }

    pub fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    /// Voice-like test signal: a jittered pulse train with breath noise, a −12 dB/octave glottal
    /// tilt, five formant resonators of an /a/ vowel and lip radiation, with vibrato of
    /// `vibrato_cents` at 5.5 Hz, normalised to `peak`. Pure sines hide what a pitch shifter does
    /// to a real voice (formant path blow-up, splice roughness); this does not.
    pub fn voice(f0: f32, vibrato_cents: f32, sr: f32, n: usize, peak: f32) -> Vec<f32> {
        use core::f32::consts::{PI, TAU};
        let mut seed = 0x1234_5678u32;
        let mut rnd = move || {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0
        };
        let mut src = vec![0.0f32; n];
        let (mut phase, mut jitter) = (0.0f32, 1.0f32);
        for i in 0..n {
            let f = f0 * 2f32.powf(vibrato_cents * (TAU * 5.5 * i as f32 / sr).sin() / 1200.0);
            let inc = f * jitter / sr;
            phase += inc;
            if phase >= 1.0 {
                phase -= 1.0;
                let frac = phase / inc;
                src[i] += 1.0 - frac;
                if i > 0 {
                    src[i - 1] += frac;
                }
                jitter = 1.0 + 0.006 * rnd();
            }
            src[i] += rnd() * (f / sr).sqrt() * 0.055 * (0.6 + 0.4 * (TAU * phase).cos());
        }
        // Glottal tilt: two one-pole low-passes at 250 Hz.
        let g = (-TAU * 250.0 / sr).exp();
        for _ in 0..2 {
            let mut s = 0.0f32;
            for v in src.iter_mut() {
                s = (1.0 - g) * *v + g * s;
                *v = s;
            }
        }
        // Vocal tract: cascade of two-pole resonators.
        for (fc, bw) in [
            (730.0f32, 90.0f32),
            (1090.0, 110.0),
            (2440.0, 170.0),
            (3400.0, 250.0),
            (4500.0, 300.0),
        ] {
            let c = -(-TAU * bw / sr).exp();
            let b = 2.0 * (-PI * bw / sr).exp() * (TAU * fc / sr).cos();
            let a = 1.0 - b - c;
            let (mut y1, mut y2) = (0.0f32, 0.0f32);
            for v in src.iter_mut() {
                let y = a * *v + b * y1 + c * y2;
                y2 = y1;
                y1 = y;
                *v = y;
            }
        }
        // Lip radiation (first difference) + normalise.
        let mut prev = 0.0f32;
        let mut pk = 0.0f32;
        for v in src.iter_mut() {
            let y = *v - 0.97 * prev;
            prev = *v;
            *v = y;
            pk = pk.max(y.abs());
        }
        let k = peak / pk.max(1e-9);
        for v in src.iter_mut() {
            *v *= k;
        }
        src
    }
}
