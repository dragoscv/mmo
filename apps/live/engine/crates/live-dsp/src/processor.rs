//! The common interface of every effect.

use crate::param::ParamSpec;
use crate::tune::TuneStatus;

/// A realtime stereo processor. Rules for implementors:
/// - every allocation happens in the constructor (`new(sample_rate)`), never in `process`;
/// - `set_param` may be called from the audio thread between blocks and must be cheap and
///   allocation-free (store a target, let a [`crate::Smoothed`] ramp to it);
/// - `process` works in place on equally long left/right slices of any length.
pub trait Processor: Send {
    /// Static parameter table, index order = `set_param` index.
    fn specs(&self) -> &'static [ParamSpec];
    fn set_param(&mut self, index: usize, value: f32);
    fn param(&self, index: usize) -> f32;
    fn process(&mut self, left: &mut [f32], right: &mut [f32]);
    /// Clear internal state (delay lines, envelopes) without changing parameters.
    fn reset(&mut self);
    /// Algorithmic latency in samples added by this processor.
    fn latency(&self) -> usize {
        0
    }
    /// Seconds of audible tail after the input stops (used by glitch-free scene switching).
    fn tail_seconds(&self) -> f32 {
        0.0
    }
    /// Gain reduction in dB for meters (dynamics only; 0 otherwise).
    fn gain_reduction_db(&self) -> f32 {
        0.0
    }
    /// Pitch telemetry (autotune / tuner only).
    fn tune_status(&self) -> Option<TuneStatus> {
        None
    }
}

/// Store a clamped parameter value; returns the clamped value.
pub(crate) fn store(
    values: &mut [f32],
    specs: &[ParamSpec],
    index: usize,
    value: f32,
) -> Option<f32> {
    let spec = specs.get(index)?;
    let v = spec.clamp(value);
    values[index] = v;
    Some(v)
}

/// Default values of a spec table, written into a fixed array.
pub(crate) fn defaults<const N: usize>(specs: &[ParamSpec]) -> [f32; N] {
    let mut out = [0.0; N];
    for (o, s) in out.iter_mut().zip(specs) {
        *o = s.default;
    }
    out
}
