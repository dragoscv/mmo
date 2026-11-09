//! MIDI clock generator and follower — pure, timestamp-driven (no threads, no sleeping).
//!
//! Timestamps are microseconds on any monotonic timebase the host chooses (midir delivers µs).
//! The host calls [`ClockGenerator::poll`] from its audio / UI tick with "now" and sends what
//! comes back; it feeds received realtime bytes to [`ClockFollower::on_message`].

use crate::message::MidiMessage;

/// MIDI clock resolution: 24 pulses per quarter note.
pub const PPQN: u32 = 24;
/// Clocks per MIDI beat (16th note) as used by Song Position Pointer.
pub const CLOCKS_PER_SPP: u32 = 6;

/// A scheduled outgoing realtime message.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockEvent {
    /// Exact due time in µs (fractional so long runs do not drift).
    pub at_us: f64,
    pub message: ClockMessage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockMessage {
    Tick,
    Start,
    Stop,
    Continue,
    /// Song Position Pointer in 16th notes.
    SongPosition(u16),
}

impl ClockMessage {
    pub fn to_bytes(self) -> Vec<u8> {
        match self {
            ClockMessage::Tick => vec![0xF8],
            ClockMessage::Start => vec![0xFA],
            ClockMessage::Stop => vec![0xFC],
            ClockMessage::Continue => vec![0xFB],
            ClockMessage::SongPosition(p) => MidiMessage::SongPosition(p).to_bytes(),
        }
    }
}

/// MIDI clock master: 24 ticks per beat from a BPM and a phase reference.
#[derive(Debug, Clone)]
pub struct ClockGenerator {
    bpm: f64,
    running: bool,
    /// Time of the next tick (µs).
    next_tick_us: f64,
    /// Ticks emitted since Start (or since the last song-position set).
    ticks: u64,
    pending: Vec<ClockEvent>,
}

impl ClockGenerator {
    pub fn new(bpm: f64) -> Self {
        Self {
            bpm: bpm.max(1.0),
            running: false,
            next_tick_us: 0.0,
            ticks: 0,
            pending: Vec::new(),
        }
    }

    pub fn bpm(&self) -> f64 {
        self.bpm
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    /// Tick interval in µs.
    pub fn tick_interval_us(&self) -> f64 {
        60_000_000.0 / (self.bpm * f64::from(PPQN))
    }

    /// Change tempo; the next tick keeps its phase relative to the previous tick.
    pub fn set_bpm(&mut self, bpm: f64) {
        let bpm = bpm.max(1.0);
        if self.running {
            let last = self.next_tick_us - self.tick_interval_us();
            self.bpm = bpm;
            self.next_tick_us = last + self.tick_interval_us();
        } else {
            self.bpm = bpm;
        }
    }

    /// Start at `now_us` from the top (SPP 0). `phase` (0..1 of a beat) delays the first tick so
    /// the downbeat lands on the host's beatgrid: first tick at `now + (1 - phase) * beat`
    /// when `phase > 0`.
    pub fn start(&mut self, now_us: f64, phase: f64) {
        self.running = true;
        self.ticks = 0;
        let beat = self.tick_interval_us() * f64::from(PPQN);
        let offset = if phase > 0.0 {
            (1.0 - phase.fract()) * beat
        } else {
            0.0
        };
        self.pending.push(ClockEvent {
            at_us: now_us,
            message: ClockMessage::Start,
        });
        self.next_tick_us = now_us + offset;
    }

    /// Stop immediately.
    pub fn stop(&mut self, now_us: f64) {
        if self.running {
            self.running = false;
            self.pending.push(ClockEvent {
                at_us: now_us,
                message: ClockMessage::Stop,
            });
        }
    }

    /// Continue from the current song position.
    pub fn resume(&mut self, now_us: f64) {
        if !self.running {
            self.running = true;
            self.pending.push(ClockEvent {
                at_us: now_us,
                message: ClockMessage::Continue,
            });
            self.next_tick_us = now_us;
        }
    }

    /// Set the song position (16th notes). Must be sent while stopped per MIDI 1.0.
    pub fn set_song_position(&mut self, now_us: f64, sixteenths: u16) {
        self.ticks = u64::from(sixteenths) * u64::from(CLOCKS_PER_SPP);
        self.pending.push(ClockEvent {
            at_us: now_us,
            message: ClockMessage::SongPosition(sixteenths),
        });
    }

    /// Current position in 16th notes.
    pub fn song_position(&self) -> u16 {
        (self.ticks / u64::from(CLOCKS_PER_SPP)).min(0x3FFF) as u16
    }

    /// Every event due at or before `now_us`, in order. Call as often as convenient; a late
    /// call emits all missed ticks with their exact timestamps.
    pub fn poll(&mut self, now_us: f64) -> Vec<ClockEvent> {
        let mut out = std::mem::take(&mut self.pending);
        if self.running {
            let iv = self.tick_interval_us();
            let mut n = 0u64;
            let base = self.next_tick_us;
            while base + (n as f64) * iv <= now_us {
                out.push(ClockEvent {
                    at_us: base + (n as f64) * iv,
                    message: ClockMessage::Tick,
                });
                n += 1;
            }
            self.next_tick_us = base + (n as f64) * iv;
            self.ticks += n;
        }
        out
    }

    /// Next due time (for scheduling a timer), if running.
    pub fn next_due_us(&self) -> Option<f64> {
        if !self.pending.is_empty() {
            return self.pending.first().map(|e| e.at_us);
        }
        self.running.then_some(self.next_tick_us)
    }
}

/// Transport state seen by the follower.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FollowState {
    #[default]
    Stopped,
    Running,
}

