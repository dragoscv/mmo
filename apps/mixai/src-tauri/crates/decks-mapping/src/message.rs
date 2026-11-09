//! MIDI 1.0 byte-stream parsing (channel voice, system common, realtime, SysEx).

use serde::{Deserialize, Serialize};

/// One decoded MIDI 1.0 message. Channels are **0-based** here (0..=15); the mapping format
/// uses 1-based channels, as printed in manufacturers' documentation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MidiMessage {
    /// Note Off — also produced for Note On with velocity 0 (MIDI 1.0 running-status idiom).
    NoteOff {
        channel: u8,
        note: u8,
        velocity: u8,
    },
    NoteOn {
        channel: u8,
        note: u8,
        velocity: u8,
    },
    PolyPressure {
        channel: u8,
        note: u8,
        pressure: u8,
    },
    ControlChange {
        channel: u8,
        controller: u8,
        value: u8,
    },
    ProgramChange {
        channel: u8,
        program: u8,
    },
    ChannelPressure {
        channel: u8,
        pressure: u8,
    },
    /// 14-bit value, 8192 = centre.
    PitchBend {
        channel: u8,
        value: u16,
    },
    /// Complete SysEx including the leading `F0` and trailing `F7`.
    SysEx(Vec<u8>),
    MtcQuarterFrame(u8),
    /// Song Position Pointer in MIDI beats (16th notes = 6 clocks each).
    SongPosition(u16),
    SongSelect(u8),
    TuneRequest,
    TimingClock,
    Start,
    Continue,
    Stop,
    ActiveSensing,
    Reset,
}

impl MidiMessage {
    /// Encode to wire bytes (full status, no running status).
    pub fn to_bytes(&self) -> Vec<u8> {
        match *self {
            Self::NoteOff {
                channel,
                note,
                velocity,
            } => vec![0x80 | (channel & 0x0F), note & 0x7F, velocity & 0x7F],
            Self::NoteOn {
                channel,
                note,
                velocity,
            } => vec![0x90 | (channel & 0x0F), note & 0x7F, velocity & 0x7F],
            Self::PolyPressure {
                channel,
                note,
                pressure,
            } => vec![0xA0 | (channel & 0x0F), note & 0x7F, pressure & 0x7F],
            Self::ControlChange {
                channel,
                controller,
                value,
            } => vec![0xB0 | (channel & 0x0F), controller & 0x7F, value & 0x7F],
            Self::ProgramChange { channel, program } => {
                vec![0xC0 | (channel & 0x0F), program & 0x7F]
            }
            Self::ChannelPressure { channel, pressure } => {
                vec![0xD0 | (channel & 0x0F), pressure & 0x7F]
            }
            Self::PitchBend { channel, value } => vec![
                0xE0 | (channel & 0x0F),
                (value & 0x7F) as u8,
                ((value >> 7) & 0x7F) as u8,
            ],
            Self::SysEx(ref b) => b.clone(),
            Self::MtcQuarterFrame(v) => vec![0xF1, v & 0x7F],
            Self::SongPosition(v) => vec![0xF2, (v & 0x7F) as u8, ((v >> 7) & 0x7F) as u8],
            Self::SongSelect(v) => vec![0xF3, v & 0x7F],
            Self::TuneRequest => vec![0xF6],
            Self::TimingClock => vec![0xF8],
            Self::Start => vec![0xFA],
            Self::Continue => vec![0xFB],
            Self::Stop => vec![0xFC],
            Self::ActiveSensing => vec![0xFE],
            Self::Reset => vec![0xFF],
        }
    }

    /// True for single-byte realtime messages (`F8`..`FF`).
    pub fn is_realtime(&self) -> bool {
        matches!(
            self,
            Self::TimingClock
                | Self::Start
                | Self::Continue
                | Self::Stop
                | Self::ActiveSensing
                | Self::Reset
        )
    }

    /// 0-based channel for channel-voice messages.
    pub fn channel(&self) -> Option<u8> {
        match *self {
            Self::NoteOff { channel, .. }
            | Self::NoteOn { channel, .. }
            | Self::PolyPressure { channel, .. }
            | Self::ControlChange { channel, .. }
            | Self::ProgramChange { channel, .. }
            | Self::ChannelPressure { channel, .. }
            | Self::PitchBend { channel, .. } => Some(channel),
            _ => None,
        }
    }
}

/// Number of data bytes following a status byte, or `None` for variable length (SysEx) /
/// undefined statuses.
pub fn data_len(status: u8) -> Option<usize> {
    match status {
        0x80..=0xBF | 0xE0..=0xEF => Some(2),
        0xC0..=0xDF => Some(1),
        0xF1 | 0xF3 => Some(1),
        0xF2 => Some(2),
        0xF6 | 0xF8..=0xFF => Some(0),
        _ => None,
    }
}

