//! BLE-MIDI packet codec (MMA/AMEI "MIDI over Bluetooth Low Energy" 1.0, the Apple-originated
//! spec): pure code so native layers (Windows MIDI Services, CoreMIDI/CoreBluetooth, Android
//! AMidi / BluetoothGatt) can hand raw GATT characteristic values to the engine.
//!
//! Packet layout:
//! ```text
//! [header 10tttttt] ( [timestamp 1ttttttt] [status] data… | data… (running status) )*
//! ```
//! * the header carries timestamp bits 12..7, every timestamp byte bits 6..0 (13-bit ms clock);
//!   a timestamp-low smaller than the previous one in the same packet means bits 12..7 + 1;
//! * a timestamp byte precedes every status byte; running-status messages may follow with or
//!   without their own timestamp byte;
//! * SysEx may span packets: continuation packets carry raw data right after the header, and
//!   the terminating `F7` is preceded by a timestamp byte. Realtime bytes may interrupt SysEx
//!   (each with its own timestamp byte).

use crate::message::{MidiMessage, data_len, from_parts};

/// A decoded message with its 13-bit BLE timestamp in milliseconds (wraps at 8192).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BleMidiEvent {
    pub timestamp_ms: u16,
    pub message: MidiMessage,
}

/// Decode errors. A malformed packet is dropped; state resets except SysEx-in-progress.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BleMidiError {
    #[error("empty packet")]
    Empty,
    #[error("first byte {0:#04x} is not a BLE-MIDI header (10xxxxxx)")]
    BadHeader(u8),
    #[error("data byte without status at offset {0}")]
    NoStatus(usize),
    #[error("timestamp byte not followed by a status or data byte at offset {0}")]
    DanglingTimestamp(usize),
}

/// Stateful decoder (running status and SysEx continue across packets).
#[derive(Debug, Clone, Default)]
pub struct BleMidiDecoder {
    running: Option<u8>,
    sysex: Option<Vec<u8>>,
}

impl BleMidiDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode one characteristic value.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<BleMidiEvent>, BleMidiError> {
        let (&header, body) = packet.split_first().ok_or(BleMidiError::Empty)?;
        if header & 0xC0 != 0x80 {
            return Err(BleMidiError::BadHeader(header));
        }
        let mut ts_high = u16::from(header & 0x3F);
        let mut last_low: Option<u8> = None;
        let mut ts: u16 = ts_high << 7;
        let mut out = Vec::new();
        let mut i = 0;

        // SysEx continuation: raw data bytes straight after the header.
        if let Some(buf) = self.sysex.as_mut() {
            while i < body.len() && body[i] < 0x80 {
                buf.push(body[i]);
                i += 1;
            }
        }

        let mut set_ts = |low: u8, ts: &mut u16, ts_high: &mut u16| {
            let low = low & 0x7F;
            if let Some(prev) = last_low {
                if low < prev {
                    *ts_high = (*ts_high + 1) & 0x3F;
                }
            }
            last_low = Some(low);
            *ts = (*ts_high << 7) | u16::from(low);
        };

        while i < body.len() {
            let b = body[i];
            if b >= 0x80 {
                // Timestamp byte.
                set_ts(b, &mut ts, &mut ts_high);
                i += 1;
                let Some(&next) = body.get(i) else {
                    return Err(BleMidiError::DanglingTimestamp(i - 1));
                };
                if next >= 0x80 {
                    // Status byte.
                    i += 1;
                    if next >= 0xF8 {
                        if let Some(m) = from_parts(next, &[]) {
                            out.push(BleMidiEvent {
                                timestamp_ms: ts,
                                message: m,
                            });
                        }
                        continue;
                    }
                    if next == 0xF7 {
                        if let Some(mut buf) = self.sysex.take() {
                            buf.push(0xF7);
                            out.push(BleMidiEvent {
                                timestamp_ms: ts,
                                message: MidiMessage::SysEx(buf),
                            });
                        }
                        continue;
                    }
                    if next == 0xF0 {
                        self.running = None;
                        let mut buf = vec![0xF0];
                        while i < body.len() && body[i] < 0x80 {
                            buf.push(body[i]);
                            i += 1;
                        }
                        self.sysex = Some(buf);
                        continue;
                    }
                    // A new status ends any unterminated SysEx.
                    self.sysex = None;
                    i = self.read_message(next, body, i, ts, &mut out)?;
                    if next >= 0xF0 {
                        self.running = None;
                    } else {
                        self.running = Some(next);
                    }
                } else {
                    // Timestamp + running-status data (or SysEx data resuming after a
                    // realtime byte).
                    if let Some(buf) = self.sysex.as_mut() {
                        while i < body.len() && body[i] < 0x80 {
                            buf.push(body[i]);
                            i += 1;
                        }
                        continue;
                    }
                    let st = self.running.ok_or(BleMidiError::NoStatus(i))?;
                    i = self.read_message(st, body, i, ts, &mut out)?;
                }
            } else {
                // SysEx data, or running status without a timestamp byte (same timestamp).
                if let Some(buf) = self.sysex.as_mut() {
                    buf.push(b);
                    i += 1;
                    continue;
                }
                let st = self.running.ok_or(BleMidiError::NoStatus(i))?;
                i = self.read_message(st, body, i, ts, &mut out)?;
            }
        }
        Ok(out)
    }

    fn read_message(
        &mut self,
        status: u8,
        body: &[u8],
        start: usize,
        ts: u16,
        out: &mut Vec<BleMidiEvent>,
    ) -> Result<usize, BleMidiError> {
        let n = data_len(status).ok_or(BleMidiError::NoStatus(start))?;
        let end = start + n;
        if end > body.len() || body[start..end].iter().any(|&b| b >= 0x80) {
            return Err(BleMidiError::NoStatus(start));
        }
        if let Some(m) = from_parts(status, &body[start..end]) {
            out.push(BleMidiEvent {
                timestamp_ms: ts,
                message: m,
            });
        }
        Ok(end)
    }
}

