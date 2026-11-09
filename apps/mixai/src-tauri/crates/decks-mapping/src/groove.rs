//! Groove lane: record incoming notes (e.g. Circuit Tracks drums / synths) quantised to a
//! beatgrid position into a serialisable pattern, and schedule its playback.
//!
//! Positions use 96 ticks per quarter note (4× MIDI clock resolution) and 4/4 bars.

use serde::{Deserialize, Serialize};

/// Ticks per quarter note of the groove grid.
pub const GROOVE_PPQ: u32 = 96;
/// Beats per bar (4/4).
pub const BEATS_PER_BAR: u32 = 4;

/// Position on the beatgrid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct GridPos {
    /// 0-based bar.
    pub bar: u32,
    /// 0-based beat within the bar.
    pub beat: u32,
    /// Tick within the beat (0..96).
    pub tick: u32,
}

impl GridPos {
    pub fn from_ticks(t: u64) -> Self {
        let per_bar = u64::from(GROOVE_PPQ * BEATS_PER_BAR);
        Self {
            bar: (t / per_bar) as u32,
            beat: ((t % per_bar) / u64::from(GROOVE_PPQ)) as u32,
            tick: (t % u64::from(GROOVE_PPQ)) as u32,
        }
    }
    pub fn to_ticks(self) -> u64 {
        u64::from(self.bar) * u64::from(GROOVE_PPQ * BEATS_PER_BAR)
            + u64::from(self.beat) * u64::from(GROOVE_PPQ)
            + u64::from(self.tick)
    }
}

/// One recorded note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrooveNote {
    pub pos: GridPos,
    /// 1-based MIDI channel.
    pub channel: u8,
    pub note: u8,
    pub velocity: u8,
    /// Length in grid ticks (0 = trigger only / note-off never seen).
    pub length: u32,
}

/// A recorded loop.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GroovePattern {
    pub bars: u32,
    pub notes: Vec<GrooveNote>,
}

impl GroovePattern {
    pub fn length_ticks(&self) -> u64 {
        u64::from(self.bars.max(1)) * u64::from(GROOVE_PPQ * BEATS_PER_BAR)
    }
}

/// Records note events against a beat position supplied by the host (deck beatgrid or clock
/// follower), quantising starts to `quantize` ticks and wrapping at the pattern length.
#[derive(Debug, Clone)]
pub struct GrooveRecorder {
    pub quantize: u32,
    pattern: GroovePattern,
    channels: Vec<u8>,
    /// Open notes: (channel, note), quantised position, unquantised start (beats).
    open: Vec<OpenNote>,
    /// Replace notes on the same step+key instead of stacking duplicates.
    pub overdub_replace: bool,
}

#[derive(Debug, Clone, Copy)]
struct OpenNote {
    channel: u8,
    note: u8,
    pos: GridPos,
    start: f64,
}

impl GrooveRecorder {
    /// `channels` = 1-based channels to record (empty = all).
    pub fn new(bars: u32, quantize: u32, channels: Vec<u8>) -> Self {
        Self {
            quantize: quantize.max(1),
            pattern: GroovePattern {
                bars: bars.max(1),
                notes: Vec::new(),
            },
            channels,
            open: Vec::new(),
            overdub_replace: true,
        }
    }

    pub fn pattern(&self) -> &GroovePattern {
        &self.pattern
    }

    pub fn into_pattern(self) -> GroovePattern {
        self.pattern
    }

    pub fn clear(&mut self) {
        self.pattern.notes.clear();
        self.open.clear();
    }

    fn quantise(&self, beat_pos: f64) -> u64 {
        let ticks = (beat_pos.max(0.0) * f64::from(GROOVE_PPQ)).round() as u64;
        let q = u64::from(self.quantize);
        let snapped = ((ticks + q / 2) / q) * q;
        snapped % self.pattern.length_ticks()
    }

    /// Note on at `beat_pos` (beats since pattern start, fractional). Channel is 1-based.
    pub fn note_on(&mut self, channel: u8, note: u8, velocity: u8, beat_pos: f64) {
        if !self.channels.is_empty() && !self.channels.contains(&channel) {
            return;
        }
        if velocity == 0 {
            self.note_off(channel, note, beat_pos);
            return;
        }
        let pos = GridPos::from_ticks(self.quantise(beat_pos));
        if self.overdub_replace {
            self.pattern
                .notes
                .retain(|n| !(n.pos == pos && n.channel == channel && n.note == note));
        }
        self.open
            .retain(|o| !(o.channel == channel && o.note == note));
        self.pattern.notes.push(GrooveNote {
            pos,
            channel,
            note,
            velocity,
            length: 0,
        });
        self.open.push(OpenNote {
            channel,
            note,
            pos,
            start: beat_pos,
        });
    }

