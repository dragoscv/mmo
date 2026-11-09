//! MIDI learn: capture the next control the user touches and propose an input definition.
//!
//! Detection rules:
//! * Note On → `note` input (momentary button / pad).
//! * CC `n` (n < 32) together with CC `n + 32` on the same channel → `cc14` pair.
//! * CC 99/98 followed by CC 6 (and optionally 38) → `nrpn` (high-res if 38 seen).
//! * A CC whose values cluster around 64, or around 1 / 127, or around 1 / 65 →
//!   relative encoder (offset-64 / two's complement / sign-magnitude).
//! * Otherwise an absolute 7-bit `cc`; pitch bend → `pitch_bend`; programme change →
//!   `program_change`.
//!
//! A gesture ends after [`MidiLearn::quiet_us`] without new messages (the host polls with
//! "now"), or immediately for a Note On.

use crate::format::InputKind;
use crate::message::MidiMessage;
use crate::value::RelativeEncoding;

/// A proposed control.
#[derive(Debug, Clone, PartialEq)]
pub struct LearnProposal {
    /// Suggested input id, e.g. `ch1.cc7` or `ch2.note60`.
    pub id: String,
    /// 1-based channel.
    pub channel: Option<u8>,
    pub kind: InputKind,
    /// Raw values observed (diagnostics / UI).
    pub samples: usize,
}

#[derive(Debug, Clone)]
pub struct MidiLearn {
    /// End-of-gesture silence, µs (default 300 ms).
    pub quiet_us: u64,
    msgs: Vec<(u64, MidiMessage)>,
    last_us: Option<u64>,
}

impl Default for MidiLearn {
    fn default() -> Self {
        Self::new()
    }
}

impl MidiLearn {
    pub fn new() -> Self {
        Self {
            quiet_us: 300_000,
            msgs: Vec::new(),
            last_us: None,
        }
    }

    /// Record a message; returns a proposal immediately for unambiguous presses.
    pub fn push(&mut self, msg: &MidiMessage, at_us: u64) -> Option<LearnProposal> {
        if msg.is_realtime() || matches!(msg, MidiMessage::NoteOff { .. }) {
            return None;
        }
        if let MidiMessage::NoteOn { .. } = msg {
            if self.msgs.is_empty() {
                self.msgs.push((at_us, msg.clone()));
                return self.finish();
            }
        }
        self.msgs.push((at_us, msg.clone()));
        self.last_us = Some(at_us);
        None
    }

    /// Returns the proposal once the gesture has been quiet for `quiet_us`.
    pub fn poll(&mut self, now_us: u64) -> Option<LearnProposal> {
        match self.last_us {
            Some(t) if now_us.saturating_sub(t) >= self.quiet_us => self.finish(),
            _ => None,
        }
    }

    /// Force a proposal from what was captured so far.
    pub fn finish(&mut self) -> Option<LearnProposal> {
        let msgs = std::mem::take(&mut self.msgs);
        self.last_us = None;
        analyse(&msgs)
    }
}

fn analyse(msgs: &[(u64, MidiMessage)]) -> Option<LearnProposal> {
    let first = msgs.first()?.1.clone();
    let n = msgs.len();
    match first {
        MidiMessage::NoteOn { channel, note, .. } => Some(LearnProposal {
            id: format!("ch{}.note{}", channel + 1, note),
            channel: Some(channel + 1),
            kind: InputKind::Note { note },
            samples: n,
        }),
        MidiMessage::PitchBend { channel, .. } => Some(LearnProposal {
            id: format!("ch{}.pitchbend", channel + 1),
            channel: Some(channel + 1),
            kind: InputKind::PitchBend,
            samples: n,
        }),
        MidiMessage::ProgramChange { channel, program } => Some(LearnProposal {
            id: format!("ch{}.program{}", channel + 1, program),
            channel: Some(channel + 1),
            kind: InputKind::ProgramChange {
                first: program,
                last: program,
            },
            samples: n,
        }),
        MidiMessage::SysEx(bytes) => {
            let pattern = bytes
                .iter()
                .map(|b| format!("{b:02X}"))
                .collect::<Vec<_>>()
                .join(" ");
            Some(LearnProposal {
                id: "sysex".into(),
                channel: None,
                kind: InputKind::Sysex { pattern },
                samples: n,
            })
        }
        MidiMessage::ControlChange { channel, .. } => Some(analyse_cc(channel, msgs)),
        _ => None,
    }
}

