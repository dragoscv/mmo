//! Whole-track separation over a fixed-segment model: resample → segment with linear cross-fades →
//! overlap-add → resample back.

use std::sync::atomic::Ordering;

use crate::resample::resample_planar;
use crate::{CancelFlag, Result, StemKind, StemLayer, Stems, StemsError};

/// A source-separation model that processes one fixed-length stereo segment.
pub trait SegmentModel {
    /// Rate the model expects (HT-Demucs: 44 100 Hz).
    fn sample_rate(&self) -> u32;
    /// Frames per segment (HT-Demucs ONNX: 343 980 = 7.8 s).
    fn segment_frames(&self) -> usize;
    /// `mix` is channel-major `[left.., right..]`, length `2 * segment_frames()` (tensor `(1, 2, N)`).
    /// Returns `(1, 4, 2, N)` flattened in [`StemKind::MODEL_ORDER`].
    fn run(&mut self, mix: &[f32]) -> Result<Vec<f32>>;
}

/// Segment progress, reported after each model call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

/// Separate a stereo track into four stems at the track's own `sample_rate`.
pub fn separate(
    model: &mut dyn SegmentModel,
    left: &[f32],
    right: &[f32],
    sample_rate: u32,
    cancel: Option<&CancelFlag>,
    progress: &mut dyn FnMut(Progress),
) -> Result<Stems> {
    if left.len() != right.len() {
        return Err(StemsError::ChannelMismatch(left.len(), right.len()));
    }
    if left.is_empty() {
        return Err(StemsError::EmptyInput);
    }
    let model_rate = model.sample_rate();
    let (ml, mr) = resample_planar(left, right, sample_rate, model_rate)?;
    let seg = model.segment_frames();
    if seg < 8 {
        return Err(StemsError::Model(format!(
            "segment of {seg} frames is too short"
        )));
    }
    let total = ml.len();
    let overlap = seg / 4;
    let stride = seg - overlap;
    let chunks = if total <= seg {
        1
    } else {
        1 + (total - seg).div_ceil(stride)
    };

    // out[m][c] in model order, model rate.
    let mut out = vec![vec![vec![0.0f32; total]; 2]; 4];
    let mut weight = vec![0.0f32; total];
    let mut mix = vec![0.0f32; 2 * seg];
    let want = 4 * 2 * seg;

    for i in 0..chunks {
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(StemsError::Cancelled);
        }
        let start = i * stride;
        let end = (start + seg).min(total);
        let len = end - start;
        mix.fill(0.0);
        mix[..len].copy_from_slice(&ml[start..end]);
        mix[seg..seg + len].copy_from_slice(&mr[start..end]);
        let y = model.run(&mix)?;
        if y.len() != want {
            return Err(StemsError::ModelShape { got: y.len(), want });
        }
        let fade_in = i > 0;
        let fade_out = i + 1 < chunks;
        for k in 0..len {
            let w = window(k, seg, overlap, fade_in, fade_out);
            weight[start + k] += w;
            for (m, stem) in out.iter_mut().enumerate() {
                for (c, ch) in stem.iter_mut().enumerate() {
                    ch[start + k] += y[(m * 2 + c) * seg + k] * w;
                }
            }
        }
        progress(Progress {
            done: i + 1,
            total: chunks,
        });
    }

    for stem in out.iter_mut() {
        for ch in stem.iter_mut() {
            for (s, w) in ch.iter_mut().zip(&weight) {
                *s /= w.max(1e-8);
            }
        }
    }

    let mut layers: [StemLayer; 4] = Default::default();
    for (m, stem) in out.into_iter().enumerate() {
        let mut it = stem.into_iter();
        let l = it.next().unwrap_or_default();
        let r = it.next().unwrap_or_default();
        let (l, r) = resample_planar(&l, &r, model_rate, sample_rate)?;
        let (l, r) = fit(l, r, left.len());
        layers[StemKind::MODEL_ORDER[m].core_index()] = StemLayer { left: l, right: r };
    }
    Ok(Stems {
        sample_rate,
        layers,
    })
}

/// Linear cross-fade window; fade-in and fade-out of neighbouring chunks sum to exactly 1.
fn window(k: usize, seg: usize, overlap: usize, fade_in: bool, fade_out: bool) -> f32 {
    let mut w = 1.0f32;
    if fade_in && k < overlap {
        w = w.min((k as f32 + 0.5) / overlap as f32);
    }
    if fade_out && k >= seg - overlap {
        w = w.min(1.0 - (k - (seg - overlap)) as f32 / overlap as f32 - 0.5 / overlap as f32);
    }
    w.max(0.0)
}