/// MIDI clock slave: estimates BPM from incoming ticks with jitter smoothing.
///
/// Keeps a sliding window of the last `window` tick timestamps (default two beats = 48) and
/// fits `t(i) = a + b·i` by **minimax (Chebyshev) regression**: the slope minimising the
/// largest residual. USB / OS MIDI jitter is bounded (polling intervals), and for bounded
/// jitter the minimax slope error shrinks as ~J/n² instead of least squares' ~J/n^1.5 — at
/// 128 BPM with ±1 ms jitter two beats give < 0.02 BPM error (LS: ~0.04 BPM σ).
/// A gap > 0.5 s or a backwards timestamp resets the window (source restarted / re-clocked).
#[derive(Debug, Clone)]
pub struct ClockFollower {
    window: usize,
    times: std::collections::VecDeque<f64>,
    ticks_total: u64,
    state: FollowState,
    song_position: u16,
    bpm: Option<f64>,
    /// Ticks since the last song position (for the current position).
    ticks_since_spp: u64,
}

/// What a received realtime message meant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FollowEvent {
    Started,
    Stopped,
    Continued,
    SongPosition(u16),
    /// Tick processed; `bpm` once enough ticks arrived.
    Tick {
        bpm: Option<f64>,
    },
}

impl Default for ClockFollower {
    fn default() -> Self {
        Self::new(2 * PPQN as usize)
    }
}

impl ClockFollower {
    /// `window` = number of tick timestamps kept (≥ 3).
    pub fn new(window: usize) -> Self {
        Self {
            window: window.max(3),
            times: std::collections::VecDeque::new(),
            ticks_total: 0,
            state: FollowState::Stopped,
            song_position: 0,
            bpm: None,
            ticks_since_spp: 0,
        }
    }

    pub fn bpm(&self) -> Option<f64> {
        self.bpm
    }
    pub fn state(&self) -> FollowState {
        self.state
    }
    pub fn ticks(&self) -> u64 {
        self.ticks_total
    }

    /// Current position in 16th notes.
    pub fn song_position(&self) -> u16 {
        let p = u64::from(self.song_position) + self.ticks_since_spp / u64::from(CLOCKS_PER_SPP);
        p.min(0x3FFF) as u16
    }

    /// Clock ticks since song position 0 (Start, or the last SPP plus ticks since).
    pub fn ticks_since_start(&self) -> u64 {
        u64::from(self.song_position) * u64::from(CLOCKS_PER_SPP) + self.ticks_since_spp
    }

