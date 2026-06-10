//! One-shot **sampler**: a bank of pads, each holding a short stereo buffer that
//! plays from the start when triggered. RT-safe — buffers are loaded off the
//! audio thread (moved in via a command); the callback only reads them and
//! advances a per-pad cursor. No locks, no allocation in `render_frame`.

use crate::deck::TrackBuffer;
use crate::dsp::Smoothed;

/// Number of sampler pads.
pub const NUM_PADS: usize = 8;

/// A single sampler pad: an optional sample plus playback cursor + gain.
struct Pad {
    buffer: Option<TrackBuffer>,
    /// Playback position in source frames (only valid while `playing`).
    pos: f64,
    playing: bool,
    /// One-shot vs. loop. One-shots stop at the end; loops wrap.
    looping: bool,
    gain: Smoothed,
    /// Resample ratio = source_sr / engine_sr.
    rate: f64,
}

impl Pad {
    fn new(sr: f32) -> Self {
        Pad {
            buffer: None,
            pos: 0.0,
            playing: false,
            looping: false,
            gain: Smoothed::new(0.85, sr, 12.0),
            rate: 1.0,
        }
    }

    #[inline]
    fn render(&mut self) -> (f32, f32) {
        let g = self.gain.next();
        if !self.playing {
            return (0.0, 0.0);
        }
        let Some(buf) = self.buffer.as_ref() else {
            self.playing = false;
            return (0.0, 0.0);
        };
        let frames = buf.left.len();
        if frames == 0 {
            self.playing = false;
            return (0.0, 0.0);
        }
        let i = self.pos as usize;
        if i >= frames.saturating_sub(1) {
            if self.looping {
                self.pos = 0.0;
            } else {
                self.playing = false;
                return (0.0, 0.0);
            }
        }
        // Linear interpolation between adjacent source frames.
        let i = self.pos as usize;
        let frac = (self.pos - i as f64) as f32;
        let i1 = (i + 1).min(frames - 1);
        let l = buf.left[i] + (buf.left[i1] - buf.left[i]) * frac;
        let r = buf.right[i] + (buf.right[i1] - buf.right[i]) * frac;
        self.pos += self.rate;
        (l * g, r * g)
    }
}

/// The pad bank.
pub struct Sampler {
    pads: Vec<Pad>,
    sr: f32,
}

impl Sampler {
    pub fn new(sr: f32) -> Self {
        Sampler {
            pads: (0..NUM_PADS).map(|_| Pad::new(sr)).collect(),
            sr,
        }
    }

    /// Load (or replace) a pad's sample. Stops the pad first.
    pub fn load(&mut self, idx: usize, buffer: TrackBuffer) {
        if let Some(p) = self.pads.get_mut(idx) {
            p.rate = buffer.sample_rate as f64 / self.sr as f64;
            p.buffer = Some(buffer);
            p.playing = false;
            p.pos = 0.0;
        }
    }

    /// Clear a pad.
    pub fn clear(&mut self, idx: usize) {
        if let Some(p) = self.pads.get_mut(idx) {
            p.buffer = None;
            p.playing = false;
            p.pos = 0.0;
        }
    }

    /// Trigger a pad from the start (re-trigger restarts playback).
    pub fn trigger(&mut self, idx: usize) {
        if let Some(p) = self.pads.get_mut(idx) {
            if p.buffer.is_some() {
                p.pos = 0.0;
                p.playing = true;
            }
        }
    }

    /// Stop a pad immediately.
    pub fn stop(&mut self, idx: usize) {
        if let Some(p) = self.pads.get_mut(idx) {
            p.playing = false;
        }
    }

    /// Set a pad's gain (0..1.5), smoothed.
    pub fn set_gain(&mut self, idx: usize, gain: f32) {
        if let Some(p) = self.pads.get_mut(idx) {
            p.gain.set_target(gain.clamp(0.0, 1.5));
        }
    }

    /// Toggle one-shot vs. looping playback for a pad.
    pub fn set_looping(&mut self, idx: usize, on: bool) {
        if let Some(p) = self.pads.get_mut(idx) {
            p.looping = on;
        }
    }

    /// True when the pad is currently playing (for UI feedback).
    pub fn is_playing(&self, idx: usize) -> bool {
        self.pads.get(idx).map(|p| p.playing).unwrap_or(false)
    }

    /// Mix all playing pads into one stereo frame.
    #[inline]
    pub fn render_frame(&mut self) -> (f32, f32) {
        let mut l = 0.0f32;
        let mut r = 0.0f32;
        for p in self.pads.iter_mut() {
            let (pl, pr) = p.render();
            l += pl;
            r += pr;
        }
        (l, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(frames: usize, sr: u32) -> TrackBuffer {
        TrackBuffer {
            left: vec![0.5; frames],
            right: vec![0.5; frames],
            sample_rate: sr,
        }
    }

    #[test]
    fn one_shot_plays_then_stops() {
        let mut s = Sampler::new(48_000.0);
        s.load(0, tone(100, 48_000));
        s.set_gain(0, 1.0);
        s.trigger(0);
        assert!(s.is_playing(0));
        let mut nonzero = 0;
        for _ in 0..200 {
            let (l, _r) = s.render_frame();
            if l.abs() > 1e-6 {
                nonzero += 1;
            }
        }
        // Played roughly the sample length, then stopped.
        assert!(nonzero >= 90 && nonzero <= 105, "played {nonzero} frames");
        assert!(!s.is_playing(0));
    }

    #[test]
    fn untriggered_is_silent() {
        let mut s = Sampler::new(48_000.0);
        s.load(0, tone(100, 48_000));
        let (l, r) = s.render_frame();
        assert_eq!((l, r), (0.0, 0.0));
    }

    #[test]
    fn looping_keeps_playing() {
        let mut s = Sampler::new(48_000.0);
        s.load(0, tone(50, 48_000));
        s.set_gain(0, 1.0);
        s.set_looping(0, true);
        s.trigger(0);
        for _ in 0..500 {
            let _ = s.render_frame();
        }
        assert!(s.is_playing(0), "loop should still be playing");
    }
}
