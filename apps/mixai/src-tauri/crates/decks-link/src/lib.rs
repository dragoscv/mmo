//! # decks-link — MixAI Decks LAN tempo sync (WP19-29, ADR-0014)
//!
//! Beat, phase and tempo shared between Decks instances on one network over UDP. Own protocol
//! (MIT OR Apache-2.0), written from scratch: Ableton Link and its Rust bindings are GPL and
//! are neither linked nor imitated (different messages, different roles, different wire).
//!
//! The crate knows nothing about the audio engine: the app feeds it the local master clock
//! while it leads ([`LinkNode::feed_local_clock`]) and reads back the session clock to steer
//! its own while it follows ([`LinkNode::status`]). User guide: `docs/decks/link.md`.
//!
//! ## Model
//!
//! * A **peer** is one running app. It has a random 64-bit `peer_id` and a monotonic clock in
//!   microseconds that no other peer shares.
//! * A **session** is a set of peers that agree on one timeline: a tempo (20..=300 BPM) and a
//!   beat count that advances with it. The bar is four beats ([`QUANTUM`]).
//! * The **leader** holds the timeline: its own clock is the session, followers convert it
//!   to theirs. Every beacon says whether its sender leads (a flag, no election messages).
//!   The peer that founded a session leads it; a peer that joins never takes the lead while
//!   a member has it, whatever its id. When the leader leaves, the lowest `peer_id` left
//!   takes over on the same timeline; if two members say they lead, the lower id stays.
//! * Clocks are compared with a ping / pong exchange (four timestamps, as in NTP). Per peer
//!   the eight latest samples are kept, none older than 10 s, and the one with the shortest
//!   round trip is used.
//! * A peer that meets another session joins it (or is joined) by a fixed rule both sides
//!   evaluate alike: a peer that started less than two seconds ago and is still alone gives
//!   way; else the session with more members stays (members heard within the last second);
//!   else the one with the lower `session_id`. The joining peer takes the beat of the session
//!   it joins and never changes it; for [`JOIN_SETTLE_US`] after joining it reports
//!   `leader = false` in any case, so the app aligns its own clock first.
//! * A session id starts as the id of the peer that founded it. When the leader falls silent
//!   (timeout, not a goodbye) the members left go on under a new id they all compute alike.
//!   A leader that comes back after a network drop still announces the old id: it is another
//!   session, the rule above applies, and it joins the others instead of pulling them back
//!   to a timeline that stopped when it left.
//! * Any peer may propose a tempo (`SetTempo`); the leader adopts it and its next beacons
//!   carry it to everybody. Not while the leader's clock is a playing deck
//!   ([`LinkSession::set_tempo_locked`]): the tempo is then that deck's, the beacons say so,
//!   and proposals are refused on both sides instead of being taken and put back.
//! * **Nudge** shifts a follower against the session; on the leader it is refused (its clock
//!   is the session, so a shift there would move every follower the other way).
//! * A session may have a **key** derived from a 4-digit PIN ([`key_from_pin`]); datagrams
//!   with another key are ignored. Key 0 = open session. The key groups instances; it is
//!   not a password (see Security).
//!
//! ## Transport
//!
//! IPv4 UDP, multicast group [`MULTICAST_ADDR`] port [`DEFAULT_PORT`]. Every datagram, group
//! or unicast, leaves with IP TTL 1: no router forwards it. Beacons go to the group and, by
//! unicast, to every known peer and every configured extra peer; ping, pong and tempo
//! proposals are unicast to the source IP address of the peer's beacons, on the port those
//! beacons name. A peer that leaves ten pings in a row unanswered gets one ping and one
//! unicast beacon a second from then on (it may be a forged address). std cannot share a UDP
//! port, so further instances on one machine listen on the next ports (42030..=42032) and
//! all instances also announce to that range on `127.0.0.1`; a node bound to `127.0.0.1`
//! ("this computer only") uses that range alone and touches no other address.
//!
//! A node reads its socket in a blocking receive without a timeout and is woken to stop by
//! a datagram to its own port. A node bound to one LAN address reads with a 400 ms timeout
//! instead, so it can stop (and give its port back) when its interface is down and that
//! datagram cannot be sent; [`stuck_receivers`] counts receivers that could not be ended.
//! The measurements behind both choices are in the documentation of the `node` module.
//!
//! ## Wire format (version 1)
//!
//! Little-endian, fixed length per kind, at most 64 bytes ([`wire`]). Header, 20 bytes:
//!
//! | Offset | Size | Field | Notes |
//! |---|---|---|---|
//! | 0 | 4 | magic | `MXLK` |
//! | 4 | 1 | version | 1 |
//! | 5 | 1 | kind | 1 beacon, 2 ping, 3 pong, 4 set tempo, 5 bye |
//! | 6 | 1 | flags | beacon: bit 0 = newborn (started under 2 s ago, alone), bit 1 = the sender leads its session, bit 2 = its tempo follows a playing deck (with bit 1); other bits ignored |
//! | 7 | 1 | reserved | 0 when sent, ignored when read |
//! | 8 | 4 | key | u32, 0 = open session |
//! | 12 | 8 | peer_id | u64, never 0 |
//!
//! Body by kind (offsets from the start of the datagram):
//!
//! | Kind | Length | Fields |
//! |---|---|---|
//! | beacon | 64 | 20 `session_id` u64 · 28 `tempo` f64 BPM · 36 `beat` f64 · 44 `t_origin` u64 µs (sender clock at which `beat` holds) · 52 `t_send` u64 µs · 60 `reply_port` u16 (0 = source port) · 62 `quantum` u8 = 4 · 63 `members` u8 (peers in the sender's session, itself included) |
//! | ping | 32 | 20 `seq` u32 · 24 `t_send` u64 |
//! | pong | 48 | 20 `seq` u32 · 24 `t_send` u64 (echo) · 32 `t_recv` u64 · 40 `t_reply` u64 |
//! | set tempo | 44 | 20 `session_id` u64 · 28 `bpm` f64 · 36 `at_beat` f64 |
//! | bye | 28 | 20 `session_id` u64 |
//!
//! A datagram is refused when the magic, version or kind is unknown, when its length is not
//! the length of its kind, when an id is 0, a tempo is outside 20..=300 or not finite, a beat
//! is not finite or beyond ±1e9, a time stamp is above 2^60, a beacon's `t_origin` is more
//! than an hour from its `t_send`, or its quantum is not 4.
//!
//! ## Timing constants
//!
//! | Constant | Value |
//! |---|---|
//! | beacon interval | 200 ms |
//! | peer timeout | 3 s without a beacon |
//! | ping interval | 200 ms until four samples exist, then 1 s; 1 s after ten unanswered pings |
//! | samples kept | 8, none older than 10 s |
//! | settle time after joining | 500 ms |
//!
//! ## Security
//!
//! One network segment, no authentication, no encryption: any device on the segment can
//! join an open session and set its tempo, and one that sends beacons that say it leads,
//! with a low id, takes the timeline. The PIN key is a grouping code: it keeps instances of
//! other people out by accident, not by force (it travels in clear in every datagram and
//! there are 10 000 of them). Answers go to the source address of a beacon, which can be
//! forged: TTL 1 keeps them on the segment, the ping back-off bounds them to about two
//! datagrams a second per forged peer, and a full peer table drops the oldest peer that
//! never answered a ping, but none heard for less than 200 ms (one ping interval: a real
//! newcomer has not had the time to answer). So forged ids cannot keep real instances out
//! for good, and cannot push out one that just arrived; while a flood of new ids lasts, a
//! full table takes at most one newcomer per 200 ms per slot that falls free. Every input
//! is bounds-checked and range-checked; nothing here panics on a datagram.