    /// Beat phase 0..1 within the current quarter note.
    pub fn beat_phase(&self) -> f64 {
        let t = (u64::from(self.song_position) * u64::from(CLOCKS_PER_SPP) + self.ticks_since_spp)
            % u64::from(PPQN);
        t as f64 / f64::from(PPQN)
    }

    /// Feed a received message with its timestamp in µs.
    pub fn on_message(&mut self, msg: &MidiMessage, at_us: f64) -> Option<FollowEvent> {
        match msg {
            MidiMessage::TimingClock => Some(self.on_tick(at_us)),
            MidiMessage::Start => {
                self.state = FollowState::Running;
                self.song_position = 0;
                self.ticks_since_spp = 0;
                Some(FollowEvent::Started)
            }
            MidiMessage::Continue => {
                self.state = FollowState::Running;
                Some(FollowEvent::Continued)
            }
            MidiMessage::Stop => {
                self.state = FollowState::Stopped;
                Some(FollowEvent::Stopped)
            }
            MidiMessage::SongPosition(p) => {
                self.song_position = *p;
                self.ticks_since_spp = 0;
                Some(FollowEvent::SongPosition(*p))
            }
            _ => None,
        }
    }

    fn on_tick(&mut self, at_us: f64) -> FollowEvent {
        // A gap longer than 0.5 s (< 5 BPM) means the source restarted; forget the history.
        if let Some(&last) = self.times.back() {
            if at_us - last > 500_000.0 || at_us < last {
                self.times.clear();
            }
        }
        self.times.push_back(at_us);
        while self.times.len() > self.window {
            self.times.pop_front();
        }
        self.ticks_total += 1;
        if self.state == FollowState::Running {
            self.ticks_since_spp += 1;
        }
        self.bpm = self.estimate();
        FollowEvent::Tick { bpm: self.bpm }
    }