/// Encoder options.
#[derive(Debug, Clone, Copy)]
pub struct BleMidiEncoder {
    /// Maximum characteristic value size (ATT MTU - 3). 20 for the default 23-byte MTU.
    pub max_packet: usize,
    /// Omit repeated status bytes (and their timestamps when the time is unchanged).
    pub running_status: bool,
}

impl Default for BleMidiEncoder {
    fn default() -> Self {
        Self {
            max_packet: 20,
            running_status: true,
        }
    }
}

impl BleMidiEncoder {
    /// Encode messages (each with a millisecond timestamp, taken mod 8192) into packets.
    /// Timestamps must be non-decreasing within a call.
    pub fn encode(&self, events: &[(u16, MidiMessage)]) -> Vec<Vec<u8>> {
        let max = self.max_packet.max(5);
        let mut packets: Vec<Vec<u8>> = Vec::new();
        let mut cur: Vec<u8> = Vec::new();
        let mut running: Option<u8> = None;
        let mut last_ts: Option<u16> = None;

        let header = |ts: u16| 0x80 | ((ts >> 7) & 0x3F) as u8;
        let tsb = |ts: u16| 0x80 | (ts & 0x7F) as u8;

        for (ts, msg) in events {
            let ts = ts & 0x1FFF;
            let bytes = msg.to_bytes();
            if let MidiMessage::SysEx(_) = msg {
                // SysEx: F0 + data, split across packets; F7 preceded by a timestamp.
                let data = &bytes[1..bytes.len().saturating_sub(1)];
                if cur.len() + 3 > max || (!cur.is_empty() && header(ts) != cur[0]) {
                    packets.push(std::mem::take(&mut cur));
                }
                if cur.is_empty() {
                    cur.push(header(ts));
                }
                cur.push(tsb(ts));
                cur.push(0xF0);
                for &d in data {
                    if cur.len() + 1 > max {
                        packets.push(std::mem::take(&mut cur));
                        cur.push(header(ts));
                    }
                    cur.push(d);
                }
                if cur.len() + 2 > max {
                    packets.push(std::mem::take(&mut cur));
                    cur.push(header(ts));
                }
                cur.push(tsb(ts));
                cur.push(0xF7);
                running = None;
                last_ts = Some(ts);
                continue;
            }
            let status = bytes[0];
            let realtime = status >= 0xF8;
            let use_running = self.running_status && !realtime && running == Some(status);
            let need_ts = !use_running || last_ts != Some(ts);
            let mut chunk = Vec::with_capacity(bytes.len() + 1);
            if need_ts {
                chunk.push(tsb(ts));
            }
            if use_running {
                chunk.extend_from_slice(&bytes[1..]);
            } else {
                chunk.extend_from_slice(&bytes);
            }
            // A packet's header fixes the high timestamp bits; a change starts a new packet
            // (simpler than relying on the decoder's low-byte wrap rule, always valid).
            let header_ok = cur.first().is_some_and(|&h| h == header(ts));
            if cur.is_empty() || !header_ok || cur.len() + chunk.len() > max {
                if !cur.is_empty() {
                    packets.push(std::mem::take(&mut cur));
                }
                cur.push(header(ts));
                // New packet: always restate timestamp + status.
                chunk.clear();
                chunk.push(tsb(ts));
                chunk.extend_from_slice(&bytes);
            }
            cur.extend_from_slice(&chunk);
            if !realtime {
                running = if status < 0xF0 { Some(status) } else { None };
            }
            last_ts = Some(ts);
        }
        if !cur.is_empty() {
            packets.push(cur);
        }
        packets
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_multi_message_packet_with_running_status() {
        // header ts_high=1, ts 0x85 NoteOn C4, running-status note E4 (no ts),
        // ts 0x8A CC7=100 on ch2, ts 0x8A clock, ts 0x8B running-status CC.
        let pkt = [
            0x81, 0x85, 0x90, 60, 100, 64, 90, 0x8A, 0xB1, 7, 100, 0x8A, 0xF8, 0x8B, 10, 64,
        ];
        let ev = BleMidiDecoder::new().decode(&pkt).unwrap();
        assert_eq!(ev.len(), 5);
        assert_eq!(ev[0].timestamp_ms, (1 << 7) | 5);
        assert_eq!(
            ev[0].message,
            MidiMessage::NoteOn {
                channel: 0,
                note: 60,
                velocity: 100
            }
        );
        assert_eq!(
            ev[1].message,
            MidiMessage::NoteOn {
                channel: 0,
                note: 64,
                velocity: 90
            }
        );
        assert_eq!(ev[1].timestamp_ms, (1 << 7) | 5);
        assert_eq!(
            ev[2].message,
            MidiMessage::ControlChange {
                channel: 1,
                controller: 7,
                value: 100
            }
        );
        assert_eq!(ev[3].message, MidiMessage::TimingClock);
        assert_eq!(
            ev[4].message,
            MidiMessage::ControlChange {
                channel: 1,
                controller: 10,
                value: 64
            }
        );
        assert_eq!(ev[4].timestamp_ms, (1 << 7) | 0x0B);
    }

    #[test]
    fn timestamp_low_wrap_increments_high_bits() {
        let pkt = [0x80, 0xFE, 0xF8, 0x81, 0xF8];
        let ev = BleMidiDecoder::new().decode(&pkt).unwrap();
        assert_eq!(ev[0].timestamp_ms, 0x7E);
        assert_eq!(ev[1].timestamp_ms, (1 << 7) | 1);
    }

    #[test]
    fn sysex_spanning_packets_and_realtime_inside() {
        let mut d = BleMidiDecoder::new();
        assert!(
            d.decode(&[0x80, 0x81, 0xF0, 0x7E, 0x7F])
                .unwrap()
                .is_empty()
        );
        let ev = d
            .decode(&[0x80, 0x06, 0x01, 0x82, 0xF8, 0x83, 0xF7])
            .unwrap();
        assert_eq!(ev[0].message, MidiMessage::TimingClock);
        assert_eq!(
            ev[1].message,
            MidiMessage::SysEx(vec![0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])
        );
    }

    #[test]
    fn rejects_bad_header_and_orphan_data() {
        assert_eq!(
            BleMidiDecoder::new().decode(&[0x10, 0x80]),
            Err(BleMidiError::BadHeader(0x10))
        );
        assert!(matches!(
            BleMidiDecoder::new().decode(&[0x80, 0x40]),
            Err(BleMidiError::NoStatus(_))
        ));
    }

    #[test]
    fn encode_decode_roundtrip_splits_packets() {
        let mut events = Vec::new();
        for i in 0..20u16 {
            events.push((
                i * 3,
                MidiMessage::NoteOn {
                    channel: 0,
                    note: 40 + i as u8,
                    velocity: 100,
                },
            ));
        }
        let mut sx = vec![0xF0];
        sx.extend(0u8..30);
        sx.push(0xF7);
        events.push((70, MidiMessage::SysEx(sx)));
        events.push((200, MidiMessage::TimingClock));
        let enc = BleMidiEncoder::default();
        let packets = enc.encode(&events);
        assert!(packets.len() > 1);
        assert!(packets.iter().all(|p| p.len() <= 20));
        let mut d = BleMidiDecoder::new();
        let mut decoded = Vec::new();
        for p in &packets {
            decoded.extend(d.decode(p).unwrap());
        }
        let got: Vec<(u16, MidiMessage)> = decoded
            .into_iter()
            .map(|e| (e.timestamp_ms, e.message))
            .collect();
        assert_eq!(got, events);
    }
}
