//! Wire format of decks-link, version 1: fixed-size little-endian datagrams, 64 bytes at most.
//!
//! Every datagram starts with the same 20-byte header; the kind byte selects the body and the
//! datagram length must be exactly the length of that kind. Nothing here allocates on the
//! decode path, and no input can make [`Datagram::decode`] panic. The byte layout is in the
//! crate documentation.

use std::fmt;

/// First four bytes of every datagram.
pub const MAGIC: [u8; 4] = *b"MXLK";
/// Largest datagram of the protocol (a beacon).
pub const MAX_DATAGRAM: usize = 64;
/// Bytes shared by every kind: magic, version, kind, flags, reserved, key, peer id.
pub const HEADER_LEN: usize = 20;
pub const BEACON_LEN: usize = 64;
pub const PING_LEN: usize = 32;
pub const PONG_LEN: usize = 48;
pub const SET_TEMPO_LEN: usize = 44;
pub const BYE_LEN: usize = 28;

pub const KIND_BEACON: u8 = 1;
pub const KIND_PING: u8 = 2;
pub const KIND_PONG: u8 = 3;
pub const KIND_SET_TEMPO: u8 = 4;
pub const KIND_BYE: u8 = 5;

/// Beacon flag: the sender started less than two seconds ago, alone, and has joined nobody.
pub const FLAG_NEWBORN: u8 = 0b0000_0001;
/// Beacon flag: the sender holds the timeline of its session (it follows nobody).
pub const FLAG_LEADS: u8 = 0b0000_0010;
/// Beacon flag, with [`FLAG_LEADS`]: the sender's clock is a playing deck, so the session
/// tempo is that deck's tempo and a tempo proposal would be refused.
pub const FLAG_TEMPO_LOCKED: u8 = 0b0000_0100;

/// Tempo range of a session, in beats per minute (both ends allowed).
pub const MIN_TEMPO: f64 = 20.0;
pub const MAX_TEMPO: f64 = 300.0;
/// Largest beat count a datagram may carry (300 BPM for six years).
pub const MAX_BEAT: f64 = 1e9;
/// Largest clock value a datagram may carry, in microseconds (far beyond any uptime; keeps
/// every sum and difference of a few stamps inside an `i64`).
pub const MAX_TIME_US: u64 = 1 << 60;
/// A beacon whose timeline origin is further than this from its send time is refused.
pub const MAX_ORIGIN_AGE_US: u64 = 3_600_000_000;
/// Beats per bar used for phase alignment; the only value version 1 accepts.
pub const QUANTUM_BEATS: u8 = 4;

/// True for a tempo a session may run at: finite and within [`MIN_TEMPO`]..=[`MAX_TEMPO`].
pub fn valid_tempo(bpm: f64) -> bool {
    bpm.is_finite() && (MIN_TEMPO..=MAX_TEMPO).contains(&bpm)
}

/// True for a beat count a datagram may carry.
pub fn valid_beat(beat: f64) -> bool {
    beat.is_finite() && beat.abs() <= MAX_BEAT
}

/// Why a datagram was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    /// Shorter than the header.
    TooShort,
    /// Longer than [`MAX_DATAGRAM`].
    TooLong,
    BadMagic,
    BadVersion(u8),
    BadKind(u8),
    /// The length is not the length of this kind.
    BadLength {
        kind: u8,
        len: usize,
    },
    /// A field is outside its range (the name of the field).
    BadField(&'static str),
}

impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort => write!(f, "datagram shorter than the header"),
            Self::TooLong => write!(f, "datagram longer than {MAX_DATAGRAM} bytes"),
            Self::BadMagic => write!(f, "not a decks-link datagram"),
            Self::BadVersion(v) => write!(f, "unsupported protocol version {v}"),
            Self::BadKind(k) => write!(f, "unknown datagram kind {k}"),
            Self::BadLength { kind, len } => write!(f, "kind {kind} cannot be {len} bytes long"),
            Self::BadField(name) => write!(f, "field `{name}` out of range"),
        }
    }
}

impl std::error::Error for WireError {}