/// Build a message from a status byte and exactly [`data_len`] data bytes.
pub fn from_parts(status: u8, data: &[u8]) -> Option<MidiMessage> {
    let ch = status & 0x0F;
    let d0 = data.first().copied().unwrap_or(0) & 0x7F;
    let d1 = data.get(1).copied().unwrap_or(0) & 0x7F;
    Some(match status & 0xF0 {
        0x80 => MidiMessage::NoteOff {
            channel: ch,
            note: d0,
            velocity: d1,
        },
        0x90 if d1 == 0 => MidiMessage::NoteOff {
            channel: ch,
            note: d0,
            velocity: 0,
        },
        0x90 => MidiMessage::NoteOn {
            channel: ch,
            note: d0,
            velocity: d1,
        },
        0xA0 => MidiMessage::PolyPressure {
            channel: ch,
            note: d0,
            pressure: d1,
        },
        0xB0 => MidiMessage::ControlChange {
            channel: ch,
            controller: d0,
            value: d1,
        },
        0xC0 => MidiMessage::ProgramChange {
            channel: ch,
            program: d0,
        },
        0xD0 => MidiMessage::ChannelPressure {
            channel: ch,
            pressure: d0,
        },
        0xE0 => MidiMessage::PitchBend {
            channel: ch,
            value: u16::from(d0) | (u16::from(d1) << 7),
        },
        _ => match status {
            0xF1 => MidiMessage::MtcQuarterFrame(d0),
            0xF2 => MidiMessage::SongPosition(u16::from(d0) | (u16::from(d1) << 7)),
            0xF3 => MidiMessage::SongSelect(d0),
            0xF6 => MidiMessage::TuneRequest,
            0xF8 => MidiMessage::TimingClock,
            0xFA => MidiMessage::Start,
            0xFB => MidiMessage::Continue,
            0xFC => MidiMessage::Stop,
            0xFE => MidiMessage::ActiveSensing,
            0xFF => MidiMessage::Reset,
            _ => return None,
        },
    })
}

/// Stateful MIDI byte-stream parser with running status and realtime interleaving.
#[derive(Debug, Default, Clone)]
pub struct StreamParser {
    running: Option<u8>,
    data: Vec<u8>,
    sysex: Option<Vec<u8>>,
}

impl StreamParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes; returns every message completed by them.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<MidiMessage> {
        let mut out = Vec::new();
        for &b in bytes {
            if let Some(m) = self.push(b) {
                out.push(m);
            }
        }
        out
    }

    /// Feed one byte.
    pub fn push(&mut self, b: u8) -> Option<MidiMessage> {
        if b >= 0xF8 {
            // Realtime may appear anywhere, even inside SysEx, without touching state.
            return from_parts(b, &[]);
        }
        if let Some(buf) = self.sysex.as_mut() {
            if b == 0xF7 {
                buf.push(b);
                let done = std::mem::take(buf);
                self.sysex = None;
                return Some(MidiMessage::SysEx(done));
            }
            if b < 0x80 {
                buf.push(b);
                return None;
            }
            // Any other status aborts the SysEx and is processed normally.
            self.sysex = None;
        }
        if b >= 0x80 {
            self.data.clear();
            match b {
                0xF0 => {
                    self.running = None;
                    self.sysex = Some(vec![0xF0]);
                    return None;
                }
                0xF7 => return None,
                0xF1..=0xF6 => {
                    self.running = None;
                    if data_len(b) == Some(0) {
                        return from_parts(b, &[]);
                    }
                    self.running = Some(b);
                    return None;
                }
                _ => {
                    self.running = Some(b);
                    return None;
                }
            }
        }
        let status = self.running?;
        self.data.push(b);
        let need = data_len(status)?;
        if self.data.len() < need {
            return None;
        }
        let msg = from_parts(status, &self.data);
        self.data.clear();
        if status >= 0xF0 {
            // System common messages cancel running status.
            self.running = None;
        }
        msg
    }
}

/// Parse a complete buffer (as delivered by OS MIDI APIs) into messages.
pub fn parse(bytes: &[u8]) -> Vec<MidiMessage> {
    StreamParser::new().feed(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_status_and_realtime_interleave() {
        let msgs = parse(&[0x90, 0x3C, 0x7F, 0xF8, 0x3E, 0x00, 0xB1, 0x07, 0x40]);
        assert_eq!(
            msgs,
            vec![
                MidiMessage::NoteOn {
                    channel: 0,
                    note: 0x3C,
                    velocity: 0x7F
                },
                MidiMessage::TimingClock,
                MidiMessage::NoteOff {
                    channel: 0,
                    note: 0x3E,
                    velocity: 0
                },
                MidiMessage::ControlChange {
                    channel: 1,
                    controller: 7,
                    value: 0x40
                },
            ]
        );
    }

    #[test]
    fn sysex_roundtrip() {
        let bytes = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];
        assert_eq!(parse(&bytes), vec![MidiMessage::SysEx(bytes.to_vec())]);
        assert_eq!(MidiMessage::SysEx(bytes.to_vec()).to_bytes(), bytes);
    }
}