    /// Note off: sets the length of the matching open note (not quantised, min 1 tick).
    pub fn note_off(&mut self, channel: u8, note: u8, beat_pos: f64) {
        if let Some(i) = self
            .open
            .iter()
            .position(|o| o.channel == channel && o.note == note)
        {
            let o = self.open.remove(i);
            let len = ((beat_pos - o.start).max(0.0) * f64::from(GROOVE_PPQ)).round() as u32;
            if let Some(n) = self
                .pattern
                .notes
                .iter_mut()
                .rev()
                .find(|n| n.channel == channel && n.note == note && n.pos == o.pos)
            {
                n.length = len.max(1);
            }
        }
    }

    /// Keep notes ordered by position (call before saving).
    pub fn sort(&mut self) {
        self.open.clear();
        self.pattern
            .notes
            .sort_by_key(|n| (n.pos, n.channel, n.note));
    }
}

/// A scheduled playback event.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GrooveEvent {
    /// Beat position (unwrapped, beats since playback start) the event is due at.
    pub beat_pos: f64,
    /// 1-based channel.
    pub channel: u8,
    pub note: u8,
    /// 0 = note off.
    pub velocity: u8,
}

/// Loops a pattern: every call returns the events whose beat position falls in
/// `(last_polled, now]`, including note-offs, wrapping endlessly.
#[derive(Debug, Clone)]
pub struct GroovePlayer {
    pattern: GroovePattern,
    last_tick: Option<i64>,
}

impl GroovePlayer {
    pub fn new(mut pattern: GroovePattern) -> Self {
        pattern.notes.sort_by_key(|n| (n.pos, n.channel, n.note));
        Self {
            pattern,
            last_tick: None,
        }
    }

    /// Reset so the next `poll` starts fresh at its position.
    pub fn reset(&mut self) {
        self.last_tick = None;
    }

    /// Events in `(previous poll, beat_pos]` (the first poll includes `beat_pos` itself).
    pub fn poll(&mut self, beat_pos: f64) -> Vec<GrooveEvent> {
        let now = (beat_pos.max(0.0) * f64::from(GROOVE_PPQ)).floor() as i64;
        let from = self.last_tick.unwrap_or(now - 1);
        self.last_tick = Some(now);
        if now <= from {
            return Vec::new();
        }
        let len = self.pattern.length_ticks() as i64;
        let mut out = Vec::new();
        for n in &self.pattern.notes {
            let start = n.pos.to_ticks() as i64;
            let end = start + i64::from(n.length.max(1));
            for (at, vel) in [(start, n.velocity), (end, 0u8)] {
                // smallest occurrence > from: at + k*len
                let k = (from - at).div_euclid(len) + 1;
                let mut t = at + k * len;
                while t <= now {
                    out.push(GrooveEvent {
                        beat_pos: t as f64 / f64::from(GROOVE_PPQ),
                        channel: n.channel,
                        note: n.note,
                        velocity: vel,
                    });
                    t += len;
                }
            }
        }
        out.sort_by(|a, b| {
            a.beat_pos
                .partial_cmp(&b.beat_pos)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.velocity.cmp(&b.velocity))
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_quantised_and_serialise() {
        let mut r = GrooveRecorder::new(1, 24, vec![10]);
        // Slightly late kick on beat 2 (pos 1.04 beats) → snaps to beat 1 tick 0.
        r.note_on(10, 60, 100, 1.04);
        r.note_off(10, 60, 1.20);
        // 16th after beat 3 (2.27) → beat 2 tick 24.
        r.note_on(10, 62, 90, 2.27);
        // Channel 1 is not recorded.
        r.note_on(1, 48, 90, 0.0);
        r.sort();
        let p = r.pattern();
        assert_eq!(p.notes.len(), 2);
        assert_eq!(
            p.notes[0].pos,
            GridPos {
                bar: 0,
                beat: 1,
                tick: 0
            }
        );
        assert_eq!(p.notes[0].length, 15);
        assert_eq!(
            p.notes[1].pos,
            GridPos {
                bar: 0,
                beat: 2,
                tick: 24
            }
        );
        let json = serde_json::to_string(p).unwrap();
        let back: GroovePattern = serde_json::from_str(&json).unwrap();
        assert_eq!(&back, p);
    }

    #[test]
    fn wraps_at_pattern_length_and_plays_back_looping() {
        let mut r = GrooveRecorder::new(1, 24, vec![]);
        r.note_on(10, 60, 100, 4.01); // bar 1 → wraps to bar 0 beat 0
        let p = r.into_pattern();
        assert_eq!(p.notes[0].pos, GridPos::from_ticks(0));
        let mut pl = GroovePlayer::new(p);
        let mut ons = Vec::new();
        for i in 0..120 {
            let pos = f64::from(i) * 0.1;
            for e in pl.poll(pos) {
                if e.velocity > 0 {
                    ons.push(e.beat_pos);
                }
            }
        }
        assert_eq!(ons, vec![0.0, 4.0, 8.0]);
    }
}
