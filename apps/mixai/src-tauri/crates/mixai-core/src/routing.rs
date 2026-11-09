//! Output routing matrix (WP19-06), evaluated inside the single cpal callback.
//!
//! Buses: **master** (crossfaded mix + sampler), **headphones** (PFL cue sum
//! blended with master by `cue_mix`, scaled by `headphone_level`) and an
//! optional **booth** feed (master × `booth_level`). Channel mapping:
//!
//! * 1 ch: master mono.
//! * 2 ch: master stereo, or split-mono (L = headphone mono, R = master mono)
//!   for a laptop + Y-cable / 2-ch interface.
//! * ≥4 ch (unless forced to stereo): ch1/2 master, ch3/4 headphones; ≥6 ch
//!   adds ch5/6 booth when `booth_level > 0`.
//!
//! Each bus has its own latency-compensation delay (ms) so a booth monitor or
//! an outboard mixer path can be aligned with the main PA.

use serde::{Deserialize, Serialize};

/// Max per-output compensation delay.
pub const MAX_COMP_MS: f32 = 250.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
    /// 4-channel mapping when the device has ≥4 channels, else stereo.
    #[default]
    Auto,
    /// Always use only ch1/2 (stereo or split-mono).
    Stereo,
    /// Request the 4-channel mapping (falls back to stereo below 4 channels).
    FourChannel,
}

/// UI-facing routing settings.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RoutingConfig {
    pub mode: OutputMode,
    /// Headphone blend: 0 = cue only, 1 = master only.
    pub cue_mix: f32,
    /// Headphone level, 0..1.5.
    pub headphone_level: f32,
    /// Split-mono on 2-channel outputs (L = cue, R = master).
    pub split_mono: bool,
    /// Booth level, 0..1.5 (0 = booth off).
    pub booth_level: f32,
    pub master_latency_ms: f32,
    pub headphone_latency_ms: f32,
    pub booth_latency_ms: f32,
}

impl Default for RoutingConfig {
    fn default() -> Self {
        RoutingConfig {
            mode: OutputMode::Auto,
            cue_mix: 0.0,
            headphone_level: 0.7,
            split_mono: false,
            booth_level: 0.0,
            master_latency_ms: 0.0,
            headphone_latency_ms: 0.0,
            booth_latency_ms: 0.0,
        }
    }
}

impl RoutingConfig {
    pub fn sanitized(mut self) -> Self {
        let clamp_ms = |v: f32| {
            if v.is_finite() {
                v.clamp(0.0, MAX_COMP_MS)
            } else {
                0.0
            }
        };
        self.cue_mix = if self.cue_mix.is_finite() {
            self.cue_mix.clamp(0.0, 1.0)
        } else {
            0.0
        };
        self.headphone_level = self.headphone_level.clamp(0.0, 1.5);
        self.booth_level = self.booth_level.clamp(0.0, 1.5);
        self.master_latency_ms = clamp_ms(self.master_latency_ms);
        self.headphone_latency_ms = clamp_ms(self.headphone_latency_ms);
        self.booth_latency_ms = clamp_ms(self.booth_latency_ms);
        self
    }

    /// True when the headphone bus goes to ch3/4 for a device with `channels`.
    pub fn four_channel(&self, channels: usize) -> bool {
        channels >= 4 && self.mode != OutputMode::Stereo
    }
}

/// Stereo compensation delay (preallocated for `MAX_COMP_MS`).
pub struct CompDelay {
    l: Vec<f32>,
    r: Vec<f32>,
    w: usize,
    delay: usize,
}

impl CompDelay {
    pub fn new(sample_rate: f32) -> Self {
        let n = (sample_rate * MAX_COMP_MS / 1000.0) as usize + 2;
        CompDelay {
            l: vec![0.0; n],
            r: vec![0.0; n],
            w: 0,
            delay: 0,
        }
    }

    pub fn set_ms(&mut self, ms: f32, sample_rate: f32) {
        let d = (ms.max(0.0) / 1000.0 * sample_rate) as usize;
        self.delay = d.min(self.l.len() - 1);
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.delay == 0 {
            return (l, r);
        }
        let n = self.l.len();
        self.l[self.w] = l;
        self.r[self.w] = r;
        let i = (self.w + n - self.delay) % n;
        self.w = (self.w + 1) % n;
        (self.l[i], self.r[i])
    }
}

/// Write one frame of the three buses into an interleaved device frame.
#[inline]
pub fn write_frame(
    frame: &mut [f32],
    cfg: &RoutingConfig,
    master: (f32, f32),
    phones: (f32, f32),
    booth: (f32, f32),
) {
    let ch = frame.len();
    frame.iter_mut().for_each(|s| *s = 0.0);
    match ch {
        0 => {}
        1 => frame[0] = (master.0 + master.1) * 0.5,
        _ if cfg.four_channel(ch) => {
            frame[0] = master.0;
            frame[1] = master.1;
            frame[2] = phones.0;
            frame[3] = phones.1;
            if ch >= 6 && cfg.booth_level > 0.0 {
                frame[4] = booth.0;
                frame[5] = booth.1;
            }
        }
        _ if cfg.split_mono => {
            frame[0] = (phones.0 + phones.1) * 0.5;
            frame[1] = (master.0 + master.1) * 0.5;
        }
        _ => {
            frame[0] = master.0;
            frame[1] = master.1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_mono_maps_cue_left_master_right() {
        let cfg = RoutingConfig {
            split_mono: true,
            ..Default::default()
        };
        let mut f = [9.0f32; 2];
        write_frame(&mut f, &cfg, (0.0, 0.0), (0.4, 0.2), (0.0, 0.0));
        assert_eq!(f, [0.3, 0.0]);
    }

    #[test]
    fn four_channel_and_booth() {
        let cfg = RoutingConfig {
            booth_level: 1.0,
            ..Default::default()
        };
        let mut f = [0.0f32; 6];
        write_frame(&mut f, &cfg, (0.1, 0.2), (0.3, 0.4), (0.5, 0.6));
        assert_eq!(f, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
        let stereo = RoutingConfig {
            mode: OutputMode::Stereo,
            ..cfg
        };
        write_frame(&mut f, &stereo, (0.1, 0.2), (0.3, 0.4), (0.5, 0.6));
        assert_eq!(f, [0.1, 0.2, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn comp_delay_delays_by_ms() {
        let mut d = CompDelay::new(48_000.0);
        d.set_ms(1.0, 48_000.0);
        let mut first = None;
        for i in 0..200 {
            let (l, _) = d.process(if i == 0 { 1.0 } else { 0.0 }, 0.0);
            if l > 0.5 && first.is_none() {
                first = Some(i);
            }
        }
        assert_eq!(first, Some(48));
    }
}
