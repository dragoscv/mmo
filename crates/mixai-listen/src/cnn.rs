//! Key CNN inference (feature `cnn`, WP18-16): runs the AllConv ONNX model trained by `train/train_key.py` on
//! the log-frequency spectrogram from `features.rs`, with tract (pure Rust, MIT/Apache, no native runtime, also
//! builds for watchOS). The model is embedded in the binary (< 1 MB).

use tract_onnx::prelude::*;

use crate::features::BINS;
use crate::notation::Key;

const MODEL: &[u8] = include_bytes!("../models/key_cnn.onnx");

pub struct KeyCnn {
    plan: std::sync::Arc<TypedRunnableModel>,
}

/// CNN key reading: softmax over the 24 keys (index = `Key::index`).
#[derive(Debug, Clone, PartialEq)]
pub struct CnnKey {
    pub key: Key,
    pub probability: f64,
    pub probabilities: [f64; 24],
}

impl KeyCnn {
    pub fn load() -> Result<Self, String> {
        let plan = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(MODEL))
            .and_then(|m| m.into_optimized())
            .and_then(|m| m.into_runnable())
            .map_err(|e| format!("key model: {e}"))?;
        Ok(Self { plan })
    }

    /// `frames` rows of `BINS` log-spectrogram values (≥ 10 frames ≈ 2 s).
    pub fn predict(&self, frames: &[[f32; BINS]]) -> Option<CnnKey> {
        if frames.len() < 10 {
            return None;
        }
        let flat: Vec<f32> = frames.iter().flatten().copied().collect();
        let input = Tensor::from_shape(&[1, frames.len(), BINS], &flat).ok()?;
        let out = self.plan.run(tvec!(input.into())).ok()?;
        let logits = out.first()?.to_plain_array_view::<f32>().ok()?;
        let logits: Vec<f64> = logits.iter().map(|&v| v as f64).collect();
        if logits.len() != 24 {
            return None;
        }
        let max = logits.iter().copied().fold(f64::MIN, f64::max);
        let exp: Vec<f64> = logits.iter().map(|v| (v - max).exp()).collect();
        let sum: f64 = exp.iter().sum();
        let probabilities: [f64; 24] = std::array::from_fn(|i| exp[i] / sum);
        let (best, &p) = probabilities.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
        Some(CnnKey { key: Key::from_index(best), probability: p, probabilities })
    }
}