/// Session announcement, sent about five times a second by every peer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Beacon {
    pub session_id: u64,
    /// The sender started less than two seconds ago, alone: it yields to any other session.
    pub newborn: bool,
    /// The sender holds the timeline of its session: the members follow it. A member that
    /// joins a session never says so while another member does.
    pub leads: bool,
    /// With `leads`: the session tempo follows a playing deck of the sender and cannot be
    /// set by a proposal.
    pub tempo_locked: bool,
    /// Session tempo in BPM.
    pub tempo: f64,
    /// Beat count of the session timeline at `t_origin`.
    pub beat: f64,
    /// Sender clock (µs) at which `beat` holds.
    pub t_origin: u64,
    /// Sender clock (µs) when the datagram left.
    pub t_send: u64,
    /// UDP port the sender reads on (0 = the source port of this datagram). Answers go to the
    /// source IP address of the beacon and this port.
    pub reply_port: u16,
    /// Peers the sender counts in its session, itself included (0 is read as 1). When two
    /// sessions meet, the larger one stays and the other one joins it.
    pub members: u8,
}

/// Body of a datagram.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Body {
    Beacon(Beacon),
    /// Clock probe; `t_send` is the sender clock when it left.
    Ping {
        seq: u32,
        t_send: u64,
    },
    /// Answer to a ping: its `seq` and `t_send` echoed, then the answering peer's clock when
    /// the ping arrived and when this answer left.
    Pong {
        seq: u32,
        t_send: u64,
        t_recv: u64,
        t_reply: u64,
    },
    /// Tempo proposal for the leader of `session_id`: `bpm` from session beat `at_beat` on.
    SetTempo {
        session_id: u64,
        bpm: f64,
        at_beat: f64,
    },
    /// The sender leaves `session_id` now.
    Bye {
        session_id: u64,
    },
}

/// One decoded (or to be encoded) datagram.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Datagram {
    /// Session key (0 = open session); see [`crate::key_from_pin`].
    pub key: u32,
    /// Sender id, never 0.
    pub peer_id: u64,
    pub body: Body,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    let mut a = [0u8; 2];
    a.copy_from_slice(&b[at..at + 2]);
    u16::from_le_bytes(a)
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    let mut a = [0u8; 4];
    a.copy_from_slice(&b[at..at + 4]);
    u32::from_le_bytes(a)
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(a)
}

fn f64_at(b: &[u8], at: usize) -> f64 {
    f64::from_bits(u64_at(b, at))
}

fn time_at(b: &[u8], at: usize, name: &'static str) -> Result<u64, WireError> {
    let t = u64_at(b, at);
    if t > MAX_TIME_US {
        return Err(WireError::BadField(name));
    }
    Ok(t)
}

impl Datagram {
    /// Length of the encoded datagram.
    pub fn encoded_len(&self) -> usize {
        match self.body {
            Body::Beacon(_) => BEACON_LEN,
            Body::Ping { .. } => PING_LEN,
            Body::Pong { .. } => PONG_LEN,
            Body::SetTempo { .. } => SET_TEMPO_LEN,
            Body::Bye { .. } => BYE_LEN,
        }
    }

