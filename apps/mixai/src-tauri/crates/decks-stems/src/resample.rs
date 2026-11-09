//! Offline stereo resampling (rubato FFT, fixed ratio) for the model's 44.1 kHz input.

use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
use rubato::{Fft, FixedSync, Resampler};

use crate::{Result, StemsError};

/// Resample planar stereo `[left, right]` from `from` Hz to `to` Hz. Returns the input unchanged when
/// the rates match. Output length is `round(frames * to / from)`.
pub fn resample_planar(
    left: &[f32],
    right: &[f32],
    from: u32,
    to: u32,
) -> Result<(Vec<f32>, Vec<f32>)> {
    if from == 0 {
        return Err(StemsError::BadSampleRate(from));
    }
    if to == 0 {
        return Err(StemsError::BadSampleRate(to));
    }
    if left.len() != right.len() {
        return Err(StemsError::ChannelMismatch(left.len(), right.len()));
    }
    if from == to || left.is_empty() {
        return Ok((left.to_vec(), right.to_vec()));
    }
    let frames = left.len();
    let want = ((frames as u128 * to as u128 + from as u128 / 2) / from as u128) as usize;
    let mut rs = Fft::<f32>::new(from as usize, to as usize, 1024, 2, FixedSync::Both)
        .map_err(|e| StemsError::Resample(e.to_string()))?;
    let input = vec![left.to_vec(), right.to_vec()];
    let inp = SequentialSliceOfVecs::new(&input, 2, frames)
        .map_err(|e| StemsError::Resample(e.to_string()))?;
    let cap = rs.process_all_needed_output_len(frames);
    let mut out = vec![vec![0.0f32; cap]; 2];
    let produced = {
        let mut outp = SequentialSliceOfVecs::new_mut(&mut out, 2, cap)
            .map_err(|e| StemsError::Resample(e.to_string()))?;
        let (_, produced) = rs
            .process_all_into_buffer(&inp, &mut outp, frames, None)
            .map_err(|e| StemsError::Resample(e.to_string()))?;
        produced
    };
    let n = want.min(produced);
    let mut it = out.into_iter();
    let mut l = it.next().unwrap_or_default();
    let mut r = it.next().unwrap_or_default();
    l.truncate(n);
    r.truncate(n);
    // `produced` can be a frame short of the rounded length; pad with the last sample.
    l.resize(want, l.last().copied().unwrap_or(0.0));
    r.resize(want, r.last().copied().unwrap_or(0.0));
    Ok((l, r))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| (std::f32::consts::TAU * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    #[test]
    fn identity_when_rates_match() {
        let s = sine(440.0, 44_100, 1000);
        let (l, r) = resample_planar(&s, &s, 44_100, 44_100).unwrap();
        assert_eq!(l, s);
        assert_eq!(r, s);
    }

    #[test]
    fn length_follows_ratio() {
        let s = sine(440.0, 48_000, 48_000);
        let (l, r) = resample_planar(&s, &s, 48_000, 44_100).unwrap();
        assert_eq!(l.len(), 44_100);
        assert_eq!(r.len(), 44_100);
    }

    #[test]
    fn round_trip_preserves_a_tone() {
        let s = sine(1000.0, 48_000, 48_000);
        let (l, _) = resample_planar(&s, &s, 48_000, 44_100).unwrap();
        let (back, _) = resample_planar(&l, &l, 44_100, 48_000).unwrap();
        assert_eq!(back.len(), s.len());
        // Compare the steady-state middle (edges see filter ramp-up).
        let mid = 10_000..38_000;
        let err: f32 = mid
            .clone()
            .map(|i| (back[i] - s[i]).abs())
            .fold(0.0, f32::max);
        assert!(err < 0.02, "max error {err}");
    }

    #[test]
    fn rejects_bad_input() {
        assert!(matches!(
            resample_planar(&[0.0], &[0.0, 0.0], 1, 2),
            Err(StemsError::ChannelMismatch(1, 2))
        ));
        assert!(matches!(
            resample_planar(&[0.0], &[0.0], 0, 2),
            Err(StemsError::BadSampleRate(0))
        ));
    }
}
