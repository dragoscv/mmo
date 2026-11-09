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
}