    fn estimate(&self) -> Option<f64> {
        let n = self.times.len();
        if n < 3 {
            return None;
        }
        let t0 = self.times[0];
        let span = self.times[n - 1] - t0;
        if span <= 0.0 {
            return None;
        }
        // Residual range R(b) = max(t_i - b·i) - min(t_i - b·i) is convex in b; ternary-search
        // it around the endpoint slope.
        let range = |b: f64| {
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            for (i, t) in self.times.iter().enumerate() {
                let r = (t - t0) - b * i as f64;
                lo = lo.min(r);
                hi = hi.max(r);
            }
            hi - lo
        };
        let guess = span / (n - 1) as f64;
        let (mut lo, mut hi) = (guess * 0.5, guess * 1.5);
        for _ in 0..100 {
            let m1 = lo + (hi - lo) / 3.0;
            let m2 = hi - (hi - lo) / 3.0;
            if range(m1) <= range(m2) {
                hi = m2;
            } else {
                lo = m1;
            }
        }
        let interval_us = (lo + hi) / 2.0;
        if interval_us <= 0.0 {
            return None;
        }
        Some(60_000_000.0 / (interval_us * f64::from(PPQN)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generator_24_ticks_per_beat_at_128_bpm_within_100us() {
        let mut g = ClockGenerator::new(128.0);
        g.start(1_000.0, 0.0);
        let beat_us = 60_000_000.0 / 128.0;
        // Poll in irregular steps over 8 beats.
        let mut ticks = Vec::new();
        let mut now = 1_000.0;
        let mut step = 0;
        while now <= 1_000.0 + 8.0 * beat_us {
            for e in g.poll(now) {
                if e.message == ClockMessage::Tick {
                    ticks.push(e.at_us);
                }
            }
            step += 1;
            now += 700.0 + f64::from(step % 7) * 311.0;
        }
        for e in g.poll(1_000.0 + 8.0 * beat_us + 1.0) {
            if e.message == ClockMessage::Tick {
                ticks.push(e.at_us);
            }
        }
        // 8 beats inclusive of both ends = 8*24 + 1 ticks.
        assert_eq!(ticks.len(), 8 * 24 + 1);
        for (i, t) in ticks.iter().enumerate() {
            let ideal = 1_000.0 + i as f64 * beat_us / 24.0;
            assert!(
                (t - ideal).abs() < 100.0,
                "tick {i} off by {} us",
                t - ideal
            );
        }
        // Exactly 24 ticks inside each beat window [k*beat, (k+1)*beat).
        for k in 0..8 {
            let lo = 1_000.0 + k as f64 * beat_us;
            let hi = lo + beat_us;
            let n = ticks
                .iter()
                .filter(|&&t| t >= lo - 1e-6 && t < hi - 1e-6)
                .count();
            assert_eq!(n, 24, "beat {k}");
        }
        assert_eq!(g.song_position(), (8 * 24 + 1) / 6);
    }

    #[test]
    fn generator_start_stop_continue_spp() {
        let mut g = ClockGenerator::new(120.0);
        g.start(0.0, 0.0);
        let ev = g.poll(0.0);
        assert_eq!(ev[0].message, ClockMessage::Start);
        assert_eq!(ev[1].message, ClockMessage::Tick);
        g.stop(10.0);
        assert_eq!(g.poll(1_000_000.0)[0].message, ClockMessage::Stop);
        g.set_song_position(0.0, 16);
        assert_eq!(g.song_position(), 16);
        g.resume(2_000_000.0);
        let ev = g.poll(2_000_000.0);
        assert_eq!(ev[0].message, ClockMessage::SongPosition(16));
        assert_eq!(ev[1].message, ClockMessage::Continue);
        assert_eq!(ev[2].message, ClockMessage::Tick);
        // Phase: half a beat in → first tick half a beat later.
        let mut g = ClockGenerator::new(120.0);
        g.start(0.0, 0.5);
        assert!(
            g.poll(249_000.0)
                .iter()
                .all(|e| e.message != ClockMessage::Tick)
        );
        assert_eq!(
            g.poll(250_000.0).last().unwrap().message,
            ClockMessage::Tick
        );
        assert_eq!(
            ClockMessage::SongPosition(200).to_bytes(),
            vec![0xF2, 72, 1]
        );
    }

    /// Deterministic ±1 ms jitter (xorshift).
    fn jitter(seed: &mut u64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed % 2001) as f64 - 1000.0 // -1000..=1000 µs
    }

    #[test]
    fn follower_converges_within_two_beats_with_1ms_jitter() {
        for seed0 in [1u64, 7, 42, 1234, 99991] {
            let mut seed = seed0;
            let mut f = ClockFollower::default();
            f.on_message(&MidiMessage::Start, 0.0);
            let iv = 60_000_000.0 / (128.0 * 24.0);
            let mut last = None;
            for i in 0..48 {
                let t = 10_000.0 + i as f64 * iv + jitter(&mut seed);
                if let Some(FollowEvent::Tick { bpm }) = f.on_message(&MidiMessage::TimingClock, t)
                {
                    last = bpm;
                }
            }
            let bpm = last.expect("estimate after 2 beats");
            assert!(
                (127.9..=128.1).contains(&bpm),
                "seed {seed0}: bpm {bpm} out of range"
            );
            assert_eq!(f.song_position(), 8);
        }
    }

    #[test]
    fn follower_tracks_tempo_change_and_resets_after_gap() {
        let mut f = ClockFollower::default();
        let iv = 60_000_000.0 / (100.0 * 24.0);
        for i in 0..30 {
            f.on_message(&MidiMessage::TimingClock, i as f64 * iv);
        }
        assert!((f.bpm().unwrap() - 100.0).abs() < 0.01);
        let base = 30.0 * iv + 2_000_000.0; // 2 s gap → reset
        let iv2 = 60_000_000.0 / (140.0 * 24.0);
        for i in 0..30 {
            f.on_message(&MidiMessage::TimingClock, base + i as f64 * iv2);
        }
        assert!((f.bpm().unwrap() - 140.0).abs() < 0.01);
    }
}