mod node;
mod session;
pub mod wire;

use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub use node::{LOCAL_INSTANCES, LinkConfig, LinkNode, LinkSnapshot, stuck_receivers};
pub use session::{
    BEACON_INTERVAL_US, JOIN_SETTLE_US, LinkClock, LinkSession, LinkStats, MAX_PEERS, NEWBORN_US,
    Outgoing, PEER_TIMEOUT_US, PeerInfo, QUANTUM, SAMPLE_MAX_AGE_US, SAMPLES_KEPT,
};
pub use wire::{MAX_TEMPO, MIN_TEMPO, valid_tempo};

/// Protocol version carried in every datagram; bump on breaking wire changes.
pub const PROTOCOL_VERSION: u8 = 1;

/// IPv4 multicast group of the protocol (administratively scoped, RFC 2365).
pub const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 29);

/// UDP port of the protocol.
pub const DEFAULT_PORT: u16 = 42029;

/// Session key of a 4-digit PIN: `None` unless `pin` is exactly four ASCII digits. Never 0
/// (0 is the open session). FNV-1a over a fixed prefix and the digits: a room code, not a
/// secret (the key is sent in clear and there are only 10 000 PINs).
pub fn key_from_pin(pin: &str) -> Option<u32> {
    let digits = pin.as_bytes();
    if digits.len() != 4 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let mut h: u32 = 0x811c_9dc5;
    for &b in b"MXLK-pin:".iter().chain(digits) {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    Some(h.max(1))
}

/// One round of SplitMix64: a well-mixed 64-bit value from any 64-bit input.
pub(crate) fn mix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// A peer id for this run: wall time, process id, the monotonic clock, a stack address and a
/// per-process counter, mixed. Not cryptographic (ids only break ties and name peers); never
/// 0, and never the same twice in one process.
pub fn random_peer_id() -> u64 {
    static CALLS: AtomicU64 = AtomicU64::new(0);
    let call = CALLS.fetch_add(1, Ordering::Relaxed);
    let wall = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let local = 0u8;
    let stack = std::ptr::addr_of!(local) as usize as u64;
    let seed = mix64(wall)
        ^ mix64(u64::from(std::process::id()).rotate_left(32))
        ^ mix64(monotonic_micros().rotate_left(17))
        ^ mix64(stack.rotate_left(7));
    // The counter goes in last and alone: two calls in one clock tick still differ.
    mix64(seed.wrapping_add(call.wrapping_mul(0x9e37_79b9_7f4a_7c15))).max(1)
}

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Monotonic microseconds since the first call in this process: the default clock of a
/// [`LinkNode`]. An app with its own time base passes that instead ([`LinkConfig::clock`]).
pub fn monotonic_micros() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// IPv4 address of the interface the default route uses (no packet is sent: a connected UDP
/// socket only asks the routing table). Loopback when there is no network.
pub fn lan_ip() -> Ipv4Addr {
    let ip = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .and_then(|s| {
            s.connect((Ipv4Addr::new(192, 0, 2, 1), 9))?;
            s.local_addr()
        })
        .map(|a| a.ip());
    match ip {
        Ok(IpAddr::V4(v4)) if !v4.is_unspecified() => v4,
        _ => Ipv4Addr::LOCALHOST,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_key_needs_exactly_four_digits_and_is_never_zero() {
        for bad in ["", "123", "12345", "12a4", "١٢٣٤", " 123", "12.4", "-123"] {
            assert_eq!(key_from_pin(bad), None, "{bad:?}");
        }
        let mut seen = std::collections::HashSet::new();
        for n in 0..10_000 {
            let key = key_from_pin(&format!("{n:04}")).expect("four digits");
            assert_ne!(key, 0);
            seen.insert(key);
        }
        // Different PINs give different keys (no collision among the 10 000).
        assert_eq!(seen.len(), 10_000);
        // Stable across versions: peers with the same PIN must compute the same key.
        assert_eq!(key_from_pin("0000"), Some(0x2b0e_23af));
        assert_eq!(key_from_pin("1234"), Some(0xb0df_df8f));
    }

    #[test]
    fn peer_ids_differ_and_are_never_zero() {
        // A tight loop: many calls share one tick of every clock.
        let ids: std::collections::HashSet<u64> = (0..2_000).map(|_| random_peer_id()).collect();
        assert!(!ids.contains(&0));
        assert_eq!(ids.len(), 2_000);
    }

    #[test]
    fn monotonic_clock_does_not_go_back() {
        let a = monotonic_micros();
        let b = monotonic_micros();
        assert!(b >= a);
    }
}