    /// Bytes to put in one UDP datagram. Does not validate: [`Datagram::decode`] refuses what
    /// is out of range, on the receiving side.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.encoded_len());
        let (kind, flags) = match self.body {
            Body::Beacon(b) => {
                let mut f = if b.newborn { FLAG_NEWBORN } else { 0 };
                if b.leads {
                    f |= FLAG_LEADS;
                }
                if b.tempo_locked {
                    f |= FLAG_TEMPO_LOCKED;
                }
                (KIND_BEACON, f)
            }
            Body::Ping { .. } => (KIND_PING, 0),
            Body::Pong { .. } => (KIND_PONG, 0),
            Body::SetTempo { .. } => (KIND_SET_TEMPO, 0),
            Body::Bye { .. } => (KIND_BYE, 0),
        };
        out.extend_from_slice(&MAGIC);
        out.push(crate::PROTOCOL_VERSION);
        out.push(kind);
        out.push(flags);
        out.push(0);
        out.extend_from_slice(&self.key.to_le_bytes());
        out.extend_from_slice(&self.peer_id.to_le_bytes());
        match self.body {
            Body::Beacon(b) => {
                out.extend_from_slice(&b.session_id.to_le_bytes());
                out.extend_from_slice(&b.tempo.to_bits().to_le_bytes());
                out.extend_from_slice(&b.beat.to_bits().to_le_bytes());
                out.extend_from_slice(&b.t_origin.to_le_bytes());
                out.extend_from_slice(&b.t_send.to_le_bytes());
                out.extend_from_slice(&b.reply_port.to_le_bytes());
                out.push(QUANTUM_BEATS);
                out.push(b.members);
            }
            Body::Ping { seq, t_send } => {
                out.extend_from_slice(&seq.to_le_bytes());
                out.extend_from_slice(&t_send.to_le_bytes());
            }
            Body::Pong {
                seq,
                t_send,
                t_recv,
                t_reply,
            } => {
                out.extend_from_slice(&seq.to_le_bytes());
                out.extend_from_slice(&t_send.to_le_bytes());
                out.extend_from_slice(&t_recv.to_le_bytes());
                out.extend_from_slice(&t_reply.to_le_bytes());
            }
            Body::SetTempo {
                session_id,
                bpm,
                at_beat,
            } => {
                out.extend_from_slice(&session_id.to_le_bytes());
                out.extend_from_slice(&bpm.to_bits().to_le_bytes());
                out.extend_from_slice(&at_beat.to_bits().to_le_bytes());
            }
            Body::Bye { session_id } => out.extend_from_slice(&session_id.to_le_bytes()),
        }
        debug_assert_eq!(out.len(), self.encoded_len());
        out
    }

    /// Parse one UDP datagram. Every length, the magic, the version, the kind and every field
    /// range are checked; anything else is an error, never a panic.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        if bytes.len() < HEADER_LEN {
            return Err(WireError::TooShort);
        }
        if bytes.len() > MAX_DATAGRAM {
            return Err(WireError::TooLong);
        }
        if bytes[..4] != MAGIC {
            return Err(WireError::BadMagic);
        }
        if bytes[4] != crate::PROTOCOL_VERSION {
            return Err(WireError::BadVersion(bytes[4]));
        }
        let kind = bytes[5];
        let want = match kind {
            KIND_BEACON => BEACON_LEN,
            KIND_PING => PING_LEN,
            KIND_PONG => PONG_LEN,
            KIND_SET_TEMPO => SET_TEMPO_LEN,
            KIND_BYE => BYE_LEN,
            other => return Err(WireError::BadKind(other)),
        };
        if bytes.len() != want {
            return Err(WireError::BadLength {
                kind,
                len: bytes.len(),
            });
        }
        let flags = bytes[6];
        let key = u32_at(bytes, 8);
        let peer_id = u64_at(bytes, 12);
        if peer_id == 0 {
            return Err(WireError::BadField("peer_id"));
        }
        let b = &bytes[HEADER_LEN..];
        let body = match kind {
            KIND_BEACON => {
                let beacon = Beacon {
                    session_id: u64_at(b, 0),
                    newborn: flags & FLAG_NEWBORN != 0,
                    leads: flags & FLAG_LEADS != 0,
                    tempo_locked: flags & FLAG_TEMPO_LOCKED != 0,
                    tempo: f64_at(b, 8),
                    beat: f64_at(b, 16),
                    t_origin: time_at(b, 24, "t_origin")?,
                    t_send: time_at(b, 32, "t_send")?,
                    reply_port: u16_at(b, 40),
                    members: b[43],
                };
                if beacon.session_id == 0 {
                    return Err(WireError::BadField("session_id"));
                }
                if !valid_tempo(beacon.tempo) {
                    return Err(WireError::BadField("tempo"));
                }
                if !valid_beat(beacon.beat) {
                    return Err(WireError::BadField("beat"));
                }
                if beacon.t_send.abs_diff(beacon.t_origin) > MAX_ORIGIN_AGE_US {
                    return Err(WireError::BadField("t_origin"));
                }
                if b[42] != QUANTUM_BEATS {
                    return Err(WireError::BadField("quantum"));
                }
                Body::Beacon(beacon)
            }
            KIND_PING => Body::Ping {
                seq: u32_at(b, 0),
                t_send: time_at(b, 4, "t_send")?,
            },
            KIND_PONG => Body::Pong {
                seq: u32_at(b, 0),
                t_send: time_at(b, 4, "t_send")?,
                t_recv: time_at(b, 12, "t_recv")?,
                t_reply: time_at(b, 20, "t_reply")?,
            },
            KIND_SET_TEMPO => {
                let (session_id, bpm, at_beat) = (u64_at(b, 0), f64_at(b, 8), f64_at(b, 16));
                if session_id == 0 {
                    return Err(WireError::BadField("session_id"));
                }
                if !valid_tempo(bpm) {
                    return Err(WireError::BadField("bpm"));
                }
                if !valid_beat(at_beat) {
                    return Err(WireError::BadField("at_beat"));
                }
                Body::SetTempo {
                    session_id,
                    bpm,
                    at_beat,
                }
            }
            _ => {
                let session_id = u64_at(b, 0);
                if session_id == 0 {
                    return Err(WireError::BadField("session_id"));
                }
                Body::Bye { session_id }
            }
        };
        Ok(Self { key, peer_id, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Vec<Datagram> {
        let beacon = Beacon {
            session_id: 0x1122_3344_5566_7788,
            newborn: true,
            leads: true,
            tempo_locked: false,
            tempo: 128.0,
            beat: 1234.5678,
            t_origin: 9_000_000,
            t_send: 9_000_123,
            reply_port: 42029,
            members: 3,
        };
        let d = |body| Datagram {
            key: 0xA1B2_C3D4,
            peer_id: 0x0102_0304_0506_0708,
            body,
        };
        vec![
            d(Body::Beacon(beacon)),
            d(Body::Beacon(Beacon {
                newborn: false,
                leads: false,
                tempo_locked: true,
                beat: -3.25,
                ..beacon
            })),
            d(Body::Ping {
                seq: 7,
                t_send: MAX_TIME_US,
            }),
            d(Body::Pong {
                seq: 7,
                t_send: 1,
                t_recv: 2,
                t_reply: 3,
            }),
            d(Body::SetTempo {
                session_id: 9,
                bpm: 174.0,
                at_beat: 64.0,
            }),
            d(Body::Bye { session_id: 9 }),
        ]
    }

    #[test]
    fn every_kind_round_trips_and_fits_one_datagram() {
        for d in samples() {
            let bytes = d.encode();
            assert_eq!(bytes.len(), d.encoded_len());
            assert!(bytes.len() <= MAX_DATAGRAM, "{} bytes", bytes.len());
            assert_eq!(&bytes[..4], b"MXLK");
            assert_eq!(Datagram::decode(&bytes), Ok(d));
        }
        // The largest kind uses the whole budget, nothing is longer.
        assert_eq!(samples()[0].encode().len(), 64);
    }

    #[test]
    fn layout_is_little_endian_at_documented_offsets() {
        let bytes = samples()[0].encode();
        assert_eq!(bytes[4], 1, "version");
        assert_eq!(bytes[5], KIND_BEACON);
        assert_eq!(bytes[6], FLAG_NEWBORN | FLAG_LEADS);
        assert_eq!(bytes[7], 0, "reserved");
        assert_eq!(&bytes[8..12], &[0xD4, 0xC3, 0xB2, 0xA1], "key");
        assert_eq!(&bytes[12..20], &[8, 7, 6, 5, 4, 3, 2, 1], "peer id");
        assert_eq!(
            &bytes[20..28],
            &[0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
            "session"
        );
        assert_eq!(&bytes[28..36], &128.0f64.to_le_bytes(), "tempo");
        assert_eq!(&bytes[36..44], &1234.5678f64.to_le_bytes(), "beat");
        assert_eq!(&bytes[44..52], &9_000_000u64.to_le_bytes(), "t_origin");
        assert_eq!(&bytes[52..60], &9_000_123u64.to_le_bytes(), "t_send");
        assert_eq!(&bytes[60..62], &42029u16.to_le_bytes(), "reply port");
        assert_eq!(bytes[62], 4, "quantum");
        assert_eq!(bytes[63], 3, "members");
        let ping = samples()[2].encode();
        assert_eq!(&ping[20..24], &7u32.to_le_bytes(), "seq");
        assert_eq!(&ping[24..32], &MAX_TIME_US.to_le_bytes(), "t_send");
    }

    #[test]
    fn every_combination_of_beacon_flags_round_trips() {
        let Body::Beacon(base) = samples()[0].body else {
            unreachable!()
        };
        for bits in 0u8..8 {
            let beacon = Beacon {
                newborn: bits & 1 != 0,
                leads: bits & 2 != 0,
                tempo_locked: bits & 4 != 0,
                ..base
            };
            let d = Datagram {
                key: 7,
                peer_id: 9,
                body: Body::Beacon(beacon),
            };
            let bytes = d.encode();
            // One bit each, at the documented positions.
            assert_eq!(bytes[6], bits, "flags byte for {bits:03b}");
            assert_eq!(Datagram::decode(&bytes), Ok(d), "{bits:03b}");
        }
        assert_eq!(
            (FLAG_NEWBORN, FLAG_LEADS, FLAG_TEMPO_LOCKED),
            (0b001, 0b010, 0b100)
        );
    }

    #[test]
    fn every_truncation_and_every_extension_is_refused() {
        for d in samples() {
            let bytes = d.encode();
            for len in 0..bytes.len() {
                assert!(
                    Datagram::decode(&bytes[..len]).is_err(),
                    "{:?} cut to {len} bytes",
                    d.body
                );
            }
            let mut long = bytes.clone();
            while long.len() < 80 {
                long.push(0);
                assert!(
                    Datagram::decode(&long).is_err(),
                    "{:?} padded to {}",
                    d.body,
                    long.len()
                );
            }
        }
    }

    #[test]
    fn other_magic_version_and_kind_are_refused() {
        let good = samples()[0].encode();
        let mut b = good.clone();
        b[0] = b'X';
        assert_eq!(Datagram::decode(&b), Err(WireError::BadMagic));
        let mut b = good.clone();
        b[4] = 2;
        assert_eq!(Datagram::decode(&b), Err(WireError::BadVersion(2)));
        let mut b = good.clone();
        b[5] = 0;
        assert_eq!(Datagram::decode(&b), Err(WireError::BadKind(0)));
        b[5] = 6;
        assert_eq!(Datagram::decode(&b), Err(WireError::BadKind(6)));
        // A beacon relabelled as a ping has the wrong length for a ping.
        b[5] = KIND_PING;
        assert_eq!(
            Datagram::decode(&b),
            Err(WireError::BadLength {
                kind: KIND_PING,
                len: 64
            })
        );
        assert_eq!(Datagram::decode(&[]), Err(WireError::TooShort));
        assert_eq!(Datagram::decode(&[0u8; 19]), Err(WireError::TooShort));
        assert_eq!(Datagram::decode(&[0u8; 65]), Err(WireError::TooLong));
        // Unknown flag bits are ignored (room for later versions of the same wire).
        let mut b = good.clone();
        b[6] |= 0b1000_0000;
        assert_eq!(Datagram::decode(&b), Datagram::decode(&good));
    }

    #[test]
    fn out_of_range_fields_are_refused() {
        let base = samples()[0];
        let Body::Beacon(beacon) = base.body else {
            unreachable!()
        };
        let with = |b: Beacon| {
            Datagram {
                body: Body::Beacon(b),
                ..base
            }
            .encode()
        };
        let field = |b: Beacon| Datagram::decode(&with(b)).map(|_| ());
        for tempo in [f64::NAN, f64::INFINITY, -128.0, 0.0, 19.999, 300.001, 1e300] {
            assert_eq!(
                field(Beacon { tempo, ..beacon }),
                Err(WireError::BadField("tempo")),
                "{tempo}"
            );
        }
        for tempo in [20.0, 128.0, 300.0] {
            assert_eq!(field(Beacon { tempo, ..beacon }), Ok(()), "{tempo}");
        }
        for beat in [f64::NAN, f64::NEG_INFINITY, 1.1e9, -1.1e9] {
            assert_eq!(
                field(Beacon { beat, ..beacon }),
                Err(WireError::BadField("beat")),
                "{beat}"
            );
        }
        assert_eq!(
            field(Beacon {
                session_id: 0,
                ..beacon
            }),
            Err(WireError::BadField("session_id"))
        );
        assert_eq!(
            field(Beacon {
                t_origin: beacon.t_send + MAX_ORIGIN_AGE_US + 1,
                ..beacon
            }),
            Err(WireError::BadField("t_origin"))
        );
        assert_eq!(
            field(Beacon {
                t_send: MAX_TIME_US + 1,
                ..beacon
            }),
            Err(WireError::BadField("t_send"))
        );
        assert_eq!(
            field(Beacon {
                t_origin: u64::MAX,
                ..beacon
            }),
            Err(WireError::BadField("t_origin"))
        );
        let mut q = with(beacon);
        q[62] = 3;
        assert_eq!(Datagram::decode(&q), Err(WireError::BadField("quantum")));
        let zero_peer = Datagram { peer_id: 0, ..base }.encode();
        assert_eq!(
            Datagram::decode(&zero_peer),
            Err(WireError::BadField("peer_id"))
        );

        let st = |bpm: f64, at_beat: f64| {
            let d = Datagram {
                body: Body::SetTempo {
                    session_id: 9,
                    bpm,
                    at_beat,
                },
                ..base
            };
            Datagram::decode(&d.encode()).map(|_| ())
        };
        for bpm in [f64::NAN, 0.0, 10.0, 301.0, f64::INFINITY] {
            assert_eq!(st(bpm, 0.0), Err(WireError::BadField("bpm")), "{bpm}");
        }
        assert_eq!(st(120.0, f64::NAN), Err(WireError::BadField("at_beat")));
        assert_eq!(st(120.0, 16.0), Ok(()));

        let pong = |t_recv: u64| {
            let d = Datagram {
                body: Body::Pong {
                    seq: 1,
                    t_send: 1,
                    t_recv,
                    t_reply: 2,
                },
                ..base
            };
            Datagram::decode(&d.encode()).map(|_| ())
        };
        assert_eq!(pong(u64::MAX), Err(WireError::BadField("t_recv")));
        assert_eq!(pong(5), Ok(()));
    }
}
