//! Round-trip latency measurement: the output plays a short click train, the input is scanned for
//! the click. Needs an acoustic or cable loopback (or a Voicemeeter route from the output strip
//! back to the input). Pure state machine so it is testable without devices.

/// Clicks emitted per measurement; the median round trip is reported.
pub const CLICKS: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    Idle,
    Running,
    Done { samples: u32 },
    Failed,
}

pub struct LatencyProbe {
    sr: f32,
    phase: Phase,
    t: u64,
    period: u64,
    sent_at: [u64; CLICKS],
    found: [Option<u64>; CLICKS],
    sent: usize,
    threshold: f32,
    noise: f32,
    timeout: u64,
}

impl LatencyProbe {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sr: sample_rate,
            phase: Phase::Idle,
            t: 0,
            period: (sample_rate * 0.4) as u64,
            sent_at: [0; CLICKS],
            found: [None; CLICKS],
            sent: 0,
            threshold: 0.05,
            noise: 0.0,
            timeout: (sample_rate * 0.35) as u64,
        }
    }

    pub fn start(&mut self) {
        self.phase = Phase::Running;
        self.t = 0;
        self.sent = 0;
        self.found = [None; CLICKS];
        self.noise = 0.0;
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn result_ms(&self) -> Option<f32> {
        match self.phase {
            Phase::Done { samples } => Some(samples as f32 * 1000.0 / self.sr),
            _ => None,
        }
    }

    /// Process one frame: `input` = loudest input sample this frame, returns the output sample.
    #[inline]
    pub fn tick(&mut self, input: f32) -> f32 {
        if self.phase != Phase::Running {
            return 0.0;
        }
        let t = self.t;
        self.t += 1;
        // 100 ms of pre-roll measures the noise floor and sets the detection threshold.
        let pre = (self.sr * 0.1) as u64;
        if t < pre {
            self.noise = self.noise.max(input.abs());
            return 0.0;
        }
        if t == pre {
            self.threshold = (self.noise * 4.0).max(0.02);
        }
        let rel = t - pre;
        let mut out = 0.0;
        if self.sent < CLICKS && rel == self.sent as u64 * self.period {
            self.sent_at[self.sent] = t;
            self.sent += 1;
        }
        // 2-sample click (broadband, easy to detect, inaudible as a tone).
        if self.sent > 0 {
            let since = t - self.sent_at[self.sent - 1];
            if since < 2 {
                out = if since == 0 { 0.9 } else { -0.9 };
            }
        }
        // Detect the click that is currently outstanding.
        if self.sent > 0 {
            let k = self.sent - 1;
            let since = t - self.sent_at[k];
            if self.found[k].is_none()
                && since >= 1
                && since < self.timeout
                && input.abs() > self.threshold
            {
                self.found[k] = Some(since);
            }
        }
        if self.sent == CLICKS && rel >= CLICKS as u64 * self.period {
            // Fixed-size median: no allocation on the audio thread.
            let mut v = [u64::MAX; CLICKS];
            let mut n = 0;
            for f in self.found.iter().flatten() {
                v[n] = *f;
                n += 1;
            }
            self.phase = if n > CLICKS / 2 {
                v[..n].sort_unstable();
                Phase::Done {
                    samples: v[n / 2] as u32,
                }
            } else {
                Phase::Failed
            };
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulated loopback with a fixed delay and noise.
    fn run(delay: usize, gain: f32, noise: f32) -> Phase {
        let mut p = LatencyProbe::new(48000.0);
        p.start();
        let mut line = vec![0.0f32; delay + 1];
        let len = line.len();
        let mut seed = 1u32;
        for i in 0..48000 * 3 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let n = (seed >> 9) as f32 / (1u32 << 23) as f32 - 0.5;
            let input = line[i % len] * gain + n * noise;
            let out = p.tick(input);
            line[i % len] = out;
            if p.phase() != Phase::Running {
                break;
            }
        }
        p.phase()
    }

    #[test]
    fn measures_known_delay() {
        assert_eq!(run(480, 0.5, 0.002), Phase::Done { samples: 480 + 1 });
    }

    #[test]
    fn fails_without_loopback() {
        assert_eq!(run(480, 0.0, 0.002), Phase::Failed);
    }
}