fn fit(mut l: Vec<f32>, mut r: Vec<f32>, n: usize) -> (Vec<f32>, Vec<f32>) {
    l.resize(n, 0.0);
    r.resize(n, 0.0);
    (l, r)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    /// Linear "separator": drums = 0.5·mix, bass = 0.25·mix, other = 0.25·mix, vocals = 0.
    struct Split {
        rate: u32,
        seg: usize,
        calls: usize,
    }

    impl SegmentModel for Split {
        fn sample_rate(&self) -> u32 {
            self.rate
        }
        fn segment_frames(&self) -> usize {
            self.seg
        }
        fn run(&mut self, mix: &[f32]) -> Result<Vec<f32>> {
            self.calls += 1;
            let gains = [0.5f32, 0.25, 0.25, 0.0];
            let mut y = Vec::with_capacity(4 * mix.len());
            for g in gains {
                y.extend(mix.iter().map(|s| s * g));
            }
            Ok(y)
        }
    }

    fn track(frames: usize) -> (Vec<f32>, Vec<f32>) {
        let l = (0..frames)
            .map(|i| ((i as f32) * 0.013).sin() * 0.6)
            .collect();
        let r = (0..frames)
            .map(|i| ((i as f32) * 0.007).cos() * 0.4)
            .collect();
        (l, r)
    }

    #[test]
    fn overlap_add_reconstructs_a_linear_model_exactly() {
        let (l, r) = track(10_000);
        let mut m = Split {
            rate: 44_100,
            seg: 1024,
            calls: 0,
        };
        let mut seen = Vec::new();
        let s = separate(&mut m, &l, &r, 44_100, None, &mut |p| seen.push(p)).unwrap();
        // 1 + ceil((10000 - 1024) / 768) = 13 segments.
        assert_eq!(m.calls, 13);
        assert_eq!(
            seen.last(),
            Some(&Progress {
                done: 13,
                total: 13
            })
        );
        let drums = s.layer(StemKind::Drums);
        let vocals = s.layer(StemKind::Vocals);
        assert_eq!(s.frames(), 10_000);
        for i in 0..10_000 {
            assert!((drums.left[i] - 0.5 * l[i]).abs() < 1e-5, "drums L @{i}");
            assert!((drums.right[i] - 0.5 * r[i]).abs() < 1e-5, "drums R @{i}");
            assert_eq!(vocals.left[i], 0.0);
        }
        // Sum of stems = mix.
        for i in (0..10_000).step_by(97) {
            let sum: f32 = s.layers.iter().map(|x| x.left[i]).sum();
            assert!((sum - l[i]).abs() < 1e-5);
        }
    }

    #[test]
    fn core_order_is_vocals_drums_bass_other() {
        let (l, r) = track(500);
        let mut m = Split {
            rate: 44_100,
            seg: 256,
            calls: 0,
        };
        let s = separate(&mut m, &l, &r, 44_100, None, &mut |_| {}).unwrap();
        assert_eq!(s.layers[0], *s.layer(StemKind::Vocals));
        assert!((s.layers[1].left[100] - 0.5 * l[100]).abs() < 1e-5); // drums
        assert!((s.layers[2].left[100] - 0.25 * l[100]).abs() < 1e-5); // bass
    }

    #[test]
    fn short_track_is_one_padded_segment() {
        let (l, r) = track(300);
        let mut m = Split {
            rate: 44_100,
            seg: 1024,
            calls: 0,
        };
        let s = separate(&mut m, &l, &r, 44_100, None, &mut |_| {}).unwrap();
        assert_eq!(m.calls, 1);
        assert_eq!(s.frames(), 300);
        assert!((s.layer(StemKind::Bass).left[299] - 0.25 * l[299]).abs() < 1e-6);
    }

    #[test]
    fn resamples_other_rates_and_keeps_length() {
        let (l, r) = track(48_000);
        let mut m = Split {
            rate: 44_100,
            seg: 4096,
            calls: 0,
        };
        let s = separate(&mut m, &l, &r, 48_000, None, &mut |_| {}).unwrap();
        assert_eq!(s.sample_rate, 48_000);
        assert_eq!(s.frames(), 48_000);
        let d = s.layer(StemKind::Drums);
        let err = (10_000..38_000)
            .map(|i| (d.left[i] - 0.5 * l[i]).abs())
            .fold(0.0, f32::max);
        assert!(err < 0.01, "max error {err}");
    }

    #[test]
    fn cancel_stops_between_segments() {
        let (l, r) = track(10_000);
        let flag: CancelFlag = Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        let mut m = Split {
            rate: 44_100,
            seg: 1024,
            calls: 0,
        };
        let res = separate(&mut m, &l, &r, 44_100, Some(&flag), &mut |p| {
            if p.done == 2 {
                f2.store(true, Ordering::Relaxed);
            }
        });
        assert!(matches!(res, Err(StemsError::Cancelled)));
        assert_eq!(m.calls, 2);
    }

    #[test]
    fn wrong_model_shape_is_an_error() {
        struct Bad;
        impl SegmentModel for Bad {
            fn sample_rate(&self) -> u32 {
                44_100
            }
            fn segment_frames(&self) -> usize {
                64
            }
            fn run(&mut self, _: &[f32]) -> Result<Vec<f32>> {
                Ok(vec![0.0; 10])
            }
        }
        let res = separate(
            &mut Bad,
            &[0.1; 100],
            &[0.1; 100],
            44_100,
            None,
            &mut |_| {},
        );
        assert!(matches!(
            res,
            Err(StemsError::ModelShape { got: 10, want: 512 })
        ));
    }

    #[test]
    fn crossfade_weights_sum_to_one() {
        let (seg, ov) = (1024, 256);
        for k in 0..ov {
            let out = window(seg - ov + k, seg, ov, true, true);
            let inn = window(k, seg, ov, true, true);
            assert!((out + inn - 1.0).abs() < 1e-6, "k={k}");
        }
        assert_eq!(window(0, seg, ov, false, true), 1.0);
        assert_eq!(window(seg - 1, seg, ov, true, false), 1.0);
    }
}
