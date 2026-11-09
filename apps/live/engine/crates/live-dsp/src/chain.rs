//! Effect registry and the insert chain run by the engine.

use crate::color::Saturator;
use crate::delay::Delay;
use crate::dynamics::{Compressor, DeEsser, Gate, Limiter};
use crate::eq::Eq;
use crate::modulation::{Chorus, Doubler};
use crate::param::{ParamSpec, Smoothed, param_index};
use crate::processor::Processor;
use crate::reverb::Reverb;
use crate::tune::{Autotune, Harmonizer, Tuner};

/// Every built-in effect. The string ids are the stable preset/remote format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FxKind {
    Gate,
    Compressor,
    Limiter,
    DeEsser,
    Eq,
    Saturator,
    Doubler,
    Chorus,
    Delay,
    Reverb,
    Autotune,
    Harmonizer,
    Tuner,
}

impl FxKind {
    pub const ALL: [FxKind; 13] = [
        FxKind::Gate,
        FxKind::Eq,
        FxKind::DeEsser,
        FxKind::Compressor,
        FxKind::Autotune,
        FxKind::Harmonizer,
        FxKind::Saturator,
        FxKind::Doubler,
        FxKind::Chorus,
        FxKind::Delay,
        FxKind::Reverb,
        FxKind::Limiter,
        FxKind::Tuner,
    ];

    pub fn id(self) -> &'static str {
        match self {
            FxKind::Gate => "gate",
            FxKind::Compressor => "compressor",
            FxKind::Limiter => "limiter",
            FxKind::DeEsser => "deesser",
            FxKind::Eq => "eq",
            FxKind::Saturator => "saturator",
            FxKind::Doubler => "doubler",
            FxKind::Chorus => "chorus",
            FxKind::Delay => "delay",
            FxKind::Reverb => "reverb",
            FxKind::Autotune => "autotune",
            FxKind::Harmonizer => "harmonizer",
            FxKind::Tuner => "tuner",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.id() == id)
    }

    /// Allocates: call from the control thread, then hand the box to the audio thread.
    pub fn create(self, sample_rate: f32) -> Box<dyn Processor> {
        match self {
            FxKind::Gate => Box::new(Gate::new(sample_rate)),
            FxKind::Compressor => Box::new(Compressor::new(sample_rate)),
            FxKind::Limiter => Box::new(Limiter::new(sample_rate)),
            FxKind::DeEsser => Box::new(DeEsser::new(sample_rate)),
            FxKind::Eq => Box::new(Eq::new(sample_rate)),
            FxKind::Saturator => Box::new(Saturator::new(sample_rate)),
            FxKind::Doubler => Box::new(Doubler::new(sample_rate)),
            FxKind::Chorus => Box::new(Chorus::new(sample_rate)),
            FxKind::Delay => Box::new(Delay::new(sample_rate)),
            FxKind::Reverb => Box::new(Reverb::new(sample_rate)),
            FxKind::Autotune => Box::new(Autotune::new(sample_rate)),
            FxKind::Harmonizer => Box::new(Harmonizer::new(sample_rate)),
            FxKind::Tuner => Box::new(Tuner::new(sample_rate)),
        }
    }

    pub fn specs(self) -> &'static [ParamSpec] {
        // Specs are static per kind; build a throwaway at a nominal rate is wasteful, so keep
        // a tiny instance cache-free path: every processor returns a 'static table.
        self.create(48000.0).specs()
    }
}

/// One slot in the chain: a processor plus bypass crossfade so toggling never clicks.
pub struct Insert {
    pub id: u32,
    pub kind: FxKind,
    pub fx: Box<dyn Processor>,
    enabled: bool,
    wet: Smoothed,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
}

