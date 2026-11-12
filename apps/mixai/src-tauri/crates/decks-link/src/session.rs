//! The decks-link state machine: no sockets, no clock of its own, no threads.
//!
//! The caller passes every received datagram to [`LinkSession::on_datagram`] and calls
//! [`LinkSession::tick`] every 20 ms or so with its monotonic clock in microseconds; `tick`
//! returns the datagrams to send. Everything else is a pure query or a small state change, so
//! a whole network of sessions can be simulated in a unit test with injected clocks.

use std::cmp::Reverse;
use std::collections::VecDeque;
use std::net::SocketAddr;

use crate::wire::{Beacon, Body, Datagram, MAX_TIME_US, valid_beat, valid_tempo};

/// Beats per bar: phase is aligned modulo this many beats.
pub const QUANTUM: f64 = 4.0;
/// Time between two beacons of one peer.
pub const BEACON_INTERVAL_US: u64 = 200_000;
/// A peer is forgotten when no beacon arrived for this long.
pub const PEER_TIMEOUT_US: u64 = 3_000_000;
/// Clock samples kept per peer.
pub const SAMPLES_KEPT: usize = 8;
/// A clock sample older than this is not used.
pub const SAMPLE_MAX_AGE_US: u64 = 10_000_000;
/// After joining a session a peer reports `leader = false` for this long, even when its id
/// makes it the leader, so its app aligns to the session before it starts to drive it.
pub const JOIN_SETTLE_US: u64 = 500_000;
/// A peer that started less than this ago, alone, yields to any session it meets.
pub const NEWBORN_US: u64 = 2_000_000;
/// Peers tracked at once (more are ignored until one leaves).
pub const MAX_PEERS: usize = 32;

/// Ping interval while a peer has fewer than [`FAST_SAMPLES`] fresh samples, and after.
const PING_FAST_US: u64 = 200_000;
const PING_SLOW_US: u64 = 1_000_000;
const FAST_SAMPLES: usize = 4;
/// Pings awaiting their pong, per peer.
const PENDING_PINGS: usize = 8;
/// In a full table a peer whose clock was never measured makes room for a newcomer only
/// once it has been known for this long: one fast ping interval. The first ping to a new
/// peer leaves with its first beacon, so a real one has had a whole round trip by then;
/// before that, a stream of made-up ids could push a real newcomer out again before its
/// first pong arrived.
const EVICT_MIN_AGE_US: u64 = PING_FAST_US;
/// A peer that left this many pings in a row without an answer is pinged, and sent its own
/// copy of our beacons, at the slow rate only. It may not exist: a forged beacon must not buy
/// a stream of datagrams to its source address.
const UNANSWERED_FAST_PINGS: u8 = 10;
/// A quiet peer (see above) gets one of our beacons in this many by unicast: one a second.
const QUIET_BEACON_EVERY: u32 = 5;
/// After a session went on without its leader, a member that still announces the old session
/// id is read as a member of the new one for this long: it has not noticed yet.
const REFOUND_GRACE_US: u64 = 1_000_000;
/// The member count a beacon carries, and the one the merge rule compares, only includes
/// members heard within this time. A peer whose network just came back must not weigh in
/// with members it has not heard for seconds.
const MEMBER_LIVE_US: u64 = 1_000_000;
/// A round trip longer than this is not a usable clock sample.
const MAX_RTT_US: i64 = 2_000_000;
/// Pongs waiting for the next tick (a flood of pings cannot grow the queue).
const MAX_PENDING_PONGS: usize = 64;
/// A tempo proposal is repeated at this interval until the leader shows it, for this long.
const PROPOSAL_RESEND_US: u64 = 200_000;
const PROPOSAL_LIFE_US: u64 = 1_000_000;
/// Largest phase shift kept by [`LinkSession::nudge`], in beats (half a bar either way).
const NUDGE_SPAN: f64 = QUANTUM / 2.0;
/// The leader's own clock, fed every few tens of milliseconds, carries the timing jitter of
/// the audio callback. An error below this is taken a tenth at a time (smooth for the
/// followers, still follows slow drift); a larger one (seek, new track) is taken at once.
const LOCAL_JUMP_US: f64 = 20_000.0;
const LOCAL_SLEW: f64 = 0.1;

/// One datagram to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    /// `None` = the multicast group (and the configured extra peers); `Some` = this address.
    pub to: Option<SocketAddr>,
    pub bytes: Vec<u8>,
}

/// The session clock as this peer sees it at one instant of its own clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinkClock {
    /// Session tempo in BPM.
    pub bpm: f64,
    /// Beat count this peer should be at (session beat plus the local nudge).
    pub beat: f64,
    /// `beat` modulo [`QUANTUM`]: 0 = the downbeat of the bar.
    pub phase_in_quantum: f64,
    /// Other peers in the session.
    pub peers: usize,
    /// True when this peer drives the session timeline (it follows nobody, and it has settled
    /// after joining).
    pub leader: bool,
    /// Leader clock minus our clock, in microseconds (0 while we lead or have no sample).
    pub offset_us: i64,
    /// The session tempo follows a playing deck of the peer that leads (ours while we lead):
    /// [`LinkSession::set_tempo`] is refused.
    pub tempo_locked: bool,
}

/// One known peer, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerInfo {
    pub id: u64,
    pub addr: SocketAddr,
    /// It is in our session (a peer in another session is about to merge with ours).
    pub in_session: bool,
    /// Its clock minus ours, from the best fresh sample.
    pub offset_us: Option<i64>,
    /// Round trip of that sample.
    pub rtt_us: Option<i64>,
    /// Microseconds since its last beacon.
    pub silent_us: u64,
}

/// Counters for diagnostics (they only grow).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LinkStats {
    /// Datagrams that did not parse (wrong magic, version, length, field range).
    pub malformed: u64,
    /// Well-formed datagrams of a session with another key (another PIN).
    pub other_key: u64,
    /// Well-formed datagrams that were not used (our own, unknown peer, stale, table full).
    pub ignored: u64,
    /// Datagrams that changed state or were answered.
    pub accepted: u64,
}

/// The session timeline in local clock terms: `beat` holds at local time `at_us`.
#[derive(Debug, Clone, Copy)]
struct Timeline {
    tempo: f64,
    beat: f64,
    /// May be negative: an origin that lies before this peer's clock started.
    at_us: i64,
}

impl Timeline {
    fn beat_at(&self, now: u64) -> f64 {
        self.beat + (now as i64 - self.at_us) as f64 * self.tempo / 60e6
    }
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    /// Peer clock minus our clock.
    offset_us: i64,
    rtt_us: i64,
    at: u64,
}

#[derive(Debug)]
struct Peer {
    id: u64,
    addr: SocketAddr,
    last_seen: u64,
    /// When its first beacon arrived (in a full table the oldest unmeasured peer makes room,
    /// once it is [`EVICT_MIN_AGE_US`] old).
    first_seen: u64,
    /// Send stamp of its newest beacon (older ones arriving late are dropped).
    last_t_send: u64,
    session_id: u64,
    newborn: bool,
    /// Its beacons say it holds the timeline of its session.
    leads: bool,
    /// Its beacons say its tempo follows a playing deck.
    tempo_locked: bool,
    members: u8,
    tempo: f64,
    beat: f64,
    t_origin: u64,
    samples: VecDeque<Sample>,
    /// (seq, our send time) of pings without a pong yet.
    pings: VecDeque<(u32, u64)>,
    next_ping_at: u64,
    /// Pings sent since its last usable answer.
    unanswered: u8,
    /// It was a member when our session went on without its leader (see [`Refound`]).
    survivor: bool,
}

impl Peer {
    fn fresh(&self, now: u64) -> impl Iterator<Item = &Sample> {
        self.samples
            .iter()
            .filter(move |s| now.saturating_sub(s.at) <= SAMPLE_MAX_AGE_US)
    }

    /// The fresh sample with the shortest round trip: the least distorted by queueing.
    fn best(&self, now: u64) -> Option<Sample> {
        self.fresh(now).min_by_key(|s| s.rtt_us).copied()
    }

    /// It does not answer: slow pings, and one unicast beacon a second.
    fn quiet(&self) -> bool {
        self.unanswered >= UNANSWERED_FAST_PINGS
    }

    /// The timeline this peer announces, on our clock (`offset_us` = its clock − ours).
    /// `None` when the result is out of range (a broken or hostile peer).
    fn timeline(&self, offset_us: i64, now: u64) -> Option<Timeline> {
        let tl = Timeline {
            tempo: self.tempo,
            beat: self.beat,
            at_us: self.t_origin as i64 - offset_us,
        };
        (valid_tempo(tl.tempo) && valid_beat(tl.beat_at(now))).then_some(tl)
    }
}

#[derive(Debug, Clone, Copy)]
struct PendingPong {
    to: SocketAddr,
    seq: u32,
    t_send: u64,
    t_recv: u64,
}

/// A tempo this peer asked the leader for, repeated until the leader's beacons show it.
#[derive(Debug, Clone, Copy)]
struct Proposal {
    bpm: f64,
    since: u64,
    next_send: u64,
}

/// The session went on under a new id after its leader fell silent. Until `until`, a member
/// of that moment that still announces `old` is counted as a member (it will notice within a
/// moment); the peer that fell silent announces `old` too when it comes back, and is then
/// another session, met through the merge rule.
#[derive(Debug, Clone, Copy)]
struct Refound {
    old: u64,
    until: u64,
}

/// Id of the session that goes on after the peer `lost` (its leader) fell silent. Every
/// survivor computes it from the same two facts, so they agree without a message and in
/// whatever order they notice. Always a little above `old` (modulo 2^64): when the two meet
/// again with as many members each, the merge rule ("the lower id stays") keeps the original.
fn refounded_id(old: u64, lost: u64) -> u64 {
    let step = 1 + (crate::mix64(old ^ crate::mix64(lost)) & 0xFFFF_FFFF);
    old.wrapping_add(step).max(1)
}

/// One peer of a tempo-sync session. See the crate documentation for the model.
#[derive(Debug)]
pub struct LinkSession {
    peer_id: u64,
    key: u32,
    /// UDP port peers must answer to (0 = the source port of our datagrams).
    reply_port: u16,
    session_id: u64,
    timeline: Timeline,
    nudge: f64,
    /// We hold the timeline of our session (we follow nobody and have settled after joining);
    /// as of the last tick or datagram. Sent in our beacons.
    claim: bool,
    /// Our own clock is a playing deck: while we hold the timeline its tempo is not ours to
    /// change (set by the app, see [`LinkSession::set_tempo_locked`]).
    tempo_locked: bool,
    peers: Vec<Peer>,
    started_at: Option<u64>,
    /// Somebody else has been in our session, or we joined one: no longer a newborn.
    established: bool,
    settle_until: u64,
    next_beacon_at: u64,
    /// Beacons sent (quiet peers get one in [`QUIET_BEACON_EVERY`] by unicast).
    beacon_round: u32,
    next_seq: u32,
    pongs: VecDeque<PendingPong>,
    proposal: Option<Proposal>,
    /// Tempo a session member asked for and we (the leader) adopted; the app takes it.
    tempo_request: Option<f64>,
    refounded: Option<Refound>,
    stats: LinkStats,
}

fn clamp_time(now: u64) -> u64 {
    now.min(MAX_TIME_US)
}