fn analyse_cc(channel: u8, msgs: &[(u64, MidiMessage)]) -> LearnProposal {
    let ccs: Vec<(u8, u8)> = msgs
        .iter()
        .filter_map(|(_, m)| match *m {
            MidiMessage::ControlChange {
                channel: c,
                controller,
                value,
            } if c == channel => Some((controller, value)),
            _ => None,
        })
        .collect();
    let seen = |cc: u8| ccs.iter().any(|&(c, _)| c == cc);
    let ch1 = channel + 1;

    // NRPN select + data entry.
    if seen(99) && seen(98) && seen(6) {
        let msb = ccs.iter().rev().find(|c| c.0 == 99).map_or(0, |c| c.1);
        let lsb = ccs.iter().rev().find(|c| c.0 == 98).map_or(0, |c| c.1);
        let param = (u16::from(msb) << 7) | u16::from(lsb);
        return LearnProposal {
            id: format!("ch{ch1}.nrpn{param}"),
            channel: Some(ch1),
            kind: InputKind::Nrpn {
                param,
                high_res: seen(38),
            },
            samples: ccs.len(),
        };
    }

    // The control that moved most decides; a 14-bit pair counts as one control.
    let mut counts: Vec<(u8, usize)> = Vec::new();
    for &(c, _) in &ccs {
        match counts.iter_mut().find(|x| x.0 == c) {
            Some(x) => x.1 += 1,
            None => counts.push((c, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let main = counts[0].0;
    let (msb, lsb) = if (32..64).contains(&main) {
        (main - 32, main)
    } else {
        (main, main + 32)
    };
    if msb < 32 && seen(msb) && seen(lsb) {
        return LearnProposal {
            id: format!("ch{ch1}.cc{msb}_14bit"),
            channel: Some(ch1),
            kind: InputKind::Cc14 { msb, lsb },
            samples: ccs.len(),
        };
    }
    let values: Vec<u8> = ccs.iter().filter(|c| c.0 == main).map(|c| c.1).collect();
    let relative = RelativeEncoding::detect(&values);
    LearnProposal {
        id: format!("ch{ch1}.cc{main}"),
        channel: Some(ch1),
        kind: InputKind::Cc { cc: main, relative },
        samples: values.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cc(controller: u8, value: u8) -> MidiMessage {
        MidiMessage::ControlChange {
            channel: 0,
            controller,
            value,
        }
    }

    #[test]
    fn detects_14bit_pair() {
        let mut l = MidiLearn::new();
        for (i, v) in [10u8, 11, 12, 13].iter().enumerate() {
            l.push(&cc(0x13, *v), i as u64 * 1000);
            l.push(&cc(0x33, 0x40), i as u64 * 1000 + 10);
        }
        assert!(l.poll(10_000).is_none());
        let p = l.poll(400_000).unwrap();
        assert_eq!(
            p.kind,
            InputKind::Cc14 {
                msb: 0x13,
                lsb: 0x33
            }
        );
        assert_eq!(p.channel, Some(1));
    }

    #[test]
    fn detects_relative_encoders() {
        for (vals, enc) in [
            (
                vec![0x41u8, 0x41, 0x42, 0x41, 0x43],
                RelativeEncoding::Offset64,
            ),
            (
                vec![0x01, 0x01, 0x7F, 0x01, 0x02],
                RelativeEncoding::TwosComplement,
            ),
            (
                vec![0x01, 0x41, 0x01, 0x41, 0x02],
                RelativeEncoding::SignMagnitude,
            ),
        ] {
            let mut l = MidiLearn::new();
            for (i, v) in vals.iter().enumerate() {
                l.push(&cc(0x21, *v), i as u64);
            }
            let p = l.finish().unwrap();
            assert_eq!(
                p.kind,
                InputKind::Cc {
                    cc: 0x21,
                    relative: Some(enc)
                },
                "{vals:?}"
            );
        }
    }

    #[test]
    fn absolute_cc_sweep_is_not_relative() {
        let mut l = MidiLearn::new();
        for (i, v) in (60u8..70).enumerate() {
            l.push(&cc(7, v), i as u64);
        }
        assert_eq!(
            l.finish().unwrap().kind,
            InputKind::Cc {
                cc: 7,
                relative: None
            }
        );
    }

    #[test]
    fn note_on_is_immediate_and_nrpn_detected() {
        let mut l = MidiLearn::new();
        let p = l
            .push(
                &MidiMessage::NoteOn {
                    channel: 7,
                    note: 3,
                    velocity: 127,
                },
                0,
            )
            .unwrap();
        assert_eq!(p.kind, InputKind::Note { note: 3 });
        assert_eq!(p.channel, Some(8));

        let mut l = MidiLearn::new();
        for m in [cc(99, 1), cc(98, 18), cc(6, 3), cc(38, 0)] {
            l.push(&m, 0);
        }
        assert_eq!(
            l.finish().unwrap().kind,
            InputKind::Nrpn {
                param: (1 << 7) | 18,
                high_res: true
            }
        );
    }
}
