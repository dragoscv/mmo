//! BLE-MIDI 1.0 packet codec (MIDI Association "Specification for MIDI over Bluetooth Low Energy").
//!
//! A packet is `header (1tttttt)` then one or more `timestamp-low (1ttttttt)` + MIDI message,
//! with running status allowed and SysEx split across packets. This module is pure so it can be
//! unit-tested without a radio.

/// Decodes BLE-MIDI notification payloads into plain MIDI 1.0 messages.
#[derive(Default)]
pub struct Decoder {
    running_status: Option<u8>,
    sysex: Option<Vec<u8>>,
}

fn data_len(status: u8) -> usize {
    match status & 0xF0 {
        0x80 | 0x90 | 0xA0 | 0xB0 | 0xE0 => 2,
        0xC0 | 0xD0 => 1,
        _ => match status {
            0xF1 | 0xF3 => 1,
            0xF2 => 2,
            _ => 0, // F6, F8..FF real-time / tune request
        },
    }
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode one notification. Each complete message is passed to `emit`.
    pub fn decode(&mut self, pkt: &[u8], mut emit: impl FnMut(&[u8])) {
        // Header must have bit 7 set and bit 6 clear.
        if pkt.len() < 2 || pkt[0] & 0xC0 != 0x80 {
            return;
        }
        let mut i = 1;
        // A packet that starts while a SysEx is open continues it (no timestamp before data).
        if self.sysex.is_some() && pkt[i] & 0x80 == 0 {
            i = self.take_sysex(pkt, i, &mut emit);
        }
        while i < pkt.len() {
            let b = pkt[i];
            if b & 0x80 == 0 {
                // Running-status data without a fresh timestamp.
                i = self.take_running(pkt, i, &mut emit);
                continue;
            }
            // Timestamp-low byte.
            i += 1;
            if i >= pkt.len() {
                break;
            }
            let b = pkt[i];
            if b == 0xF7 {
                // SysEx end, preceded by its own timestamp.
                if let Some(mut s) = self.sysex.take() {
                    s.push(0xF7);
                    emit(&s);
                }
                i += 1;
            } else if b == 0xF0 {
                self.sysex = Some(vec![0xF0]);
                i = self.take_sysex(pkt, i + 1, &mut emit);
            } else if b & 0x80 != 0 {
                let n = data_len(b);
                if b < 0xF0 {
                    self.running_status = Some(b);
                } else if b < 0xF8 {
                    self.running_status = None;
                }
                if i + n >= pkt.len() {
                    break;
                }
                emit(&pkt[i..=i + n]);
                i += 1 + n;
            } else {
                // Timestamp followed by data = running status with a new timestamp.
                i = self.take_running(pkt, i, &mut emit);
            }
        }
    }

    fn take_running(&mut self, pkt: &[u8], i: usize, emit: &mut impl FnMut(&[u8])) -> usize {
        let Some(st) = self.running_status else {
            return pkt.len();
        };
        let n = data_len(st);
        if n == 0 || i + n > pkt.len() {
            return pkt.len();
        }
        let mut msg = [0u8; 3];
        msg[0] = st;
        msg[1..=n].copy_from_slice(&pkt[i..i + n]);
        emit(&msg[..=n]);
        i + n
    }

    fn take_sysex(&mut self, pkt: &[u8], mut i: usize, emit: &mut impl FnMut(&[u8])) -> usize {
        while i < pkt.len() {
            let b = pkt[i];
            if b & 0x80 == 0 {
                if let Some(s) = self.sysex.as_mut() {
                    s.push(b);
                }
                i += 1;
            } else if b >= 0xF8 {
                // Real-time may interleave inside SysEx (no timestamp).
                emit(&[b]);
                i += 1;
            } else {
                // A timestamp byte: either before F7 or before a new message.
                if i + 1 < pkt.len() && pkt[i + 1] == 0xF7 {
                    if let Some(mut s) = self.sysex.take() {
                        s.push(0xF7);
                        emit(&s);
                    }
                    return i + 2;
                }
                return i;
            }
        }
        i
    }
}