impl LinkSession {
    /// A peer alone in its own session, at `local_tempo` (128 when that is not a valid tempo),
    /// beat 0 at its first `tick`. `peer_id` 0 is replaced by 1 (0 is not a valid id).
    pub fn new(peer_id: u64, local_tempo: f64) -> Self {
        let peer_id = peer_id.max(1);
        let tempo = if valid_tempo(local_tempo) {
            local_tempo
        } else {
            128.0
        };
        Self {
            peer_id,
            key: 0,
            reply_port: 0,
            session_id: peer_id,
            timeline: Timeline {
                tempo,
                beat: 0.0,
                at_us: 0,
            },
            nudge: 0.0,
            claim: true,
            tempo_locked: false,
            peers: Vec::new(),
            started_at: None,
            established: false,
            settle_until: 0,
            next_beacon_at: 0,
            beacon_round: 0,
            next_seq: 1,
            pongs: VecDeque::new(),
            proposal: None,
            tempo_request: None,
            refounded: None,
            stats: LinkStats::default(),
        }
    }

    /// Same, in a keyed session (see [`crate::key_from_pin`]); 0 = open.
    pub fn with_key(peer_id: u64, local_tempo: f64, key: u32) -> Self {
        let mut s = Self::new(peer_id, local_tempo);
        s.key = key;
        s
    }

    pub fn peer_id(&self) -> u64 {
        self.peer_id
    }

    pub fn session_id(&self) -> u64 {
        self.session_id
    }

    pub fn key(&self) -> u32 {
        self.key
    }

    pub fn stats(&self) -> LinkStats {
        self.stats
    }

    /// The UDP port this peer reads on, announced in its beacons. Needed when beacons leave
    /// from another socket than the one that listens (0 = answer to the source port).
    pub fn set_reply_port(&mut self, port: u16) {
        self.reply_port = port;
    }

    /// Tell the session whether this peer's own clock is a playing deck (true) or a clock
    /// whose tempo can be set (false). While true and this peer holds the timeline, the
    /// session tempo is the deck's: [`LinkSession::set_tempo`] and tempo proposals of other
    /// members are refused, and the beacons say so. The app calls this whenever it feeds its
    /// clock.
    pub fn set_tempo_locked(&mut self, locked: bool) {
        self.tempo_locked = locked;
    }

    fn start(&mut self, now: u64) {
        if self.started_at.is_none() {
            self.started_at = Some(now);
            // Beat 0 is "now", not the zero of the local clock.
            self.timeline.at_us = now as i64;
        }
    }

    fn newborn(&self, now: u64) -> bool {
        !self.established
            && self
                .started_at
                .is_none_or(|t| now.saturating_sub(t) < NEWBORN_US)
    }

    fn in_session(&self, p: &Peer) -> bool {
        p.session_id == self.session_id
    }

    fn members(&self) -> u8 {
        let others = self.peers.iter().filter(|p| self.in_session(p)).count();
        (others + 1).min(255) as u8
    }

    /// Members heard within [`MEMBER_LIVE_US`], ourselves included: the weight of our session
    /// when two sessions meet.
    fn live_members(&self, now: u64) -> u8 {
        let others = self
            .peers
            .iter()
            .filter(|p| self.in_session(p) && now.saturating_sub(p.last_seen) <= MEMBER_LIVE_US)
            .count();
        (others + 1).min(255) as u8
    }

    /// The member we follow; `None` = nobody, the timeline is ours to keep.
    ///
    /// A member that says it leads is followed whatever its id, so a peer that joins never
    /// takes the lead from the one that has it. When two say so (two sessions just merged in
    /// an unusual order) the lower id stays, ours included. Only when nobody says so (the
    /// leader left) the lowest id of the session takes over.
    fn leader_index(&self) -> Option<usize> {
        let members = || {
            self.peers
                .iter()
                .enumerate()
                .filter(|(_, p)| self.in_session(p))
        };
        let leading = members().filter(|(_, p)| p.leads).min_by_key(|(_, p)| p.id);
        match leading {
            Some((_, p)) if self.claim && self.peer_id < p.id => None,
            Some((i, _)) => Some(i),
            None if self.claim => None,
            None => members()
                .filter(|(_, p)| p.id < self.peer_id)
                .min_by_key(|(_, p)| p.id)
                .map(|(i, _)| i),
        }
    }

    /// We follow nobody and have settled after joining: the session timeline is ours.
    fn holds_timeline(&self, now: u64) -> bool {
        self.leader_index().is_none() && now >= self.settle_until
    }

    /// True when the session `p` announces stays and ours joins it. Both sides evaluate the
    /// same rule on the same facts, so exactly one of two sessions gives way: a newborn to an
    /// established one, the smaller to the larger, then the higher session id to the lower.
    fn other_wins(&self, p: &Peer, now: u64) -> bool {
        let mine_new = self.newborn(now);
        if p.newborn != mine_new {
            return mine_new;
        }
        let (mine, theirs) = (self.live_members(now), p.members.max(1));
        if mine != theirs {
            return theirs > mine;
        }
        p.session_id < self.session_id
    }

    /// Re-evaluate membership and the timeline after anything changed.
    fn reconsider(&mut self, now: u64) {
        if self.refounded.is_some_and(|r| now >= r.until) {
            self.refounded = None;
        }
        if self.peers.iter().any(|p| self.in_session(p)) {
            self.established = true;
        }
        // 1. Another session that stays: join it as soon as the clock of the member that
        //    leads it is known (the lowest id when none says so). We take its beat; it never
        //    takes ours.
        let target = self
            .peers
            .iter()
            .filter(|p| !self.in_session(p) && self.other_wins(p, now))
            .min_by_key(|p| (p.newborn, Reverse(p.members.max(1)), p.session_id))
            .map(|p| p.session_id);
        if let Some(target) = target {
            let joined = self
                .peers
                .iter()
                .filter(|p| p.session_id == target)
                .min_by_key(|p| (!p.leads, p.id))
                .and_then(|p| p.best(now).map(|s| (p, s)))
                .and_then(|(p, s)| p.timeline(s.offset_us, now));
            if let Some(tl) = joined {
                self.timeline = tl;
                self.session_id = target;
                self.established = true;
                self.settle_until = now.saturating_add(JOIN_SETTLE_US);
                self.proposal = None;
                // Whoever leads the session we join keeps leading it.
                self.claim = false;
                self.refounded = None;
            }
        }
        // 2. Follow the leader of our session.
        let followed = self
            .leader_index()
            .map(|i| &self.peers[i])
            .and_then(|p| p.best(now).map(|s| (p, s)))
            .and_then(|(p, s)| p.timeline(s.offset_us, now));
        if let Some(tl) = followed {
            self.timeline = tl;
        }
        // 3. Say in our beacons whether we hold the timeline.
        if self.leader_index().is_some() {
            self.claim = false;
        } else if now >= self.settle_until {
            self.claim = true;
        }
    }

    /// The member we followed fell silent: the session goes on without it, under a new id
    /// every member left computes alike. When that peer comes back it still announces the old
    /// id, so it is another session and the merge rule decides (it joins us when we are more),
    /// instead of being "in session" at once with a timeline that stopped when it left.
    fn refound(&mut self, lost: u64, now: u64) {
        let old = self.session_id;
        let new = refounded_id(old, lost);
        for p in &mut self.peers {
            p.survivor = p.session_id == old;
            if p.survivor {
                p.session_id = new;
            }
        }
        self.session_id = new;
        self.refounded = Some(Refound {
            old,
            until: now.saturating_add(REFOUND_GRACE_US),
        });
    }

    /// Hand one received datagram to the session. `from` is its source address, `now_us` the
    /// local clock when it arrived. Bad input is counted and dropped; nothing panics.
    pub fn on_datagram(&mut self, bytes: &[u8], from: SocketAddr, now_us: u64) {
        let now = clamp_time(now_us);
        self.start(now);
        let d = match Datagram::decode(bytes) {
            Ok(d) => d,
            Err(_) => {
                self.stats.malformed += 1;
                return;
            }
        };
        if d.key != self.key {
            self.stats.other_key += 1;
            return;
        }
        if d.peer_id == self.peer_id {
            // Our own multicast coming back (or a peer that copied our id).
            self.stats.ignored += 1;
            return;
        }
        let used = match d.body {
            Body::Beacon(b) => self.on_beacon(d.peer_id, b, from, now),
            Body::Ping { seq, t_send } => self.on_ping(d.peer_id, seq, t_send, now),
            Body::Pong {
                seq,
                t_send,
                t_recv,
                t_reply,
            } => self.on_pong(d.peer_id, (seq, t_send), (t_recv, t_reply), now),
            Body::SetTempo {
                session_id, bpm, ..
            } => self.on_set_tempo(d.peer_id, session_id, bpm, now),
            Body::Bye { session_id } => {
                let before = self.peers.len();
                // A member that has not noticed the session went on says goodbye to the old id.
                let old = self.refounded.map(|r| r.old);
                self.peers.retain(|p| {
                    let named =
                        p.session_id == session_id || (p.survivor && old == Some(session_id));
                    !(p.id == d.peer_id && named)
                });
                let gone = self.peers.len() != before;
                if gone {
                    self.reconsider(now);
                }
                gone
            }
        };
        if used {
            self.stats.accepted += 1;
        } else {
            self.stats.ignored += 1;
        }
    }

