//! Windowed magnitude spectrum on top of `realfft`.

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex, num_complex::Complex};

pub(crate) fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos())
        .collect()
}

/// Hann-windowed magnitude spectrum, scaled so a full-scale sine reads 1.0 at its peak bin.
pub(crate) struct MagSpectrum {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    input: Vec<f32>,
    output: Vec<Complex<f32>>,
    scale: f32,
    pub mags: Vec<f32>,
}

impl MagSpectrum {
    pub fn new(n: usize) -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(n);
        let input = fft.make_input_vec();
        let output = fft.make_output_vec();
        let window = hann(n);
        let scale = 2.0 / window.iter().sum::<f32>();
        Self { mags: vec![0.0; output.len()], fft, window, input, output, scale }
    }

    pub fn len(&self) -> usize {
        self.window.len()
    }

    pub fn compute(&mut self, frame: &[f32]) {
        for ((d, s), w) in self.input.iter_mut().zip(frame).zip(&self.window) {
            *d = s * w;
        }
        // Lengths always match the plan, so `process` cannot fail.
        let _ = self.fft.process(&mut self.input, &mut self.output);
        for (m, c) in self.mags.iter_mut().zip(&self.output) {
            *m = c.norm() * self.scale;
        }
    }
}

pub(crate) fn next_pow2(x: usize) -> usize {
    x.max(1).next_power_of_two()
}