/// Encode MIDI 1.0 messages into BLE-MIDI packets of at most `mtu_payload` bytes (>= 5).
/// `ts_ms` is the 13-bit millisecond timestamp.
pub fn encode(messages: &[&[u8]], ts_ms: u16, mtu_payload: usize) -> Vec<Vec<u8>> {
    let hi = 0x80 | ((ts_ms >> 7) & 0x3F) as u8;
    let lo = 0x80 | (ts_ms & 0x7F) as u8;
    let mut out = Vec::new();
    let mut cur = vec![hi];
    for m in messages {
        if m.is_empty() {
            continue;
        }
        if cur.len() + 1 + m.len() > mtu_payload && cur.len() > 1 {
            out.push(std::mem::replace(&mut cur, vec![hi]));
        }
        cur.push(lo);
        cur.extend_from_slice(m);
    }
    if cur.len() > 1 {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(pkts: &[&[u8]]) -> Vec<Vec<u8>> {
        let mut d = Decoder::new();
        let mut v = Vec::new();
        for p in pkts {
            d.decode(p, |m| v.push(m.to_vec()));
        }
        v
    }

    #[test]
    fn decodes_real_flx4_packet_with_full_status_per_message() {
        // Captured from a DDJ-FLX4 on 2026-11-09 (crossfader + pad press).
        let p = [
            0x81, 0xCE, 0xB1, 0x22, 0x39, 0xD3, 0x90, 0x36, 0x7F, 0xD3, 0xB0, 0x22, 0x41,
        ];
        assert_eq!(
            dec(&[&p]),
            vec![
                vec![0xB1, 0x22, 0x39],
                vec![0x90, 0x36, 0x7F],
                vec![0xB0, 0x22, 0x41]
            ]
        );
    }

    #[test]
    fn running_status_without_and_with_timestamp() {
        // B0 07 10, then data 07 11 (no ts), then ts + data 07 12.
        let p = [0x80, 0x81, 0xB0, 0x07, 0x10, 0x07, 0x11, 0x82, 0x07, 0x12];
        assert_eq!(
            dec(&[&p]),
            vec![
                vec![0xB0, 0x07, 0x10],
                vec![0xB0, 0x07, 0x11],
                vec![0xB0, 0x07, 0x12]
            ]
        );
    }

    #[test]
    fn program_change_one_data_byte() {
        let p = [0x80, 0x80, 0xC3, 0x05, 0x80, 0x90, 0x40, 0x00];
        assert_eq!(dec(&[&p]), vec![vec![0xC3, 0x05], vec![0x90, 0x40, 0x00]]);
    }

    #[test]
    fn sysex_split_across_packets() {
        let a = [0x80, 0x80, 0xF0, 0x00, 0x40, 0x05];
        let b = [0x81, 0x01, 0x02, 0x81, 0xF7];
        assert_eq!(
            dec(&[&a, &b]),
            vec![vec![0xF0, 0x00, 0x40, 0x05, 0x01, 0x02, 0xF7]]
        );
    }

    #[test]
    fn rejects_bad_header_and_truncated_message() {
        assert!(dec(&[&[0x40, 0x80, 0x90, 0x40, 0x7F]]).is_empty());
        assert!(dec(&[&[0x80, 0x80, 0x90, 0x40]]).is_empty());
    }

    #[test]
    fn encode_round_trips_and_splits_by_mtu() {
        let msgs: Vec<&[u8]> = vec![
            &[0x90, 0x0B, 0x7F],
            &[0x91, 0x0B, 0x7F],
            &[0x90, 0x0C, 0x00],
        ];
        let pkts = encode(&msgs, 0x1ABC, 9);
        assert_eq!(pkts.len(), 2);
        assert!(pkts.iter().all(|p| p.len() <= 9 && p[0] & 0xC0 == 0x80));
        let refs: Vec<&[u8]> = pkts.iter().map(|p| p.as_slice()).collect();
        let back = dec(&refs);
        assert_eq!(back, msgs.iter().map(|m| m.to_vec()).collect::<Vec<_>>());
    }
}