    fn on_beacon(&mut self, id: u64, b: Beacon, from: SocketAddr, now: u64) -> bool {
        // Answers go to the source address, on the port the beacon names.
        let port = if b.reply_port == 0 {
            from.port()
        } else {
            b.reply_port
        };
        let addr = SocketAddr::new(from.ip(), port);
        let i = match self.peers.iter().position(|p| p.id == id) {
            Some(i) if b.t_send < self.peers[i].last_t_send => return false, // arrived late
            Some(i) => i,
            None => {
                if self.peers.len() >= MAX_PEERS {
                    // Full. The oldest peer whose clock was never measured makes room: a
                    // forged beacon is free, an answered ping takes a real peer, so made-up
                    // ids cannot keep real instances out. Not one that is younger than a
                    // ping interval: it may be a real newcomer whose first pong is on its
                    // way. All measured, or all that young: the newcomer waits (its next
                    // beacon comes 200 ms later).
                    let evictable = self
                        .peers
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| {
                            p.samples.is_empty()
                                && now.saturating_sub(p.first_seen) >= EVICT_MIN_AGE_US
                        })
                        .min_by_key(|(_, p)| p.first_seen)
                        .map(|(i, _)| i);
                    let Some(oldest) = evictable else {
                        return false;
                    };
                    let _ = self.peers.remove(oldest);
                }
                self.peers.push(Peer {
                    id,
                    addr,
                    last_seen: now,
                    first_seen: now,
                    last_t_send: 0,
                    session_id: b.session_id,
                    newborn: b.newborn,
                    leads: b.leads,
                    tempo_locked: b.leads && b.tempo_locked,
                    members: b.members,
                    tempo: b.tempo,
                    beat: b.beat,
                    t_origin: b.t_origin,
                    samples: VecDeque::with_capacity(SAMPLES_KEPT),
                    pings: VecDeque::with_capacity(PENDING_PINGS),
                    next_ping_at: now,
                    unanswered: 0,
                    survivor: false,
                });
                self.peers.len() - 1
            }
        };
        // A member of the session that went on without its leader may not have noticed yet.
        let (session, refounded) = (self.session_id, self.refounded);
        let p = &mut self.peers[i];
        let behind = p.survivor && refounded.is_some_and(|r| b.session_id == r.old);
        p.addr = addr;
        p.last_seen = now;
        p.last_t_send = b.t_send;
        p.session_id = if behind { session } else { b.session_id };
        p.newborn = b.newborn;
        p.leads = b.leads;
        p.tempo_locked = b.leads && b.tempo_locked;
        p.members = b.members;
        p.tempo = b.tempo;
        p.beat = b.beat;
        p.t_origin = b.t_origin;
        self.reconsider(now);
        true
    }

    fn on_ping(&mut self, id: u64, seq: u32, t_send: u64, now: u64) -> bool {
        // Only peers we know are answered, at the address their beacons name (a peer may send
        // from another socket than the one it reads on).
        let to = self.peers.iter().find(|p| p.id == id).map(|p| p.addr);
        match to {
            Some(to) if self.pongs.len() < MAX_PENDING_PONGS => {
                self.pongs.push_back(PendingPong {
                    to,
                    seq,
                    t_send,
                    t_recv: now,
                });
                true
            }
            _ => false,
        }
    }

    /// `ping` = (seq, our send time) echoed by the peer; `peer` = (its receive time, its
    /// reply time) on its clock; `now` = our clock at arrival.
    fn on_pong(&mut self, id: u64, ping: (u32, u64), peer: (u64, u64), now: u64) -> bool {
        let Some(p) = self.peers.iter_mut().find(|p| p.id == id) else {
            return false;
        };
        // Only the answer to a ping we really sent to this peer counts.
        let Some(at) = p.pings.iter().position(|&sent| sent == ping) else {
            return false;
        };
        let _ = p.pings.remove(at);
        let (t_send, (t_recv, t_reply)) = (ping.1, peer);
        if t_reply < t_recv || now < t_send {
            return false;
        }
        // Four stamps: t1 and t4 on our clock, t2 and t3 on the peer's.
        let (t1, t2, t3, t4) = (t_send as i64, t_recv as i64, t_reply as i64, now as i64);
        let rtt_us = (t4 - t1) - (t3 - t2);
        if !(0..=MAX_RTT_US).contains(&rtt_us) {
            return false;
        }
        let offset_us = ((t2 - t1) + (t3 - t4)) / 2;
        if p.samples.len() >= SAMPLES_KEPT {
            p.samples.pop_front();
        }
        p.samples.push_back(Sample {
            offset_us,
            rtt_us,
            at: now,
        });
        if p.quiet() {
            // It answers after all: measure its clock at the fast rate again.
            p.next_ping_at = p.next_ping_at.min(now + PING_FAST_US);
        }
        p.unanswered = 0;
        self.reconsider(now);
        true
    }

    fn on_set_tempo(&mut self, id: u64, session_id: u64, bpm: f64, now: u64) -> bool {
        let member = self.peers.iter().any(|p| p.id == id && self.in_session(p));
        let ours_to_change = session_id == self.session_id && self.leader_index().is_none();
        // While our clock is a playing deck the tempo is not ours to give: adopting it here
        // would send every follower to the proposed tempo until the deck's tempo came back.
        if !member || !ours_to_change || self.tempo_locked || !valid_tempo(bpm) {
            return false;
        }
        self.retime(bpm, now);
        self.tempo_request = Some(bpm);
        true
    }

    /// Change the tempo at `now` without moving the beat.
    fn retime(&mut self, bpm: f64, now: u64) {
        self.timeline = Timeline {
            tempo: bpm,
            beat: self.timeline.beat_at(now),
            at_us: now as i64,
        };
    }

    /// Advance timers; returns what to send now (beacons, pings, pongs, tempo proposals).
    /// Call every 20 ms or so, and right after every `on_datagram`.
    pub fn tick(&mut self, now_us: u64) -> Vec<Outgoing> {
        let now = clamp_time(now_us);
        self.start(now);
        let mut out = Vec::new();

        let followed = self.leader_index().map(|i| self.peers[i].id);
        self.peers
            .retain(|p| now.saturating_sub(p.last_seen) <= PEER_TIMEOUT_US);
        match followed {
            Some(lost) if self.peers.iter().all(|p| p.id != lost) => self.refound(lost, now),
            _ => {}
        }
        self.reconsider(now);

        while let Some(p) = self.pongs.pop_front() {
            let pong = Body::Pong {
                seq: p.seq,
                t_send: p.t_send,
                t_recv: p.t_recv,
                t_reply: now,
            };
            out.push(Outgoing {
                to: Some(p.to),
                bytes: self.wrap(pong),
            });
        }

        let (key, peer_id) = (self.key, self.peer_id);
        for p in &mut self.peers {
            if now < p.next_ping_at {
                continue;
            }
            let seq = self.next_seq;
            self.next_seq = self.next_seq.wrapping_add(1);
            let ping = Datagram {
                key,
                peer_id,
                body: Body::Ping { seq, t_send: now },
            };
            if p.pings.len() >= PENDING_PINGS {
                p.pings.pop_front();
            }
            p.pings.push_back((seq, now));
            p.unanswered = p.unanswered.saturating_add(1);
            // Fast while its clock is being measured; not for a peer that never answers.
            let fast = p.fresh(now).count() < FAST_SAMPLES && !p.quiet();
            p.next_ping_at = now + if fast { PING_FAST_US } else { PING_SLOW_US };
            out.push(Outgoing {
                to: Some(p.addr),
                bytes: ping.encode(),
            });
        }

        if let Some(pr) = self.proposal {
            let shown = (self.timeline.tempo - pr.bpm).abs() < 1e-9;
            let leader = self
                .leader_index()
                .map(|i| (self.peers[i].addr, self.peers[i].tempo_locked));
            let refused = leader.is_some_and(|(_, locked)| locked);
            if shown || refused || now.saturating_sub(pr.since) > PROPOSAL_LIFE_US {
                self.proposal = None;
            } else if let Some((to, _)) = leader {
                if now >= pr.next_send {
                    let ask = Body::SetTempo {
                        session_id: self.session_id,
                        bpm: pr.bpm,
                        at_beat: self.timeline.beat_at(now),
                    };
                    out.push(Outgoing {
                        to: Some(to),
                        bytes: self.wrap(ask),
                    });
                    self.proposal = Some(Proposal {
                        next_send: now + PROPOSAL_RESEND_US,
                        ..pr
                    });
                }
            } else {
                // The leader left while we were asking: the timeline is ours now (unless our
                // own clock is a playing deck, whose tempo rules).
                if !self.tempo_locked {
                    self.retime(pr.bpm, now);
                }
                self.proposal = None;
            }
        }

        if now >= self.next_beacon_at {
            self.next_beacon_at = now + BEACON_INTERVAL_US;
            self.beacon_round = self.beacon_round.wrapping_add(1);
            let every_peer = self.beacon_round.is_multiple_of(QUIET_BEACON_EVERY);
            let bytes = self.beacon(now);
            // To the group, and to every known peer directly (multicast is often filtered on
            // Wi-Fi; once two peers know each other they no longer depend on it). A peer that
            // never answers gets its own copy once a second only.
            out.extend(
                self.peers
                    .iter()
                    .filter(|p| every_peer || !p.quiet())
                    .map(|p| Outgoing {
                        to: Some(p.addr),
                        bytes: bytes.clone(),
                    }),
            );
            out.push(Outgoing { to: None, bytes });
        }
        out
    }

    fn wrap(&self, body: Body) -> Vec<u8> {
        Datagram {
            key: self.key,
            peer_id: self.peer_id,
            body,
        }
        .encode()
    }

    fn beacon(&self, now: u64) -> Vec<u8> {
        self.wrap(Body::Beacon(Beacon {
            session_id: self.session_id,
            newborn: self.newborn(now),
            leads: self.claim,
            tempo_locked: self.claim && self.tempo_locked,
            tempo: self.timeline.tempo,
            // Re-based to the send time, so the origin is always a valid stamp of our clock.
            beat: self.timeline.beat_at(now),
            t_origin: now,
            t_send: now,
            reply_port: self.reply_port,
            members: self.live_members(now),
        }))
    }

    /// The datagrams that tell the others we leave now (send them, then drop the session).
    pub fn leave(&self) -> Vec<Outgoing> {
        let bytes = self.wrap(Body::Bye {
            session_id: self.session_id,
        });
        let mut out: Vec<Outgoing> = self
            .peers
            .iter()
            .map(|p| Outgoing {
                to: Some(p.addr),
                bytes: bytes.clone(),
            })
            .collect();
        out.push(Outgoing { to: None, bytes });
        out
    }

    /// The session clock at local time `now_us`.
    pub fn clock_at(&self, now_us: u64) -> LinkClock {
        let now = clamp_time(now_us);
        let leader = self.leader_index();
        // Beat 0 is the first tick or datagram: before it there is no origin to count from
        // (a status read before the node thread ran would show the raw local clock).
        let session_beat = match self.started_at {
            Some(_) => self.timeline.beat_at(now),
            None => self.timeline.beat,
        };
        let beat = session_beat + self.nudge;
        LinkClock {
            bpm: self.timeline.tempo,
            beat,
            phase_in_quantum: beat.rem_euclid(QUANTUM),
            peers: usize::from(self.members()) - 1,
            leader: leader.is_none() && now >= self.settle_until,
            offset_us: leader
                .and_then(|i| self.peers[i].best(now))
                .map_or(0, |s| s.offset_us),
            tempo_locked: match leader {
                Some(i) => self.peers[i].tempo_locked,
                None => self.tempo_locked,
            },
        }
    }

    /// True when the session has another member whose clock offset is known and fresh (and,
    /// when we follow, that member is the leader): the beat we report is the shared one.
    pub fn is_locked(&self, now_us: u64) -> bool {
        let now = clamp_time(now_us);
        match self.leader_index() {
            Some(i) => self.peers[i].best(now).is_some(),
            None => self
                .peers
                .iter()
                .any(|p| self.in_session(p) && p.best(now).is_some()),
        }
    }

    /// Ask for a session tempo. The peer that holds the timeline applies it at once; a
    /// follower proposes it to the leader, whose next beacons carry it. `false`, and nothing
    /// happens, when `bpm` is not finite or outside 20..=300, and when the session tempo
    /// follows a playing deck of the peer that leads ([`LinkClock::tempo_locked`]).
    pub fn set_tempo(&mut self, bpm: f64, now_us: u64) -> bool {
        if !valid_tempo(bpm) {
            return false;
        }
        let now = clamp_time(now_us);
        self.start(now);
        match self.leader_index() {
            None if self.tempo_locked => return false,
            None => {
                self.retime(bpm, now);
                self.proposal = None;
            }
            Some(i) if self.peers[i].tempo_locked => return false,
            Some(_) => {
                self.proposal = Some(Proposal {
                    bpm,
                    since: now,
                    next_send: now,
                });
            }
        }
        true
    }

    /// The app's own master clock (`beat` at local time `now_us`, playing at `bpm`). Used only
    /// while this peer leads ([`LinkClock::leader`]): the session tempo becomes `bpm` and the
    /// session phase becomes the phase of `beat`; the session beat count stays the nearest one
    /// with that phase (it never jumps by more than half a bar). Small differences are taken
    /// gradually. Returns whether the clock was used.
    pub fn set_local_clock(&mut self, bpm: f64, beat: f64, now_us: u64) -> bool {
        if !valid_tempo(bpm) || !valid_beat(beat) {
            return false;
        }
        let now = clamp_time(now_us);
        self.start(now);
        if self.leader_index().is_some() || now < self.settle_until {
            return false;
        }
        let current = self.timeline.beat_at(now);
        let want = beat - self.nudge;
        let bars = ((current - want) / QUANTUM).round();
        let mut aligned = want + bars * QUANTUM;
        if !valid_beat(aligned) {
            return false;
        }
        let same_tempo = (self.timeline.tempo - bpm).abs() < 1e-9;
        let error_us = (aligned - current).abs() * 60e6 / bpm;
        if same_tempo && error_us < LOCAL_JUMP_US {
            aligned = current + (aligned - current) * LOCAL_SLEW;
        }
        self.timeline = Timeline {
            tempo: bpm,
            beat: aligned,
            at_us: now as i64,
        };
        true
    }

    /// Shift this peer against the session by `delta_beats` (positive = we run ahead). A
    /// follower's control, local to it: nothing is sent, the session beat does not move. The
    /// total stays within half a bar either way.
    ///
    /// `false`, and nothing changes, when `delta_beats` is not finite or larger than a bar,
    /// and while this peer holds the timeline ([`LinkClock::leader`]): its clock is the
    /// session, so shifting it would shift every follower the other way. A follower that
    /// takes over keeps the shift it had (the session beat stays where the others have it)
    /// and cannot change it while it leads.
    pub fn nudge(&mut self, delta_beats: f64, now_us: u64) -> bool {
        if !delta_beats.is_finite()
            || delta_beats.abs() > QUANTUM
            || self.holds_timeline(clamp_time(now_us))
        {
            return false;
        }
        let total = self.nudge + delta_beats;
        self.nudge = (total + NUDGE_SPAN).rem_euclid(QUANTUM) - NUDGE_SPAN;
        true
    }

    /// The local phase shift set with [`LinkSession::nudge`], in beats.
    pub fn nudge_beats(&self) -> f64 {
        self.nudge
    }

    /// A tempo another member asked for and this peer, holding the timeline, adopted. The app
    /// applies it to its own master clock (otherwise its next [`LinkSession::set_local_clock`]
    /// puts the old tempo back). Returned once.
    pub fn take_tempo_request(&mut self) -> Option<f64> {
        self.tempo_request.take()
    }

    /// Every peer we hear with our key, for the UI.
    pub fn peers(&self, now_us: u64) -> Vec<PeerInfo> {
        let now = clamp_time(now_us);
        self.peers
            .iter()
            .map(|p| {
                let best = p.best(now);
                PeerInfo {
                    id: p.id,
                    addr: p.addr,
                    in_session: self.in_session(p),
                    offset_us: best.map(|s| s.offset_us),
                    rtt_us: best.map(|s| s.rtt_us),
                    silent_us: now.saturating_sub(p.last_seen),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    /// One simulated machine: a session and a clock that is `skew` µs ahead of true time.
    struct Host {
        s: LinkSession,
        skew: u64,
        up: bool,
    }

    struct Packet {
        due: u64,
        to: usize,
        from: usize,
        bytes: Vec<u8>,
    }

    /// A network of sessions with injected clocks. True time advances in 1 ms steps; every
    /// running host ticks every 20 ms; a datagram takes `delay_us` to arrive.
    struct Net {
        hosts: Vec<Host>,
        wire: Vec<Packet>,
        t: u64,
        next_tick: u64,
        delay_us: u64,
        /// Datagrams from `.0` to `.1` are lost.
        cut: Vec<(usize, usize)>,
    }

    fn addr(i: usize) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, i as u8 + 1)), 42029)
    }

    fn ms(beats: f64, bpm: f64) -> f64 {
        beats.abs() * 60_000.0 / bpm
    }

    impl Net {
        /// `hosts` = (peer id, own tempo, clock skew in µs).
        fn new(hosts: &[(u64, f64, u64)], delay_us: u64) -> Self {
            Self {
                hosts: hosts
                    .iter()
                    .map(|&(id, tempo, skew)| Host {
                        s: LinkSession::new(id, tempo),
                        skew,
                        up: true,
                    })
                    .collect(),
                wire: Vec::new(),
                t: 0,
                next_tick: 0,
                delay_us,
                cut: Vec::new(),
            }
        }

        fn local(&self, i: usize) -> u64 {
            self.t + self.hosts[i].skew
        }

        fn clock(&self, i: usize) -> LinkClock {
            self.hosts[i].s.clock_at(self.local(i))
        }

        fn send(&mut self, from: usize, outs: Vec<Outgoing>) {
            for o in outs {
                for to in 0..self.hosts.len() {
                    let addressed = match o.to {
                        None => to != from,
                        Some(a) => addr(to) == a,
                    };
                    if addressed && !self.cut.contains(&(from, to)) {
                        self.wire.push(Packet {
                            due: self.t + self.delay_us,
                            to,
                            from,
                            bytes: o.bytes.clone(),
                        });
                    }
                }
            }
        }

        fn run(&mut self, us: u64) {
            let end = self.t + us;
            while self.t < end {
                let now = self.t;
                let (due, later): (Vec<Packet>, Vec<Packet>) = std::mem::take(&mut self.wire)
                    .into_iter()
                    .partition(|p| p.due <= now);
                self.wire = later;
                for p in due {
                    if self.hosts[p.to].up {
                        let local = self.local(p.to);
                        self.hosts[p.to]
                            .s
                            .on_datagram(&p.bytes, addr(p.from), local);
                    }
                }
                if self.t >= self.next_tick {
                    self.next_tick += 20_000;
                    for i in 0..self.hosts.len() {
                        if self.hosts[i].up {
                            let local = self.local(i);
                            let outs = self.hosts[i].s.tick(local);
                            self.send(i, outs);
                        }
                    }
                }
                self.t += 1_000;
            }
        }

        /// Largest beat difference between two running hosts right now, as time at `bpm`.
        fn spread_ms(&self, bpm: f64) -> f64 {
            let beats: Vec<f64> = (0..self.hosts.len())
                .filter(|&i| self.hosts[i].up)
                .map(|i| self.clock(i).beat)
                .collect();
            let lo = beats.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = beats.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            ms(hi - lo, bpm)
        }

        fn leaders(&self) -> Vec<usize> {
            (0..self.hosts.len())
                .filter(|&i| self.hosts[i].up && self.clock(i).leader)
                .collect()
        }
    }

    fn beacon_from(id: u64, session_id: u64, tempo: f64, beat: f64, t: u64) -> Vec<u8> {
        beacon_with(id, session_id, tempo, beat, t, true)
    }

    /// A beacon of peer `id` in `session_id`; `leads` = it says it holds the timeline.
    fn beacon_with(
        id: u64,
        session_id: u64,
        tempo: f64,
        beat: f64,
        t: u64,
        leads: bool,
    ) -> Vec<u8> {
        Datagram {
            key: 0,
            peer_id: id,
            body: Body::Beacon(Beacon {
                session_id,
                newborn: false,
                leads,
                tempo_locked: false,
                tempo,
                beat,
                t_origin: t,
                t_send: t,
                reply_port: 0,
                members: 1,
            }),
        }
        .encode()
    }

    // (1) peers that start together pick the same leader: the lowest id, whatever order the
    // ids come in (its session is the one the others join, and it never joined anybody).
    #[test]
    fn peers_agree_on_the_leader() {
        for ids in [[30u64, 10, 20], [10, 20, 30], [20, 30, 10]] {
            let mut net = Net::new(
                &[
                    (ids[0], 120.0, 0),
                    (ids[1], 128.0, 5_000_000),
                    (ids[2], 140.0, 77_000),
                ],
                2_000,
            );
            net.run(1_500_000);
            let low = ids.iter().position(|&id| id == 10).unwrap();
            assert_eq!(net.leaders(), vec![low], "ids {ids:?}");
            for i in 0..3 {
                assert_eq!(net.hosts[i].s.session_id(), 10, "host {i} of {ids:?}");
                assert_eq!(net.clock(i).peers, 2, "host {i} of {ids:?}");
                assert!(
                    net.hosts[i].s.is_locked(net.local(i)),
                    "host {i} of {ids:?}"
                );
            }
            // One tempo for all (the tempo of the session that stayed), one beat.
            let bpm = net.clock(low).bpm;
            assert_eq!(bpm, [120.0, 128.0, 140.0][low]);
            assert!((0..3).all(|i| net.clock(i).bpm == bpm), "ids {ids:?}");
            assert!(net.spread_ms(bpm) < 1.0, "spread {} ms", net.spread_ms(bpm));
        }
    }

    // (2) the follower's beat is the leader's within 1 ms after 1 s of exchange, with a 20 ms
    // one-way delay and clocks 1 000 000 µs apart, at 128 BPM.
    #[test]
    fn follower_beat_matches_leader_within_1ms_across_delay_and_clock_offset() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 120.0, 1_000_000)], 20_000);
        net.run(1_000_000);
        let (a, b) = (net.clock(0), net.clock(1));
        assert!(
            a.leader && !b.leader,
            "leader flags {} {}",
            a.leader,
            b.leader
        );
        assert_eq!((a.peers, b.peers), (1, 1));
        assert_eq!(b.bpm, 128.0, "the follower takes the session tempo");
        // Leader clock minus follower clock.
        assert!(
            (b.offset_us + 1_000_000).abs() <= 1,
            "offset {}",
            b.offset_us
        );
        assert_eq!(a.offset_us, 0);
        let err_ms = ms(a.beat - b.beat, 128.0);
        assert!(
            err_ms < 1.0,
            "beat error {err_ms} ms (leader {} follower {})",
            a.beat,
            b.beat
        );
        // The leader has run for one second at 128 BPM from beat 0.
        assert!(
            (a.beat - 128.0 / 60.0).abs() < 1e-6,
            "leader beat {}",
            a.beat
        );
        assert!((b.phase_in_quantum - b.beat.rem_euclid(4.0)).abs() < 1e-12);
        assert!(net.hosts[1].s.is_locked(net.local(1)));
        assert!(net.hosts[0].s.is_locked(net.local(0)));
        // It stays there: no drift over the next ten seconds.
        net.run(10_000_000);
        assert!(
            net.spread_ms(128.0) < 1.0,
            "spread {} ms",
            net.spread_ms(128.0)
        );
    }

    // Of the samples kept, the one with the shortest round trip decides the offset.
    #[test]
    fn the_sample_with_the_shortest_round_trip_wins() {
        const OFFSET: i64 = -250_000; // leader clock minus ours
        let leader = addr(0);
        let mut s = LinkSession::new(2, 128.0);
        let mut now = 1_000_000u64;
        // One exchange with the given one-way delays; returns the offset the session reports.
        let mut exchange = |s: &mut LinkSession, out_us: u64, back_us: u64| {
            now += 1_000_000;
            let there = (now as i64 + OFFSET) as u64;
            s.on_datagram(&beacon_from(1, 1, 128.0, 0.0, there), leader, now);
            let ping = s
                .tick(now)
                .into_iter()
                .filter(|o| o.to == Some(leader))
                .find_map(|o| match Datagram::decode(&o.bytes).unwrap().body {
                    Body::Ping { seq, t_send } => Some((seq, t_send)),
                    _ => None,
                })
                .expect("a ping to the leader every second");
            let arrived = there + out_us;
            let pong = Datagram {
                key: 0,
                peer_id: 1,
                body: Body::Pong {
                    seq: ping.0,
                    t_send: ping.1,
                    t_recv: arrived,
                    t_reply: arrived,
                },
            };
            s.on_datagram(&pong.encode(), leader, now + out_us + back_us);
            s.clock_at(now + out_us + back_us).offset_us
        };
        // Asymmetric paths bend the estimate by half the asymmetry.
        assert_eq!(exchange(&mut s, 30_000, 2_000), OFFSET + 14_000);
        // A faster exchange replaces it as the best one, a slower one does not.
        assert_eq!(exchange(&mut s, 2_000, 12_000), OFFSET - 5_000);
        assert_eq!(exchange(&mut s, 40_000, 1_000), OFFSET - 5_000);
        // A symmetric, short exchange is exact and stays the best through worse ones.
        assert_eq!(exchange(&mut s, 1_000, 1_000), OFFSET);
        for _ in 0..7 {
            assert_eq!(exchange(&mut s, 9_000, 3_000), OFFSET);
        }
        // The eighth later sample pushes it out of the eight kept: the best of the rest wins.
        assert_eq!(exchange(&mut s, 9_000, 3_000), OFFSET + 3_000);
        assert_eq!(s.peers(now)[0].rtt_us, Some(12_000));
    }

    // (3) a tempo asked by a follower reaches everybody through the leader, without a jump.
    #[test]
    fn tempo_change_by_a_follower_propagates() {
        let mut net = Net::new(
            &[(1, 128.0, 0), (2, 128.0, 40_000), (3, 128.0, 9_000_000)],
            3_000,
        );
        net.run(1_500_000);
        assert_eq!(net.leaders(), vec![0]);
        let before = net.clock(0).beat;
        let now = net.local(2);
        assert!(net.hosts[2].s.set_tempo(140.0, now));
        assert_eq!(
            net.clock(2).bpm,
            128.0,
            "a follower does not change it alone"
        );
        net.run(600_000);
        for i in 0..3 {
            assert_eq!(net.clock(i).bpm, 140.0, "host {i}");
        }
        assert_eq!(net.hosts[0].s.take_tempo_request(), Some(140.0));
        assert_eq!(net.hosts[0].s.take_tempo_request(), None, "reported once");
        assert_eq!(
            net.hosts[1].s.take_tempo_request(),
            None,
            "only the leader adopts"
        );
        assert!(
            net.spread_ms(140.0) < 1.0,
            "spread {} ms",
            net.spread_ms(140.0)
        );
        // 0.6 s passed: between 0.6 s at 128 and 0.6 s at 140, no jump back, no bar skipped.
        let moved = net.clock(0).beat - before;
        assert!(
            (1.28 - 1e-9..=1.4 + 1e-9).contains(&moved),
            "moved {moved} beats"
        );
        // The leader changing it needs no round trip.
        let now = net.local(0);
        assert!(net.hosts[0].s.set_tempo(90.0, now));
        assert_eq!(net.clock(0).bpm, 90.0);
        net.run(400_000);
        assert!((0..3).all(|i| net.clock(i).bpm == 90.0));
        assert!(net.spread_ms(90.0) < 1.0);
    }

    // (4) when the leader goes silent the next lowest id leads after the 3 s timeout, on the
    // same timeline; a Bye does it at once.
    #[test]
    fn peer_expiry_makes_the_remaining_peer_leader() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 100.0, 3_000_000)], 2_000);
        net.run(1_000_000);
        assert_eq!(net.leaders(), vec![0]);
        let (beat, t) = (net.clock(1).beat, net.t);
        // The last beacon of the leader left at 0.8 s and arrived 2 ms later.
        net.hosts[0].up = false;
        net.run(2_700_000);
        assert!(!net.clock(1).leader, "3.7 s: still within the timeout");
        assert_eq!(net.clock(1).peers, 1);
        net.run(200_000);
        let c = net.clock(1);
        assert!(c.leader, "3.9 s: the remaining peer leads");
        assert_eq!((c.peers, c.offset_us), (0, 0));
        assert!(!net.hosts[1].s.is_locked(net.local(1)));
        // Same timeline: the beat kept advancing at the session tempo.
        let want = beat + (net.t - t) as f64 * 128.0 / 60e6;
        assert!((c.beat - want).abs() < 1e-6, "beat {} want {want}", c.beat);
        assert_eq!(c.bpm, 128.0);
        // It goes on under another session id (see the test of the returning leader).
        assert_ne!(net.hosts[1].s.session_id(), 1);

        // Bye: no waiting.
        let mut net = Net::new(&[(1, 128.0, 0), (2, 100.0, 3_000_000), (3, 90.0, 0)], 2_000);
        net.run(1_000_000);
        let bye = net.hosts[0].s.leave();
        net.send(0, bye);
        net.hosts[0].up = false;
        net.run(100_000);
        assert_eq!(net.leaders(), vec![1]);
        assert_eq!(net.clock(1).peers, 1);
        assert_eq!(net.clock(2).peers, 1);
        assert!(net.spread_ms(128.0) < 1.0);
        // A leader that said goodbye is gone for good: the session keeps its id.
        assert_eq!(net.hosts[1].s.session_id(), 1);
        assert_eq!(net.hosts[2].s.session_id(), 1);
    }

    // (5) a NaN or out-of-range tempo is ignored at every entry point.
    #[test]
    fn nan_and_out_of_range_tempo_is_ignored() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 500_000)], 2_000);
        net.run(1_000_000);
        let bad = [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            0.0,
            -128.0,
            19.99,
            300.01,
            1e12,
        ];
        for bpm in bad {
            for i in 0..2 {
                let now = net.local(i);
                let beat = net.clock(i).beat;
                assert!(
                    !net.hosts[i].s.set_tempo(bpm, now),
                    "set_tempo({bpm}), host {i}"
                );
                assert!(
                    !net.hosts[i].s.set_local_clock(bpm, 8.0, now),
                    "set_local_clock({bpm}), host {i}"
                );
                assert_eq!(net.clock(i).bpm, 128.0);
                assert_eq!(net.clock(i).beat, beat);
            }
            // From the network: a beacon of the leader and a proposal of the follower that
            // carry it are dropped whole.
            let session = net.hosts[0].s.session_id();
            let malformed = net.hosts[1].s.stats().malformed;
            let (there, here) = (net.local(0), net.local(1));
            let forged = beacon_from(1, session, bpm, 0.0, there);
            net.hosts[1].s.on_datagram(&forged, addr(0), here);
            assert_eq!(net.hosts[1].s.stats().malformed, malformed + 1, "{bpm}");
            let proposal = Datagram {
                key: 0,
                peer_id: 2,
                body: Body::SetTempo {
                    session_id: session,
                    bpm,
                    at_beat: 0.0,
                },
            };
            net.hosts[0]
                .s
                .on_datagram(&proposal.encode(), addr(1), there);
            assert_eq!(net.hosts[0].s.take_tempo_request(), None);
            net.run(300_000);
            assert!((0..2).all(|i| net.clock(i).bpm == 128.0), "{bpm}");
            assert!(net.spread_ms(128.0) < 1.0, "{bpm}");
        }
        // The same path with a valid tempo does change it (the checks above are not vacuous).
        let now = net.local(1);
        assert!(net.hosts[1].s.set_tempo(132.0, now));
        net.run(600_000);
        assert!((0..2).all(|i| net.clock(i).bpm == 132.0));
        // A beat that is not a number is refused too; only the leader's clock is taken.
        let now = net.local(0);
        assert!(!net.hosts[0].s.set_local_clock(128.0, f64::NAN, now));
        assert!(!net.hosts[0].s.set_local_clock(128.0, 2e9, now));
        assert!(net.hosts[0].s.set_local_clock(126.0, 16.5, now));
        let now = net.local(1);
        assert!(!net.hosts[1].s.set_local_clock(126.0, 16.5, now));
        // A session created with a bad tempo starts at 128.
        assert_eq!(LinkSession::new(1, f64::NAN).clock_at(0).bpm, 128.0);
        assert_eq!(LinkSession::new(1, 1000.0).clock_at(0).bpm, 128.0);
    }

    fn xorshift(state: &mut u64) -> u64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        *state
    }

    // (6) random bytes and damaged real datagrams never panic and never break the clock.
    #[test]
    fn datagram_fuzz_never_panics() {
        let mut net = Net::new(&[(5, 128.0, 0), (9, 128.0, 123_456)], 1_000);
        net.run(600_000);
        // Real traffic to damage: everything host 1 sends for a while, then its goodbye.
        let mut real: Vec<Vec<u8>> = Vec::new();
        for step in 0..140u64 {
            let now = net.local(1) + step * 20_000;
            real.extend(net.hosts[1].s.tick(now).into_iter().map(|o| o.bytes));
        }
        real.extend(net.hosts[1].s.leave().into_iter().map(|o| o.bytes));
        assert!(real.len() > 20, "{} real datagrams", real.len());

        let mut rng = 0x9e37_79b9_7f4a_7c15u64;
        let mut target = LinkSession::new(5, 128.0);
        let mut now = 1_000u64;
        for round in 0..120_000u32 {
            let r = xorshift(&mut rng);
            let pick = (r >> 32) as usize % real.len();
            let bytes: Vec<u8> = match round % 4 {
                // Pure noise of any length up to past the maximum.
                0 => (0..r % 90).map(|_| xorshift(&mut rng) as u8).collect(),
                // Noise behind a valid magic, version, kind and open key, at a real length.
                1 => {
                    let len = [64usize, 32, 48, 44, 28][(r >> 8) as usize % 5];
                    let mut b: Vec<u8> = (0..len).map(|_| xorshift(&mut rng) as u8).collect();
                    b[..4].copy_from_slice(b"MXLK");
                    b[4] = 1;
                    b[5] = (r % 7) as u8;
                    b[8..12].fill(0);
                    b
                }
                // A real datagram with a few bytes of its body changed.
                2 => {
                    let mut b = real[pick].clone();
                    for _ in 0..1 + (r >> 20) % 4 {
                        let at = 20 + xorshift(&mut rng) as usize % (b.len() - 20);
                        b[at] = xorshift(&mut rng) as u8;
                    }
                    b
                }
                // A real datagram cut short or padded.
                _ => {
                    let mut b = real[pick].clone();
                    b.resize((r >> 16) as usize % 80, 0xAA);
                    b
                }
            };
            // Time itself is hostile now and then: the far future, zero, going backwards.
            now = match r >> 60 {
                0 => u64::MAX,
                1 => 0,
                2 => now / 2,
                _ => now.wrapping_add(r % 50_000),
            };
            let ip = Ipv4Addr::from((r >> 24) as u32);
            target.on_datagram(
                &bytes,
                SocketAddr::new(IpAddr::V4(ip), (r >> 4) as u16),
                now,
            );
            if round & 15 == 0 {
                for o in target.tick(now) {
                    assert!(o.bytes.len() <= crate::wire::MAX_DATAGRAM);
                }
                let c = target.clock_at(now);
                assert!(
                    (20.0..=300.0).contains(&c.bpm),
                    "bpm {} in round {round}",
                    c.bpm
                );
                assert!(c.beat.is_finite(), "beat {} in round {round}", c.beat);
                assert!((0.0..=4.0).contains(&c.phase_in_quantum));
                assert!(c.peers <= MAX_PEERS);
                let _ = target.is_locked(now);
                let _ = target.peers(now);
                let _ = target.set_local_clock(c.bpm, c.beat, now);
                target.set_tempo_locked(round & 32 == 0);
                let _ = target.set_tempo(c.bpm, now);
                let _ = target.nudge(0.25, now);
                assert!((-2.0..2.0).contains(&target.nudge_beats()));
            }
        }
        let st = target.stats();
        assert!(st.malformed > 60_000, "malformed {}", st.malformed);
        // The fuzz must also reach the state machine, not only the parser.
        assert!(st.accepted > 100, "accepted {}", st.accepted);
    }

    // A late joiner never moves the session beat and never takes the lead from the peer that
    // has it, whatever its id. It takes over only when that peer leaves, on the same timeline.
    #[test]
    fn a_joiner_with_the_lowest_id_follows_until_the_leader_leaves() {
        let mut net = Net::new(
            &[(50, 128.0, 0), (60, 128.0, 2_000_000), (7, 90.0, 400_000)],
            5_000,
        );
        net.hosts[2].up = false;
        net.run(4_000_000);
        assert_eq!(net.leaders(), vec![0]);
        let (beat, t) = (net.clock(0).beat, net.t);
        // Host 2 (lowest id, its own tempo, beat 0) starts now.
        net.hosts[2].up = true;
        let mut joined_at = None;
        for step in 0..150 {
            net.run(10_000);
            let want = beat + (net.t - t) as f64 * 128.0 / 60e6;
            for i in 0..2 {
                let c = net.clock(i);
                assert!(
                    ms(c.beat - want, 128.0) < 1.0,
                    "host {i} moved to {}, want {want}, step {step}",
                    c.beat
                );
                assert_eq!(c.bpm, 128.0, "host {i}, step {step}");
            }
            assert!(net.clock(0).leader, "the founder leads, step {step}");
            let joiner = net.clock(2);
            if joiner.peers > 0 {
                // In the shared session it holds the session beat, and it does not lead.
                assert!(ms(joiner.beat - want, 128.0) < 1.0, "step {step}");
                assert!(!joiner.leader, "the joiner leads at step {step}");
                if joined_at.is_none() {
                    joined_at = Some(net.t - t);
                }
            }
        }
        let joined_at = joined_at.expect("the joiner is in the session in the end");
        assert!(joined_at < 500_000, "joined after {joined_at} µs");
        assert_eq!(net.leaders(), vec![0]);
        assert_eq!(net.clock(2).bpm, 128.0);
        assert_eq!(net.clock(2).peers, 2);
        assert!(net.hosts[2].s.is_locked(net.local(2)));
        assert!(
            net.spread_ms(128.0) < 1.0,
            "spread {} ms",
            net.spread_ms(128.0)
        );

        // The leader leaves: the lowest id of those left takes over, and nobody's beat moves.
        let (beat, t) = (net.clock(1).beat, net.t);
        let bye = net.hosts[0].s.leave();
        net.send(0, bye);
        net.hosts[0].up = false;
        for step in 0..60 {
            net.run(10_000);
            let want = beat + (net.t - t) as f64 * 128.0 / 60e6;
            for i in 1..3 {
                let c = net.clock(i);
                assert!(
                    ms(c.beat - want, 128.0) < 1.0,
                    "host {i} moved to {}, want {want}, step {step} after the leader left",
                    c.beat
                );
            }
        }
        assert_eq!(net.leaders(), vec![2]);
        assert_eq!((net.clock(1).peers, net.clock(2).peers), (1, 1));
    }

    // Two members that both say they lead (two sessions merged in an unusual order): the
    // lower id stays, the other one follows it.
    #[test]
    fn when_two_members_say_they_lead_the_lower_id_stays() {
        let mut low = LinkSession::new(5, 128.0);
        low.tick(1_000);
        low.on_datagram(&beacon_with(9, 5, 128.0, 0.0, 1_000, true), addr(1), 2_000);
        low.tick(2_000);
        assert_eq!(low.clock_at(2_000).peers, 1);
        assert!(
            low.clock_at(2_000).leader,
            "5 is below 9: it keeps the lead"
        );
        let mut high = LinkSession::new(9, 128.0);
        high.tick(1_000);
        high.on_datagram(&beacon_with(5, 9, 128.0, 0.0, 1_000, true), addr(0), 2_000);
        high.tick(2_000);
        assert_eq!(high.clock_at(2_000).peers, 1);
        assert!(!high.clock_at(2_000).leader, "9 gives way to 5");
        // A member with a lower id that does NOT say it leads does not displace us.
        let mut founder = LinkSession::new(50, 128.0);
        founder.tick(1_000);
        founder.on_datagram(
            &beacon_with(7, 50, 128.0, 0.0, 1_000, false),
            addr(2),
            2_000,
        );
        founder.tick(2_000);
        assert_eq!(founder.clock_at(2_000).peers, 1);
        assert!(founder.clock_at(2_000).leader);
    }

    // (P0-1) while the leader's clock is a playing deck the session tempo is that deck's: a
    // proposal of a follower and the leader's own set_tempo are refused, nothing is retimed,
    // and the followers know it from the beacons. Unlocked, the same proposal goes through.
    #[test]
    fn a_tempo_proposal_is_refused_while_the_leaders_clock_is_a_deck() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 40_000)], 3_000);
        net.run(1_500_000);
        assert_eq!(net.leaders(), vec![0]);
        assert!(!net.clock(0).tempo_locked && !net.clock(1).tempo_locked);
        net.hosts[0].s.set_tempo_locked(true);
        net.run(300_000);
        assert!(net.clock(0).tempo_locked, "the leader reports the lock");
        assert!(
            net.clock(1).tempo_locked,
            "the follower learns it from the beacons"
        );
        // The follower: refused at once, nothing sent, nothing adopted.
        let now = net.local(1);
        assert!(!net.hosts[1].s.set_tempo(140.0, now));
        net.run(600_000);
        assert!((0..2).all(|i| net.clock(i).bpm == 128.0));
        assert_eq!(net.hosts[0].s.take_tempo_request(), None);
        // A proposal that arrives on the wire anyway (a peer with an older view): refused.
        let there = net.local(0);
        let proposal = Datagram {
            key: 0,
            peer_id: 2,
            body: Body::SetTempo {
                session_id: net.hosts[0].s.session_id(),
                bpm: 140.0,
                at_beat: 0.0,
            },
        };
        let ignored = net.hosts[0].s.stats().ignored;
        net.hosts[0]
            .s
            .on_datagram(&proposal.encode(), addr(1), there);
        assert_eq!(net.hosts[0].s.stats().ignored, ignored + 1);
        assert_eq!(net.hosts[0].s.take_tempo_request(), None);
        assert_eq!(net.clock(0).bpm, 128.0);
        // The leader's own set_tempo: refused too (its deck's tempo rules).
        let now = net.local(0);
        assert!(!net.hosts[0].s.set_tempo(140.0, now));
        assert_eq!(net.clock(0).bpm, 128.0);
        net.run(300_000);
        assert!(net.spread_ms(128.0) < 1.0);
        // Unlocked (the deck stopped, the internal clock drives): the same proposal goes through.
        net.hosts[0].s.set_tempo_locked(false);
        net.run(300_000);
        assert!(!net.clock(1).tempo_locked);
        let now = net.local(1);
        assert!(net.hosts[1].s.set_tempo(140.0, now));
        net.run(600_000);
        assert!((0..2).all(|i| net.clock(i).bpm == 140.0));
        assert_eq!(net.hosts[0].s.take_tempo_request(), Some(140.0));
        // A follower's lock flag means nothing: only the peer that holds the timeline counts.
        net.hosts[1].s.set_tempo_locked(true);
        let now = net.local(0);
        assert!(net.hosts[0].s.set_tempo(120.0, now));
        net.run(400_000);
        assert!((0..2).all(|i| net.clock(i).bpm == 120.0));
        assert!(!net.clock(1).tempo_locked);
    }

    // (P1-3) the leader drops off the network for 5 s; the followers go on (and change the
    // tempo); when it comes back it joins THEIR timeline instead of dragging them to its own.
    #[test]
    fn a_leader_that_returns_after_a_drop_joins_the_survivors() {
        let mut net = Net::new(
            &[(1, 128.0, 0), (2, 128.0, 40_000), (3, 128.0, 9_000_000)],
            3_000,
        );
        net.run(1_500_000);
        assert_eq!(net.leaders(), vec![0]);
        let founded = net.hosts[1].s.session_id();
        assert_eq!(founded, 1);
        // Wi-Fi drop: nothing reaches host 0 and nothing leaves it; it keeps running.
        net.cut = vec![(0, 1), (0, 2), (1, 0), (2, 0)];
        net.run(5_000_000);
        assert_eq!(
            net.leaders(),
            vec![0, 1],
            "host 1 took over, host 0 is alone"
        );
        let refounded = net.hosts[1].s.session_id();
        assert_ne!(refounded, founded, "the survivors re-founded the session");
        assert_eq!(
            net.hosts[2].s.session_id(),
            refounded,
            "both survivors agree on the new id"
        );
        assert_eq!(
            net.hosts[0].s.session_id(),
            founded,
            "the old leader kept the old id"
        );
        assert_eq!((net.clock(1).peers, net.clock(2).peers), (1, 1));
        assert!(net.hosts[2].s.is_locked(net.local(2)));
        // The survivors change the tempo among themselves.
        let now = net.local(2);
        assert!(net.hosts[2].s.set_tempo(140.0, now));
        net.run(600_000);
        assert_eq!((net.clock(1).bpm, net.clock(2).bpm), (140.0, 140.0));
        assert_eq!(net.clock(0).bpm, 128.0);
        let (beat, t) = (net.clock(1).beat, net.t);
        // The network is back.
        net.cut.clear();
        for step in 0..200 {
            net.run(10_000);
            let want = beat + (net.t - t) as f64 * 140.0 / 60e6;
            for i in 1..3 {
                let c = net.clock(i);
                assert_eq!(c.bpm, 140.0, "survivor {i} changed tempo at step {step}");
                assert!(
                    ms(c.beat - want, 140.0) < 1.0,
                    "survivor {i} moved to {} (want {want}) at step {step}",
                    c.beat
                );
            }
        }
        let c = net.clock(0);
        assert_eq!(c.bpm, 140.0, "the old leader took the survivors' tempo");
        assert_eq!(c.peers, 2);
        assert_eq!(net.hosts[0].s.session_id(), refounded);
        assert!(
            net.spread_ms(140.0) < 1.0,
            "spread {} ms",
            net.spread_ms(140.0)
        );
        // It joined: the member that led the survivors keeps leading, whatever the ids.
        assert_eq!(net.leaders(), vec![1]);
        assert!(!c.leader);
    }

    // (P1-4) a peer that never answers a ping (a forged beacon) is pinged, and sent our
    // beacons, at the slow rate after ten unanswered pings; a real peer stays at the fast
    // rate until it has four samples.
    #[test]
    fn pings_back_off_for_a_peer_that_never_answers() {
        let ghost = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 9)), 42029);
        let mut s = LinkSession::new(5, 128.0);
        let mut sent: Vec<(u64, usize, usize)> = Vec::new(); // (second, pings, beacons)
        for step in 0..600u64 {
            let now = 1_000_000 + step * 20_000;
            // The ghost's beacons keep coming (five a second), it never answers.
            if step % 10 == 0 {
                s.on_datagram(&beacon_from(77, 77, 128.0, 0.0, now), ghost, now);
            }
            let (mut pings, mut beacons) = (0, 0);
            for o in s.tick(now) {
                if o.to != Some(ghost) {
                    continue;
                }
                match Datagram::decode(&o.bytes).unwrap().body {
                    Body::Ping { .. } => pings += 1,
                    Body::Beacon(_) => beacons += 1,
                    _ => {}
                }
            }
            let second = step / 50;
            match sent.last_mut() {
                Some(last) if last.0 == second => {
                    last.1 += pings;
                    last.2 += beacons;
                }
                _ => sent.push((second, pings, beacons)),
            }
        }
        assert_eq!(sent.len(), 12);
        // First two seconds: five pings and five unicast beacons a second (measuring).
        assert_eq!(sent[0].1, 5, "pings in second 0: {sent:?}");
        assert_eq!(sent[0].2, 5, "beacons in second 0: {sent:?}");
        // From the third second on: one ping and one beacon a second.
        for &(sec, pings, beacons) in &sent[3..] {
            assert_eq!(pings, 1, "pings in second {sec}: {sent:?}");
            assert_eq!(beacons, 1, "beacons in second {sec}: {sent:?}");
        }
        let total: usize = sent.iter().map(|x| x.1 + x.2).sum();
        assert!(
            total < 45,
            "{total} datagrams to the ghost in 12 s: {sent:?}"
        );
        // A peer that answers is never treated as quiet: it is measured within a moment.
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 0)], 1_000);
        net.run(300_000);
        assert!(net.hosts[1].s.is_locked(net.local(1)));
        // A quiet peer that starts to answer is measured at the fast rate again (a member of
        // our own session here, which we lead).
        let mut s = LinkSession::new(5, 128.0);
        let real = addr(3);
        let mut now = 1_000_000u64;
        for _ in 0..150 {
            now += 20_000;
            s.on_datagram(&beacon_with(9, 5, 128.0, 0.0, now, false), real, now);
            let _ = s.tick(now);
        }
        assert!(!s.is_locked(now), "no answer yet: its clock is unknown");
        // Three seconds without an answer: slow. Now every ping is answered at once.
        let mut pings = 0;
        for _ in 0..100 {
            now += 20_000;
            s.on_datagram(&beacon_with(9, 5, 128.0, 0.0, now, false), real, now);
            for o in s.tick(now) {
                if let Ok(Body::Ping { seq, t_send }) = Datagram::decode(&o.bytes).map(|d| d.body) {
                    pings += 1;
                    let pong = Datagram {
                        key: 0,
                        peer_id: 9,
                        body: Body::Pong {
                            seq,
                            t_send,
                            t_recv: now,
                            t_reply: now,
                        },
                    };
                    s.on_datagram(&pong.encode(), real, now);
                }
            }
        }
        // Two seconds: four fast pings until four samples exist, then one a second.
        assert!(
            (4..=7).contains(&pings),
            "{pings} pings in 2 s after it answered"
        );
        assert!(s.is_locked(now));
    }

    // (P1-4) a full peer table: the oldest peer that never answered a ping makes room, so
    // forged ids cannot keep a real instance out; a measured peer is never dropped for one.
    #[test]
    fn forged_peers_do_not_lock_a_real_peer_out_of_a_full_table() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 0)], 1_000);
        net.run(1_000_000);
        assert!(net.hosts[0].s.is_locked(net.local(0)));
        // 40 forged peers in their own sessions, from one address, 20 ms apart, none answers
        // a ping. (All at once they would only fill the table: a peer younger than a ping
        // interval is never dropped, see the next test.)
        let forger = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 9, 9, 9)), 42029);
        for i in 0..40u64 {
            net.run(20_000);
            let now = net.local(0);
            net.hosts[0].s.on_datagram(
                &beacon_from(1000 + i, 1000 + i, 128.0, 0.0, now),
                forger,
                now,
            );
        }
        let peers = net.hosts[0].s.peers(net.local(0));
        assert_eq!(peers.len(), MAX_PEERS);
        assert!(peers.iter().any(|p| p.id == 2), "the real peer stayed");
        assert!(
            peers.iter().all(|p| p.id != 1000),
            "the oldest forged peer made room"
        );
        assert!(
            peers.iter().any(|p| p.id == 1039),
            "the newest forged peer is in"
        );
        // The real session is untouched.
        net.run(1_000_000);
        assert!(net.hosts[0].s.is_locked(net.local(0)));
        assert_eq!(net.clock(0).peers, 1);
        assert!(net.spread_ms(128.0) < 1.0);
        // A new REAL peer (host 3, started now) gets in despite the full table.
        net.hosts.push(Host {
            s: LinkSession::new(3, 128.0),
            skew: 0,
            up: true,
        });
        net.run(1_500_000);
        assert_eq!(net.clock(0).peers, 2, "{:?}", net.clock(0));
        assert_eq!(net.clock(2).peers, 2);
        assert!(net.hosts[2].s.is_locked(net.local(2)));
    }

    /// Ids of the peers in the table, sorted.
    fn table(s: &LinkSession, now: u64) -> Vec<u64> {
        let mut ids: Vec<u64> = s.peers(now).iter().map(|p| p.id).collect();
        ids.sort_unstable();
        ids
    }

    fn forged_addr(id: u64) -> SocketAddr {
        SocketAddr::new(
            IpAddr::V4(Ipv4Addr::new(10, 7, (id >> 8) as u8, id as u8)),
            42029,
        )
    }

    /// A beacon of the made-up peer `id` (alone in its own session) arrives at `now`.
    fn forge(s: &mut LinkSession, id: u64, now: u64) {
        s.on_datagram(&beacon_from(id, id, 128.0, 0.0, now), forged_addr(id), now);
    }

    // (P2) a full table of peers that are all younger than one ping interval: a newcomer is
    // refused and nobody is dropped. A forger that invents ids faster than one round trip
    // could otherwise push a real newcomer out before its first pong arrived.
    #[test]
    fn a_full_table_of_fresh_peers_refuses_a_newcomer_instead_of_evicting() {
        let mut s = LinkSession::new(5, 128.0);
        let t0 = 1_000_000u64;
        let _ = s.tick(t0);
        let first = 100u64;
        let ids: Vec<u64> = (first..first + MAX_PEERS as u64).collect();
        for (i, &id) in ids.iter().enumerate() {
            forge(&mut s, id, t0 + i as u64);
        }
        assert_eq!(table(&s, t0 + 100), ids);
        // One more id while the oldest peer is 1 µs short of a ping interval.
        let ignored = s.stats().ignored;
        let now = t0 + PING_FAST_US - 1;
        forge(&mut s, 900, now);
        assert_eq!(
            table(&s, now),
            ids,
            "nobody is dropped, the newcomer is not added"
        );
        assert_eq!(s.stats().ignored, ignored + 1, "counted as not used");
        // A whole burst of new ids changes nothing either.
        for id in 901..960 {
            forge(&mut s, id, now);
        }
        assert_eq!(table(&s, now), ids);
        // The moment the oldest one is a ping interval old (and still never answered), it
        // makes room; the ones that arrived a few microseconds after it stay.
        let now = t0 + PING_FAST_US;
        forge(&mut s, 990, now);
        let mut want: Vec<u64> = ids[1..].to_vec();
        want.push(990);
        assert_eq!(table(&s, now), want);
        // The newcomer that got in is itself protected for a ping interval, and the second
        // oldest is 1 µs short of it: the next id is refused again.
        forge(&mut s, 991, now);
        assert_eq!(table(&s, now), want);
    }

    // (P2) a full table with one old peer that never answered: that one goes, and only that
    // one. A measured peer never goes, however old; fresh ones are not touched.
    #[test]
    fn a_full_table_drops_only_the_old_peer_that_never_answered() {
        let mut s = LinkSession::new(5, 128.0);
        let t0 = 1_000_000u64;
        let _ = s.tick(t0);
        // Peer 50 answers a ping: its clock is measured.
        forge(&mut s, 50, t0);
        let ping = s
            .tick(t0)
            .into_iter()
            .find_map(|o| match Datagram::decode(&o.bytes).unwrap().body {
                Body::Ping { seq, t_send } => Some((seq, t_send)),
                _ => None,
            })
            .expect("a new peer is pinged at once");
        let pong = Datagram {
            key: 0,
            peer_id: 50,
            body: Body::Pong {
                seq: ping.0,
                t_send: ping.1,
                t_recv: t0,
                t_reply: t0,
            },
        };
        s.on_datagram(&pong.encode(), forged_addr(50), t0 + 1_000);
        assert!(s.peers(t0 + 1_000)[0].offset_us.is_some(), "50 is measured");
        // Peer 60 never answers. Both are half a second old when the table fills up.
        forge(&mut s, 60, t0 + 2_000);
        let t1 = t0 + 500_000;
        let fresh: Vec<u64> = (100..100 + MAX_PEERS as u64 - 2).collect();
        for (i, &id) in fresh.iter().enumerate() {
            forge(&mut s, id, t1 + i as u64);
        }
        let mut full = vec![50, 60];
        full.extend(&fresh);
        assert_eq!(table(&s, t1 + 50), full);
        // A newcomer: the old peer that never answered makes room, nobody else.
        forge(&mut s, 900, t1 + 100);
        let mut want = vec![50];
        want.extend(&fresh);
        want.push(900);
        assert_eq!(table(&s, t1 + 100), want);
        // The next one: everybody left is measured or fresh. Refused.
        forge(&mut s, 901, t1 + 200);
        assert_eq!(table(&s, t1 + 200), want);
        // A ping interval after the fresh ones arrived, the oldest of THEM goes: never the
        // measured peer, although it is the oldest in the table.
        let now = t1 + PING_FAST_US + 50;
        forge(&mut s, 902, now);
        let mut want = vec![50];
        want.extend(&fresh[1..]);
        want.extend([900, 902]);
        assert_eq!(table(&s, now), want);
    }

    // Two sessions that have both run for a while: the larger one stays.
    #[test]
    fn the_larger_session_stays_when_two_sessions_meet() {
        let mut net = Net::new(
            &[
                (40, 120.0, 0),
                (41, 120.0, 10_000),
                (42, 120.0, 20_000),
                (3, 150.0, 30_000),
            ],
            2_000,
        );
        // Host 3 and the others cannot hear each other for the first five seconds.
        net.cut = (0..3).flat_map(|i| [(i, 3), (3, i)]).collect();
        net.run(5_000_000);
        assert_eq!(net.clock(0).peers, 2);
        assert_eq!(net.clock(3).peers, 0);
        assert!(net.clock(3).leader);
        let (beat, t) = (net.clock(0).beat, net.t);
        net.cut.clear();
        net.run(2_000_000);
        let want = beat + (net.t - t) as f64 * 120.0 / 60e6;
        for i in 0..4 {
            let c = net.clock(i);
            assert_eq!(c.bpm, 120.0, "host {i}");
            assert_eq!(c.peers, 3, "host {i}");
            assert!(
                ms(c.beat - want, 120.0) < 1.0,
                "host {i} beat {} want {want}",
                c.beat
            );
        }
        // The lone peer has the lowest id, but it joined: the leader of the session that
        // stayed keeps leading.
        assert_eq!(net.leaders(), vec![0]);
    }

    #[test]
    fn another_key_is_ignored() {
        let mut sessions = [
            LinkSession::with_key(1, 128.0, 111),
            LinkSession::with_key(2, 128.0, 222),
            LinkSession::new(3, 128.0),
        ];
        for step in 0..100u64 {
            let now = step * 20_000;
            for from in 0..3 {
                for o in sessions[from].tick(now) {
                    for to in (0..3).filter(|&to| to != from) {
                        sessions[to].on_datagram(&o.bytes, addr(from), now);
                    }
                }
            }
        }
        for s in &sessions {
            let clock = s.clock_at(2_000_000);
            assert_eq!(clock.peers, 0);
            assert!(clock.leader);
            assert!(s.peers(2_000_000).is_empty());
            assert!(
                s.stats().other_key >= 15,
                "other_key {}",
                s.stats().other_key
            );
            assert_eq!(s.stats().accepted, 0);
        }
        // The same three with one key do meet.
        let mut sessions = [1, 2, 3].map(|id| LinkSession::with_key(id, 128.0, 111));
        for step in 0..100u64 {
            let now = step * 20_000;
            for from in 0..3 {
                for o in sessions[from].tick(now) {
                    for to in (0..3).filter(|&to| o.to.is_none_or(|a| a == addr(to)) && to != from)
                    {
                        sessions[to].on_datagram(&o.bytes, addr(from), now);
                    }
                }
            }
        }
        assert!(sessions.iter().all(|s| s.clock_at(2_000_000).peers == 2));
    }

    #[test]
    fn the_leader_takes_the_phase_of_its_engine_and_nudge_is_a_followers_control() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 70_000)], 2_000);
        net.run(1_000_000);
        // The leader's engine is on beat 100.25 of a track: the session keeps its beat count
        // (about 2.13) to the nearest bar and takes the phase 0.25.
        let now = net.local(0);
        let before = net.clock(0).beat;
        assert!(net.hosts[0].s.set_local_clock(126.0, 100.25, now));
        let a = net.clock(0);
        assert_eq!(a.bpm, 126.0);
        assert!(
            (a.phase_in_quantum - 0.25).abs() < 1e-9,
            "phase {}",
            a.phase_in_quantum
        );
        assert!(
            (a.beat - before).abs() <= 2.0,
            "beat went from {before} to {}",
            a.beat
        );
        net.run(500_000);
        assert_eq!(net.clock(1).bpm, 126.0);
        assert!(net.spread_ms(126.0) < 1.0);

        // Nudge: this peer runs a quarter beat ahead of the session; the other does not move.
        let other = net.clock(0).beat;
        let now = net.local(1);
        assert!(net.hosts[1].s.nudge(0.25, now));
        assert!(ms(net.clock(1).beat - other - 0.25, 126.0) < 1.0);
        assert_eq!(net.clock(0).beat, other);
        net.run(500_000);
        assert!(ms(net.clock(1).beat - net.clock(0).beat - 0.25, 126.0) < 1.0);
        // On the leader nudge is refused: its clock IS the session, so a shift there would
        // move every follower the other way. Nothing changes anywhere.
        let leader_beat = net.clock(0).beat;
        let now = net.local(0);
        assert!(!net.hosts[0].s.nudge(-0.5, now));
        assert!(!net.hosts[0].s.nudge(0.25, now));
        assert_eq!(net.hosts[0].s.nudge_beats(), 0.0);
        assert_eq!(net.clock(0).beat, leader_beat);
        // What the leader reports is the beat its engine fed, and the follower stays where it
        // was against it.
        let now = net.local(0);
        assert!(net.hosts[0].s.set_local_clock(126.0, 8.0, now));
        assert!(net.clock(0).phase_in_quantum.abs() < 1e-9);
        net.run(500_000);
        let d = (net.clock(1).beat - net.clock(0).beat).rem_euclid(4.0);
        assert!(ms(d - 0.25, 126.0) < 1.0, "difference {d}");
        // Limits.
        let now = net.local(1);
        let s = &mut net.hosts[1].s;
        assert!(!s.nudge(f64::NAN, now) && !s.nudge(4.5, now) && !s.nudge(f64::INFINITY, now));
        for _ in 0..40 {
            assert!(s.nudge(0.25, now));
            assert!(
                (-2.0..2.0).contains(&s.nudge_beats()),
                "nudge {}",
                s.nudge_beats()
            );
        }
        // Alone in its session a peer holds the timeline too: nothing to shift against.
        let mut alone = LinkSession::new(4, 128.0);
        alone.tick(1_000);
        assert!(!alone.nudge(0.25, 2_000));
    }

    // A follower that takes over keeps the shift it had: its own clock and everybody else's
    // go on without a jump, and from then on it cannot change the shift.
    #[test]
    fn a_nudged_follower_that_takes_over_moves_nobody() {
        let mut net = Net::new(
            &[(1, 128.0, 0), (2, 128.0, 70_000), (3, 128.0, 5_000_000)],
            2_000,
        );
        net.run(1_500_000);
        let now = net.local(1);
        assert!(net.hosts[1].s.nudge(0.25, now));
        net.run(300_000);
        let (b1, b2, t) = (net.clock(1).beat, net.clock(2).beat, net.t);
        assert!(ms(b1 - b2 - 0.25, 128.0) < 1.0);
        let bye = net.hosts[0].s.leave();
        net.send(0, bye);
        net.hosts[0].up = false;
        for step in 0..100 {
            net.run(10_000);
            let moved = (net.t - t) as f64 * 128.0 / 60e6;
            assert!(
                ms(net.clock(1).beat - b1 - moved, 128.0) < 1.0,
                "the new leader jumped at step {step}"
            );
            assert!(
                ms(net.clock(2).beat - b2 - moved, 128.0) < 1.0,
                "the follower jumped at step {step}"
            );
            // The new leader's engine plays what the session reported to it: feeding that
            // back (as the app does while it leads) must not move the session either.
            if net.clock(1).leader {
                let (now, own) = (net.local(1), net.clock(1));
                assert!(net.hosts[1].s.set_local_clock(own.bpm, own.beat, now));
            }
        }
        assert_eq!(net.leaders(), vec![1]);
        assert_eq!(net.hosts[1].s.nudge_beats(), 0.25);
        let now = net.local(1);
        assert!(!net.hosts[1].s.nudge(-0.25, now), "a leader cannot nudge");
        assert_eq!(net.hosts[1].s.nudge_beats(), 0.25);
    }

    // The leader's engine clock arrives with callback jitter: the session must not shake.
    #[test]
    fn jitter_of_the_fed_clock_is_smoothed_and_drift_is_followed() {
        let mut s = LinkSession::new(1, 128.0);
        let start = 10_000_000u64;
        s.tick(start);
        let engine = |t: u64, shift_us: f64| 40.0 + ((t - start) as f64 + shift_us) * 128.0 / 60e6;
        assert!(s.set_local_clock(128.0, engine(start, 0.0), start));
        let mut worst = 0.0f64;
        let mut late = false;
        for step in 1..=100u64 {
            let t = start + step * 50_000;
            // ±3 ms of jitter on the sample, alternating.
            late = !late;
            let jitter = if late { 3_000.0 } else { -3_000.0 };
            assert!(s.set_local_clock(128.0, engine(t, jitter), t));
            let err = (s.clock_at(t).beat - engine(t, 0.0)).rem_euclid(4.0);
            worst = worst.max(ms(err.min(4.0 - err), 128.0));
        }
        assert!(
            worst < 1.0,
            "session shook by {worst} ms under ±3 ms of jitter"
        );
        // The engine runs 10 ms ahead from now on (slow drift): the session gets there.
        for step in 101..=160u64 {
            let t = start + step * 50_000;
            assert!(s.set_local_clock(128.0, engine(t, 10_000.0), t));
        }
        let t = start + 160 * 50_000;
        let err = (s.clock_at(t).beat - engine(t, 10_000.0)).rem_euclid(4.0);
        assert!(ms(err.min(4.0 - err), 128.0) < 0.5, "drift not followed");
        // A seek (half a beat = 234 ms) is taken at once.
        let t = t + 50_000;
        assert!(s.set_local_clock(128.0, engine(t, 10_000.0) + 0.5, t));
        let err = (s.clock_at(t).beat - engine(t, 10_000.0) - 0.5).rem_euclid(4.0);
        assert!(err.min(4.0 - err) < 1e-9);
    }

    #[test]
    fn a_single_session_leads_alone_and_beacons_five_times_a_second() {
        let mut s = LinkSession::new(77, 128.0);
        s.set_reply_port(4242);
        let mut beacons = 0;
        for step in 0..=100u64 {
            let now = 5_000_000 + step * 20_000;
            for o in s.tick(now) {
                assert_eq!(o.to, None, "alone: only group beacons");
                let d = Datagram::decode(&o.bytes).expect("own beacon decodes");
                let Body::Beacon(b) = d.body else {
                    panic!("not a beacon")
                };
                assert_eq!((d.peer_id, b.session_id, b.members), (77, 77, 1));
                assert_eq!(b.newborn, step * 20_000 < NEWBORN_US);
                assert!(
                    b.leads && !b.tempo_locked,
                    "alone: it holds its own timeline"
                );
                assert_eq!((b.t_origin, b.t_send, b.reply_port), (now, now, 4242));
                beacons += 1;
            }
        }
        assert_eq!(beacons, 11, "2 s at 5 Hz, both ends included");
        let c = s.clock_at(7_000_000);
        assert!(c.leader);
        assert_eq!((c.peers, c.offset_us, c.bpm), (0, 0, 128.0));
        // The beat counts from the first tick, not from the zero of the clock.
        assert!(
            (c.beat - 128.0 / 60.0 * 2.0).abs() < 1e-9,
            "beat {}",
            c.beat
        );
        assert!(!s.is_locked(7_000_000));
        assert!(s.leave().iter().all(|o| o.to.is_none()));
    }

    #[test]
    fn answers_go_to_the_port_a_beacon_names() {
        let mut s = LinkSession::new(5, 128.0);
        let from = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 9)), 50_123);
        let mut beacon = Datagram::decode(&beacon_from(9, 9, 128.0, 0.0, 1_000)).unwrap();
        if let Body::Beacon(b) = &mut beacon.body {
            b.reply_port = 42029;
        }
        s.on_datagram(&beacon.encode(), from, 1_000);
        let want = SocketAddr::new(from.ip(), 42029);
        assert_eq!(s.peers(1_000)[0].addr, want);
        let outs = s.tick(1_000);
        assert!(outs.iter().any(|o| o.to == Some(want)));
        assert!(outs.iter().all(|o| o.to != Some(from)));
        // A ping from the peer's other socket is answered at the named port too.
        let ping = Datagram {
            key: 0,
            peer_id: 9,
            body: Body::Ping {
                seq: 1,
                t_send: 2_000,
            },
        };
        s.on_datagram(&ping.encode(), from, 2_000);
        let pongs: Vec<Outgoing> = s
            .tick(2_000)
            .into_iter()
            .filter(|o| {
                matches!(
                    Datagram::decode(&o.bytes).map(|d| d.body),
                    Ok(Body::Pong { .. })
                )
            })
            .collect();
        assert_eq!(pongs.len(), 1);
        assert_eq!(pongs[0].to, Some(want));
        // A ping from somebody we never heard a beacon of gets no answer.
        let stranger = Datagram {
            peer_id: 1234,
            ..ping
        };
        s.on_datagram(&stranger.encode(), from, 3_000);
        assert!(s.tick(3_000).iter().all(|o| {
            !matches!(
                Datagram::decode(&o.bytes).map(|d| d.body),
                Ok(Body::Pong { .. })
            )
        }));
    }

    #[test]
    fn stale_samples_stop_counting_and_only_real_pongs_are_used() {
        let mut net = Net::new(&[(1, 128.0, 0), (2, 128.0, 900_000)], 1_000);
        net.run(1_000_000);
        assert!(net.hosts[1].s.is_locked(net.local(1)));
        // A pong nobody asked for does not become a sample.
        let forged = Datagram {
            key: 0,
            peer_id: 1,
            body: Body::Pong {
                seq: 0xdead_beef,
                t_send: net.local(1) - 10,
                t_recv: 5,
                t_reply: 6,
            },
        };
        let (now, offset) = (net.local(1), net.clock(1).offset_us);
        let ignored = net.hosts[1].s.stats().ignored;
        net.hosts[1].s.on_datagram(&forged.encode(), addr(0), now);
        assert_eq!(net.clock(1).offset_us, offset);
        assert_eq!(net.hosts[1].s.stats().ignored, ignored + 1);
        // Beacons keep arriving but pongs do not: after 10 s the old samples no longer count.
        for _ in 0..560 {
            net.t += 20_000;
            let (there, here) = (net.local(0), net.local(1));
            for o in net.hosts[0].s.tick(there) {
                let body = Datagram::decode(&o.bytes).map(|d| d.body);
                if matches!(body, Ok(Body::Beacon(_))) {
                    net.hosts[1].s.on_datagram(&o.bytes, addr(0), here);
                }
            }
            let _ = net.hosts[1].s.tick(here);
        }
        assert_eq!(net.clock(1).peers, 1, "the leader is still there");
        assert!(
            !net.hosts[1].s.is_locked(net.local(1)),
            "its clock is no longer known"
        );
        assert_eq!(net.clock(1).offset_us, 0);
        assert_eq!(net.hosts[1].s.peers(net.local(1))[0].offset_us, None);
    }
}