impl Insert {
    /// `max_block` sizes the dry scratch used during the bypass crossfade.
    pub fn new(id: u32, kind: FxKind, sample_rate: f32, max_block: usize) -> Self {
        Self {
            id,
            kind,
            fx: kind.create(sample_rate),
            enabled: true,
            wet: Smoothed::with_ms(1.0, 10.0, sample_rate),
            scratch_l: vec![0.0; max_block],
            scratch_r: vec![0.0; max_block],
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, on: bool) {
        if on && !self.enabled {
            self.fx.reset();
        }
        self.enabled = on;
        self.wet.set(if on { 1.0 } else { 0.0 });
    }

    pub fn set_param_by_id(&mut self, id: &str, value: f32) -> bool {
        match param_index(self.fx.specs(), id) {
            Some(i) => {
                self.fx.set_param(i, value);
                true
            }
            None => false,
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(r.len());
        if !self.enabled && !self.wet.is_smoothing() {
            return; // fully bypassed: zero cost
        }
        if self.enabled && !self.wet.is_smoothing() {
            self.fx.process(&mut l[..n], &mut r[..n]);
            return;
        }
        // Crossfading: keep a dry copy (block-sized chunks if the host block is larger).
        let mut off = 0;
        while off < n {
            let m = (n - off).min(self.scratch_l.len());
            self.scratch_l[..m].copy_from_slice(&l[off..off + m]);
            self.scratch_r[..m].copy_from_slice(&r[off..off + m]);
            self.fx.process(&mut l[off..off + m], &mut r[off..off + m]);
            for i in 0..m {
                let w = self.wet.next();
                l[off + i] = self.scratch_l[i] + w * (l[off + i] - self.scratch_l[i]);
                r[off + i] = self.scratch_r[i] + w * (r[off + i] - self.scratch_r[i]);
            }
            off += m;
        }
    }
}

/// Ordered list of inserts. Structural edits (add/remove/move) allocate and therefore happen
/// on the control thread, which then swaps the whole chain into the audio thread.
#[derive(Default)]
pub struct Chain {
    pub inserts: Vec<Insert>,
}

impl Chain {
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for ins in &mut self.inserts {
            ins.process(l, r);
        }
    }

    pub fn find_mut(&mut self, id: u32) -> Option<&mut Insert> {
        self.inserts.iter_mut().find(|i| i.id == id)
    }

    pub fn latency(&self) -> usize {
        self.inserts
            .iter()
            .filter(|i| i.enabled())
            .map(|i| i.fx.latency())
            .sum()
    }

    pub fn tail_seconds(&self) -> f32 {
        self.inserts
            .iter()
            .filter(|i| i.enabled())
            .map(|i| i.fx.tail_seconds())
            .fold(0.0, f32::max)
    }

    pub fn reset(&mut self) {
        for i in &mut self.inserts {
            i.fx.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::sine;

    #[test]
    fn ids_roundtrip_and_every_kind_processes_finite() {
        for k in FxKind::ALL {
            assert_eq!(FxKind::from_id(k.id()), Some(k));
            let mut ins = Insert::new(1, k, 48000.0, 512);
            let mut l = sine(220.0, 48000.0, 4800, 0.5);
            let mut r = l.clone();
            for (a, b) in l.chunks_mut(97).zip(r.chunks_mut(97)) {
                ins.process(a, b);
            }
            assert!(
                l.iter().chain(&r).all(|x| x.is_finite() && x.abs() < 8.0),
                "{k:?}"
            );
            // Every param accepts min, max and NaN without panicking.
            for (i, s) in ins.fx.specs().iter().enumerate() {
                ins.fx.set_param(i, s.min);
                ins.fx.set_param(i, s.max);
                ins.fx.set_param(i, f32::NAN);
                assert_eq!(ins.fx.param(i), s.default, "{k:?}.{}", s.id);
            }
        }
    }

    #[test]
    fn bypass_crossfade_is_continuous() {
        let mut ins = Insert::new(1, FxKind::Saturator, 48000.0, 256);
        ins.set_param_by_id("drive", 30.0);
        let mut l = sine(220.0, 48000.0, 4800, 0.5);
        let mut r = l.clone();
        ins.set_enabled(false);
        ins.process(&mut l, &mut r);
        let max_step = l
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        assert!(max_step < 0.1, "click {max_step}");
    }

    #[test]
    fn processing_does_not_allocate() {
        let mut chain = Chain::default();
        for (n, k) in FxKind::ALL.into_iter().enumerate() {
            chain.inserts.push(Insert::new(n as u32, k, 48000.0, 128));
        }
        let mut l = sine(220.0, 48000.0, 128, 0.5);
        let mut r = l.clone();
        // Warm up (first LPC compute etc.).
        for _ in 0..50 {
            chain.process(&mut l, &mut r);
        }
        assert_no_alloc::assert_no_alloc(|| {
            for _ in 0..200 {
                chain.process(&mut l, &mut r);
            }
            chain
                .find_mut(3)
                .unwrap()
                .set_param_by_id("threshold", -20.0);
        });
    }
}
