//! The runtime of decks-link: UDP sockets and two threads around a [`LinkSession`].
//!
//! * The **receiver** blocks in `recv_from`, stamps the clock the moment a datagram wakes
//!   it, hands it to the session and sends what the session answers (a pong leaves at once).
//!   It reads with NO timeout, except in a node bound to one LAN address (see Stopping).
//! * The **timer** wakes every 20 ms and lets the session send what is due (beacons, pings,
//!   proposals).
//!
//! Why not one thread with a read timeout (the first design): on Windows a datagram that
//! arrives while the timeout of a blocking receive fires can be dropped. Measured on
//! loopback (2026-11-11, std sockets, one PC): a receiver with a 20 ms read timeout lost 5 of
//! 494 datagrams from a sender that sends when its own 20 ms timeout fires; a receiver
//! without a timeout lost 0 of 510 from the same sender; the timeout receiver lost 0 of 232
//! when the sender sent between two timer ticks. Two nodes on one computer wake on the same
//! tick, and with the first design the loopback tests failed in 6 of 160 runs: the traces
//! show a tempo proposal sent five times, 200 ms apart, of which none arrived, with no
//! thread stalled. Microsoft's documentation of `SO_RCVTIMEO` says that after a blocking
//! receive timed out the socket "is in an indeterminate state".
//!
//! ## Stopping
//!
//! std cannot cancel a blocking read. [`LinkNode::stop`] sets a flag and wakes the receiver
//! with a one-byte datagram from the node's own socket to its own port. For a node that
//! listens on every interface or on loopback that datagram travels over loopback, which is
//! always there. A node bound to ONE LAN address can only send from that address: when its
//! interface is down (Wi-Fi off, which is just when somebody presses Stop) the OS refuses
//! the datagram, the receiver would sleep on, and the port would stay taken until the app
//! restarts. Such a node therefore reads with a standing timeout of [`STOP_GUARD`]: its
//! receiver looks at the flag about that often (on a PC busy with other builds a reader
//! like it once noticed the flag 0.9 s after it was set). The loss described above applies to
//! that bind mode, for a datagram that arrives in the instant the timeout fires; the timeout
//! only fires after 400 ms without any datagram, and a session member sends five beacons a
//! second. Measured on loopback (2026-11-12, Windows 11, std sockets, one PC busy with other
//! builds): a receiver with a standing 400 ms timeout got 40 of 40 datagrams sent at beacon
//! cadence (its timeout fired 3 times in 10 s) and 93 of 95 from a sender that sends when its
//! own 400 ms timeout fires (the worst case: both wake on one timer).
//!
//! Setting a timeout when the stop begins is not enough. Measured the same day: a
//! `recv_from` that is already blocked does not see a read timeout set afterwards from
//! another thread (6 of 6 reads were still blocked 1.5 s after a 20 ms timeout was set, and
//! ended with the next datagram); the timeout counts for reads that begin later. `stop` sets
//! one all the same ([`STOP_READ_TIMEOUT`]), for a receiver that was between two reads.
//! Also measured: a datagram sent from the socket to a loopback port nobody listens on
//! DOES end its blocked read on Windows (the "port unreachable" comes back as an error, 3 of
//! 3), so a test that stands in for the downed interface must drop the wake-up datagram,
//! not misdirect it.
//!
//! A receiver that did not end within [`STOP_PATIENCE`] is left behind and counted
//! ([`stuck_receivers`]). It keeps the socket until a datagram or a timeout lets it see the
//! flag: with the standing timeout that is a moment later, without one it can be never.
//!
//! Callers only take a short mutex; nothing they call waits for the network.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::session::{LinkClock, LinkSession, LinkStats, Outgoing, PeerInfo};
use crate::wire::valid_tempo;

/// Period of the timer thread: how often the session's timers run.
const POLL: Duration = Duration::from_millis(20);
/// How long [`LinkNode::stop`] keeps waking the receiver before it leaves the thread behind
/// (see the module documentation, Stopping). Several times [`STOP_GUARD`]: on a machine busy
/// with other builds a reader with a 400 ms timeout noticed its stop flag 0.9 s late once.
/// Only a receiver that cannot be ended costs this wait; a healthy stop never gets near it.
const STOP_PATIENCE: Duration = Duration::from_secs(3);
/// Standing read timeout of a node bound to one LAN address, the only kind whose wake-up
/// datagram the OS can refuse: twice the beacon interval, so it seldom fires while a session
/// member is heard, and well inside [`STOP_PATIENCE`].
const STOP_GUARD: Duration = Duration::from_millis(400);
/// Read timeout set when a node stops: a read that begins after that ends this soon.
const STOP_READ_TIMEOUT: Duration = Duration::from_millis(20);
// The receiver of a node with the standing timeout must get to look at the stop flag several
// times within the patience of `stop`.
const _: () = assert!(STOP_GUARD.as_millis() * 4 <= STOP_PATIENCE.as_millis());
/// Receive buffer: larger than any datagram of the protocol, so an oversized one is seen as
/// oversized instead of being cut to a valid length.
const RECV_BUF: usize = 128;
/// Every datagram of the protocol stays on the network segment: unicast and multicast alike
/// leave with this IP time-to-live, so a router never forwards an answer to a spoofed source.
const TTL: u32 = 1;
/// While the machine has no route (the LAN address is loopback) the group socket is tried
/// again this often, so a node started before the Wi-Fi came up reaches the LAN without a
/// restart.
const GROUP_RETRY_US: u64 = 5_000_000;
/// Instances of the app on one machine: the first takes the port, the next ones the ports
/// after it (std cannot share a UDP port), and all of them announce to this port range on
/// loopback so they find each other.
pub const LOCAL_INSTANCES: u16 = 4;

/// Receiver threads left behind by [`LinkNode::stop`] in this process (they only grow).
static STUCK_RECEIVERS: AtomicU64 = AtomicU64::new(0);

/// How many times, in this process, [`LinkNode::stop`] could not end a node's receiver
/// thread and left it behind with its socket (and so its port). 0 in a healthy process: for
/// diagnostics and logs.
pub fn stuck_receivers() -> u64 {
    STUCK_RECEIVERS.load(Ordering::Relaxed)
}

/// The standing read timeout of a node that listens on `bind`: none for every interface and
/// for loopback (the wake-up datagram of [`LinkNode::stop`] goes over loopback and always
/// arrives), [`STOP_GUARD`] for one LAN address (see the module documentation, Stopping).
fn stop_guard(bind: Ipv4Addr) -> Option<Duration> {
    (!bind.is_unspecified() && !bind.is_loopback()).then_some(STOP_GUARD)
}

/// How to start a [`LinkNode`].
#[derive(Debug, Clone)]
pub struct LinkConfig {
    /// Multicast group to announce on and listen to; `None` = unicast only (`extra_peers`).
    /// Ignored when `bind` is a loopback address.
    pub multicast_addr: Option<Ipv4Addr>,
    /// UDP port to listen on, and the port of the multicast group. 0 = any free port.
    pub port: u16,
    /// Local address to listen on (`0.0.0.0` = every interface).
    pub bind: Ipv4Addr,
    /// Our id; 0 = pick one ([`crate::random_peer_id`]).
    pub peer_id: u64,
    /// Tempo of our own session until we meet another one.
    pub tempo: f64,
    /// Session key ([`crate::key_from_pin`]); 0 = open session.
    pub key: u32,
    /// Addresses that get every beacon by unicast as well (peers behind a network that drops
    /// multicast; tests).
    pub extra_peers: Vec<SocketAddr>,
    /// Share the machine with other instances: when `port` is taken, listen on one of the
    /// next [`LOCAL_INSTANCES`]` - 1` ports instead of failing, and send every beacon to that
    /// port range on `127.0.0.1` too. An instance on a later port hears no multicast; peers
    /// on other machines learn its port from its beacons and talk to it directly. Only used
    /// when `bind` is `0.0.0.0` or a loopback address, and `port` is not 0. With a loopback
    /// bind ("this computer only") the range on `127.0.0.1` is the only way two instances
    /// meet, and nothing but loopback is ever touched.
    pub local_instances: bool,
    /// Monotonic clock in microseconds. Every time passed to or read from the node is on this
    /// clock.
    pub clock: fn() -> u64,
}

impl Default for LinkConfig {
    fn default() -> Self {
        Self {
            multicast_addr: Some(crate::MULTICAST_ADDR),
            port: crate::DEFAULT_PORT,
            bind: Ipv4Addr::UNSPECIFIED,
            peer_id: 0,
            tempo: 128.0,
            key: 0,
            extra_peers: Vec::new(),
            local_instances: true,
            clock: crate::monotonic_micros,
        }
    }
}

impl LinkConfig {
    /// A node that only talks on this machine (`127.0.0.1`, no multicast): tests and demos.
    pub fn loopback(port: u16) -> Self {
        Self {
            multicast_addr: None,
            port,
            bind: Ipv4Addr::LOCALHOST,
            local_instances: false,
            ..Self::default()
        }
    }
}

/// Everything a UI shows about a running node, read in one go.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkSnapshot {
    pub clock: LinkClock,
    /// The node's clock (µs) at which `clock` holds.
    pub now_us: u64,
    /// Another member's clock offset is known: the beat is the shared one.
    pub locked: bool,
    pub peer_id: u64,
    pub session_id: u64,
    /// The session has a PIN key.
    pub key_set: bool,
    /// Address the node listens on.
    pub local_addr: SocketAddr,
    /// The node joined the multicast group and sends to it from a LAN address. False while
    /// the machine has no route (loopback only), with a loopback bind, and without a group.
    pub multicast: bool,
    /// Our phase shift against the session, in beats.
    pub nudge_beats: f64,
    pub peers: Vec<PeerInfo>,
    pub stats: LinkStats,
    /// Datagrams the OS refused to send, and receive errors other than a timeout.
    pub io_errors: u64,
}

struct Shared {
    session: Mutex<LinkSession>,
    stop: AtomicBool,
    io_errors: AtomicU64,
    multicast: AtomicBool,
    /// Held by a thread from the moment it asks the session what to send until those
    /// datagrams left: the two threads never interleave their sends, and nothing computed
    /// before a stop leaves after the goodbye (a late beacon would bring this peer back at
    /// the others for three seconds). Lock order: `wire`, then `session`. Callers of the node
    /// never take it, so they never wait for a send.
    wire: Mutex<()>,
}

impl Shared {
    fn session(&self) -> MutexGuard<'_, LinkSession> {
        // The session holds plain data; a panic elsewhere must not take sync down with it.
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wire(&self) -> MutexGuard<'_, ()> {
        self.wire.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The multicast side of a node; changes when the machine gets a LAN address after the start.
struct Group {
    /// Sends to the group. Bound to the LAN address: a socket bound to `0.0.0.0` sends
    /// multicast out of whatever interface the OS prefers, often a virtual one.
    socket: Option<(UdpSocket, SocketAddrV4)>,
    /// The group to join and send to once the machine has a LAN address: (group, port, the
    /// interface of a node bound to one address). `None` = no group wanted, or already done.
    wanted: Option<(Ipv4Addr, u16, Option<Ipv4Addr>)>,
    /// Node clock at which the group is tried again.
    retry_at: u64,
    /// The listening socket is a member of the group (a second join of the same group fails,
    /// so a retry must not take that failure for "not joined").
    joined: bool,
}

/// The sockets of a node, shared by its two threads (`send_to` and `recv_from` take `&self`).
struct Sockets {
    /// Listens; also sends every unicast datagram (so answers come back to its port). No
    /// read timeout, on purpose, except the standing one of a node bound to one LAN address:
    /// see the module documentation.
    main: UdpSocket,
    group: Mutex<Group>,
    /// Every beacon also goes here by unicast: configured extra peers, local instances.
    also: Vec<SocketAddr>,
}

impl Sockets {
    fn group(&self) -> MutexGuard<'_, Group> {
        self.group.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Join `addr` on the LAN interface (`interface`, or the one of the default route) and
    /// open the sending socket bound to it. `false` when the machine has no LAN address yet
    /// (the caller tries again later).
    fn open_group(
        &self,
        group: &mut Group,
        addr: Ipv4Addr,
        port: u16,
        interface: Option<Ipv4Addr>,
    ) -> bool {
        let lan = interface.unwrap_or_else(crate::lan_ip);
        if lan.is_loopback() {
            return false;
        }
        // std cannot list interfaces: join on the default one and on the LAN one. One of the
        // two failing is normal (same interface twice).
        let on_default = self
            .main
            .join_multicast_v4(&addr, &Ipv4Addr::UNSPECIFIED)
            .is_ok();
        let on_lan = self.main.join_multicast_v4(&addr, &lan).is_ok();
        group.joined |= on_default || on_lan;
        if !group.joined {
            return false;
        }
        // Hear the group datagrams of other instances on this machine. The option acts on the
        // receiving socket on Windows and on the sending one elsewhere: set it on both.
        let _ = self.main.set_multicast_loop_v4(true);
        let Ok(socket) = UdpSocket::bind((lan, 0)) else {
            return false;
        };
        let _ = socket.set_multicast_loop_v4(true);
        // Never routed: the session is for one network segment.
        let _ = socket.set_multicast_ttl_v4(TTL);
        let _ = socket.set_ttl(TTL);
        group.socket = Some((socket, SocketAddrV4::new(addr, port)));
        true
    }

    /// The group is wanted and not open yet: try now and then, never more than once per
    /// [`GROUP_RETRY_US`].
    fn retry_group(&self, now: u64) -> bool {
        let mut group = self.group();
        let Some((addr, port, interface)) = group.wanted else {
            return false;
        };
        if now < group.retry_at {
            return false;
        }
        group.retry_at = now.saturating_add(GROUP_RETRY_US);
        if self.open_group(&mut group, addr, port, interface) {
            group.wanted = None;
            return true;
        }
        false
    }

    fn send(&self, out: &[Outgoing], errors: &AtomicU64) {
        let mut failed = 0;
        for o in out {
            match o.to {
                Some(to) => failed += u64::from(self.main.send_to(&o.bytes, to).is_err()),
                None => {
                    let group = self.group();
                    if let Some((socket, to)) = &group.socket {
                        failed += u64::from(socket.send_to(&o.bytes, to).is_err());
                    }
                    drop(group);
                    for peer in &self.also {
                        failed += u64::from(self.main.send_to(&o.bytes, peer).is_err());
                    }
                }
            }
        }
        if failed > 0 {
            errors.fetch_add(failed, Ordering::Relaxed);
        }
    }
}

/// A running tempo-sync peer. Dropping it stops it.
pub struct LinkNode {
    shared: Arc<Shared>,
    sockets: Arc<Sockets>,
    /// Blocks in `recv_from`; woken by [`LinkNode::stop`] with a datagram to its own port
    /// (or, in a node bound to one LAN address, by its standing read timeout).
    receiver: Option<JoinHandle<()>>,
    /// Runs the session's timers every [`POLL`]; sends the goodbye when it ends.
    timer: Option<JoinHandle<()>>,
    local_addr: SocketAddr,
    clock: fn() -> u64,
    /// Test only: [`LinkNode::stop`] behaves as if the OS refused the wake-up datagram (the
    /// interface of a node bound to one LAN address is down).
    #[cfg(test)]
    wake_refused: bool,
}

impl std::fmt::Debug for LinkNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkNode")
            .field("local_addr", &self.local_addr)
            .field("multicast", &self.multicast())
            .field("running", &self.timer.is_some())
            .finish()
    }
}

/// A node that binds `0.0.0.0` or a loopback address shares the machine with other instances
/// through the port range; a node bound to one LAN address keeps the one port it was given.
fn shares_port_range(config: &LinkConfig) -> bool {
    config.local_instances
        && (config.bind.is_unspecified() || config.bind.is_loopback())
        && config.port != 0
}

/// `guard` = the standing read timeout of the listening socket (see [`stop_guard`]).
fn open_sockets(config: &LinkConfig, guard: Option<Duration>) -> io::Result<(Sockets, SocketAddr)> {
    let shared = shares_port_range(config);
    let range = if shared { LOCAL_INSTANCES } else { 1 };
    let mut bound = None;
    let mut last_error = None;
    for port in (0..range).filter_map(|i| config.port.checked_add(i)) {
        match UdpSocket::bind((config.bind, port)) {
            Ok(socket) => {
                bound = Some(socket);
                break;
            }
            // Taken by another instance; or (in the shared range only) a port Windows keeps
            // for something else ("access denied" on a reserved port range): try the next.
            Err(e)
                if e.kind() == io::ErrorKind::AddrInUse
                    || (shared && e.kind() == io::ErrorKind::PermissionDenied) =>
            {
                last_error = Some(e);
            }
            Err(e) => return Err(e),
        }
    }
    let Some(main) = bound else {
        return Err(last_error.unwrap_or_else(|| io::ErrorKind::AddrInUse.into()));
    };
    // Blocking receives: with no timeout, or with the standing one of a node bound to one LAN
    // address (see the module documentation, Stopping).
    main.set_read_timeout(guard)?;
    // Answers go to the source address of whatever beacon arrived: with TTL 1 they cannot
    // leave the segment even when that address is forged.
    main.set_ttl(TTL)?;
    let local_addr = main.local_addr()?;
    let mut also = config.extra_peers.clone();
    if shared {
        // Loopback only: the other instances of this machine, never a LAN address.
        also.extend(
            (0..LOCAL_INSTANCES)
                .filter_map(|i| config.port.checked_add(i))
                .filter(|&port| port != local_addr.port())
                .map(|port| SocketAddr::from((Ipv4Addr::LOCALHOST, port))),
        );
    }
    let sockets = Sockets {
        main,
        group: Mutex::new(Group {
            socket: None,
            wanted: None,
            retry_at: 0,
            joined: false,
        }),
        also,
    };
    if let Some(addr) = config.multicast_addr.filter(|_| !config.bind.is_loopback()) {
        if !addr.is_multicast() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a multicast address",
            ));
        }
        let interface = if config.bind.is_unspecified() {
            None
        } else {
            Some(config.bind)
        };
        let mut group = sockets.group();
        if !sockets.open_group(&mut group, addr, config.port, interface) {
            // No LAN address yet (or the join failed): the thread tries again.
            group.wanted = Some((addr, config.port, interface));
        }
    }
    Ok((sockets, local_addr))
}

/// The receiver thread: one blocking `recv_from` after another, until [`LinkNode::stop`]
/// sets the flag and a datagram (or a read timeout) lets the thread see it.
fn receive(shared: &Shared, sockets: &Sockets, clock: fn() -> u64) {
    let mut buf = [0u8; RECV_BUF];
    while !shared.stop.load(Ordering::Relaxed) {
        let got = sockets.main.recv_from(&mut buf);
        // Stamp first: this is the receive time the clock comparison uses.
        let now = clock();
        match got {
            Ok((len, from)) => {
                let _wire = shared.wire();
                if shared.stop.load(Ordering::Relaxed) {
                    // The datagram that woke us to stop, or one that raced the goodbye: not
                    // for the session, and nothing may be sent after the goodbye.
                    break;
                }
                let out = {
                    let mut session = shared.session();
                    session.on_datagram(&buf[..len], from, now);
                    // Answers (a pong) leave now, not at the next timer tick. Stamped again:
                    // a wait for the other thread's sends is part of the reply time, not of
                    // the receive time.
                    session.tick(clock().max(now))
                };
                sockets.send(&out, &shared.io_errors);
            }
            Err(e) => match e.kind() {
                // (Windows) the "port unreachable" of an earlier send: a peer, or a local
                // instance slot, that is not there. Or the read timeout of a node bound to
                // one LAN address, or of a node that stops. Nothing was received; read on
                // (the loop looks at the stop flag first).
                io::ErrorKind::ConnectionReset
                | io::ErrorKind::Interrupted
                | io::ErrorKind::WouldBlock
                | io::ErrorKind::TimedOut => {}
                _ => {
                    // An oversized datagram (Windows) or a socket error: count it, and do not
                    // spin if it persists.
                    shared.io_errors.fetch_add(1, Ordering::Relaxed);
                    thread::sleep(Duration::from_millis(2));
                }
            },
        }
    }
}

/// The timer thread: every [`POLL`] the session sends what is due. On stop it sends the
/// goodbye.
fn keep_time(shared: &Shared, sockets: &Sockets, clock: fn() -> u64) {
    while !shared.stop.load(Ordering::Relaxed) {
        thread::sleep(POLL);
        if sockets.retry_group(clock()) {
            shared.multicast.store(true, Ordering::Relaxed);
        }
        let _wire = shared.wire();
        if shared.stop.load(Ordering::Relaxed) {
            break;
        }
        // Stamped with the lock held: what is sent carries the time it leaves.
        let now = clock();
        let out = shared.session().tick(now);
        sockets.send(&out, &shared.io_errors);
    }
    let _wire = shared.wire();
    let bye = shared.session().leave();
    sockets.send(&bye, &shared.io_errors);
}

impl LinkNode {
    /// Open the sockets and start the threads. Fails when the address cannot be bound, the
    /// tempo is not within 20..=300, or the multicast address is not one.
    pub fn start(config: LinkConfig) -> io::Result<Self> {
        let guard = stop_guard(config.bind);
        Self::start_with(config, guard)
    }

    /// [`LinkNode::start`] with the standing read timeout of the listening socket given by
    /// the caller (tests give a loopback node the one a LAN-bound node has).
    fn start_with(config: LinkConfig, guard: Option<Duration>) -> io::Result<Self> {
        if !valid_tempo(config.tempo) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "tempo must be within 20..=300 BPM",
            ));
        }
        let (sockets, local_addr) = open_sockets(&config, guard)?;
        let multicast = sockets.group().socket.is_some();
        let sockets = Arc::new(sockets);
        let peer_id = match config.peer_id {
            0 => crate::random_peer_id(),
            id => id,
        };
        let mut session = LinkSession::with_key(peer_id, config.tempo, config.key);
        session.set_reply_port(local_addr.port());
        let shared = Arc::new(Shared {
            session: Mutex::new(session),
            stop: AtomicBool::new(false),
            io_errors: AtomicU64::new(0),
            multicast: AtomicBool::new(multicast),
            wire: Mutex::new(()),
        });
        let clock = config.clock;
        let mut node = Self {
            shared,
            sockets,
            receiver: None,
            timer: None,
            local_addr,
            clock,
            #[cfg(test)]
            wake_refused: false,
        };
        let (shared, sockets) = (Arc::clone(&node.shared), Arc::clone(&node.sockets));
        node.receiver = Some(
            thread::Builder::new()
                .name("decks-link-rx".into())
                .spawn(move || receive(&shared, &sockets, clock))?,
        );
        let (shared, sockets) = (Arc::clone(&node.shared), Arc::clone(&node.sockets));
        // If this spawn fails, dropping `node` stops the receiver that already runs.
        node.timer = Some(
            thread::Builder::new()
                .name("decks-link".into())
                .spawn(move || keep_time(&shared, &sockets, clock))?,
        );
        Ok(node)
    }

    /// Say goodbye to the peers and stop the threads. Returns within a few tens of ms; a
    /// node bound to one LAN address whose interface is down takes about its standing read
    /// timeout (400 ms) longer; a receiver that cannot be ended costs 3 s and is counted
    /// ([`stuck_receivers`]). Calling it again does nothing.
    pub fn stop(&mut self) {
        let _ = self.stop_threads();
    }

    /// [`LinkNode::stop`]; `false` when the receiver thread could not be ended and was left
    /// behind with the socket (counted in [`stuck_receivers`]).
    fn stop_threads(&mut self) -> bool {
        self.shared.stop.store(true, Ordering::Relaxed);
        // The timer first: it sends the goodbye while the socket still answers.
        if let Some(timer) = self.timer.take() {
            let _ = timer.join();
        }
        let Some(receiver) = self.receiver.take() else {
            return true;
        };
        // A read that begins from now on ends by itself. The read in progress does not see
        // this (measured, see the module documentation): it ends with the datagram below or,
        // in a node bound to one LAN address, with its standing timeout. Losing a datagram
        // to a timeout no longer matters: the goodbye is out.
        let _ = self.sockets.main.set_read_timeout(Some(STOP_READ_TIMEOUT));
        // The fast path: wake the receiver with a datagram to its own port, from its own
        // socket (over loopback unless the node is bound to one LAN address). One datagram
        // is enough; it is repeated in case that one is lost or refused.
        let to = SocketAddr::from((
            if self.local_addr.ip().is_unspecified() {
                Ipv4Addr::LOCALHOST.into()
            } else {
                self.local_addr.ip()
            },
            self.local_addr.port(),
        ));
        let started = Instant::now();
        while !receiver.is_finished() && started.elapsed() < STOP_PATIENCE {
            self.wake_receiver(to);
            thread::sleep(Duration::from_millis(5));
        }
        if receiver.is_finished() {
            let _ = receiver.join();
            return true;
        }
        // Neither a datagram nor a timeout ended the read within the patience. The thread is
        // left behind and keeps the socket, and with it the port, until one of the two lets
        // it see the stop flag; without a standing timeout that can be never.
        STUCK_RECEIVERS.fetch_add(1, Ordering::Relaxed);
        false
    }

    /// One wake-up datagram for the receiver; a refusal by the OS is not an error here (the
    /// caller tries again, and the read timeout is the other way out).
    fn wake_receiver(&self, to: SocketAddr) {
        #[cfg(test)]
        {
            if self.wake_refused {
                return;
            }
        }
        let _ = self.sockets.main.send_to(&[0u8], to);
    }

    /// Address the node listens on (the real port when the config asked for 0 or fell back).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// The node joined the multicast group and sends to it from a LAN address (see
    /// [`LinkSnapshot::multicast`]). May turn true later, when the machine gets a route.
    pub fn multicast(&self) -> bool {
        self.shared.multicast.load(Ordering::Relaxed)
    }

    pub fn peer_id(&self) -> u64 {
        self.shared.session().peer_id()
    }

    /// The session clock now.
    pub fn status(&self) -> LinkClock {
        self.clock_at((self.clock)())
    }

    /// The session clock at `host_us` of the node's clock (extrapolated with the tempo).
    pub fn clock_at(&self, host_us: u64) -> LinkClock {
        self.shared.session().clock_at(host_us)
    }

    /// Another member's clock offset is known and fresh.
    pub fn is_locked(&self) -> bool {
        self.shared.session().is_locked((self.clock)())
    }

    /// Ask for a session tempo (see [`LinkSession::set_tempo`]); `false` when out of range or
    /// while the session tempo follows a playing deck of the leader.
    pub fn set_tempo(&self, bpm: f64) -> bool {
        self.shared.session().set_tempo(bpm, (self.clock)())
    }

    /// Whether this node's own clock is a playing deck (see
    /// [`LinkSession::set_tempo_locked`]). The app sets it with every clock it feeds.
    pub fn set_tempo_locked(&self, locked: bool) {
        self.shared.session().set_tempo_locked(locked);
    }

    /// The app's own master clock: `beat` at `host_us`, playing at `bpm`. Used while this
    /// node leads; returns whether it was (see [`LinkSession::set_local_clock`]).
    pub fn feed_local_clock(&self, bpm: f64, beat: f64, host_us: u64) -> bool {
        self.shared.session().set_local_clock(bpm, beat, host_us)
    }

    /// Shift our phase against the session (see [`LinkSession::nudge`]): a follower's
    /// control, `false` while this node leads.
    pub fn nudge(&self, delta_beats: f64) -> bool {
        self.shared.session().nudge(delta_beats, (self.clock)())
    }

    /// A tempo a follower asked for and this node adopted (see
    /// [`LinkSession::take_tempo_request`]).
    pub fn take_tempo_request(&self) -> Option<f64> {
        self.shared.session().take_tempo_request()
    }

    /// Everything the UI shows, read under one lock.
    pub fn snapshot(&self) -> LinkSnapshot {
        let now = (self.clock)();
        let session = self.shared.session();
        LinkSnapshot {
            clock: session.clock_at(now),
            now_us: now,
            locked: session.is_locked(now),
            peer_id: session.peer_id(),
            session_id: session.session_id(),
            key_set: session.key() != 0,
            local_addr: self.local_addr,
            multicast: self.multicast(),
            nudge_beats: session.nudge_beats(),
            peers: session.peers(now),
            stats: session.stats(),
            io_errors: self.shared.io_errors.load(Ordering::Relaxed),
        }
    }
}

impl Drop for LinkNode {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A node on 127.0.0.1 (the tests never listen anywhere else) whose listening socket has
    /// the standing read timeout `guard`.
    fn loopback_node(guard: Option<Duration>, peer: Option<&LinkNode>) -> LinkNode {
        LinkNode::start_with(
            LinkConfig {
                extra_peers: peer.map(LinkNode::local_addr).into_iter().collect(),
                ..LinkConfig::loopback(0)
            },
            guard,
        )
        .expect("a loopback node starts")
    }

    /// Let the receiver thread get into its blocking read.
    fn settle() {
        thread::sleep(Duration::from_millis(100));
    }

    fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < limit {
            if done() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        done()
    }

    #[test]
    fn only_a_node_bound_to_one_lan_address_reads_with_a_timeout() {
        // Every interface and loopback: the wake-up datagram goes over loopback, no timeout
        // (a timeout can lose a datagram, see the module documentation).
        assert_eq!(stop_guard(Ipv4Addr::UNSPECIFIED), None);
        assert_eq!(stop_guard(Ipv4Addr::LOCALHOST), None);
        assert_eq!(stop_guard(Ipv4Addr::new(127, 0, 0, 9)), None);
        // One LAN address: its interface can be down when the node stops.
        for bind in [
            Ipv4Addr::new(192, 168, 1, 20),
            Ipv4Addr::new(10, 0, 0, 5),
            Ipv4Addr::new(169, 254, 7, 7),
        ] {
            assert_eq!(stop_guard(bind), Some(STOP_GUARD), "{bind}");
        }
        // What the listening socket really has.
        let plain = loopback_node(None, None);
        assert_eq!(plain.sockets.main.read_timeout().unwrap(), None);
        let guarded = loopback_node(Some(STOP_GUARD), None);
        assert_eq!(
            guarded.sockets.main.read_timeout().unwrap(),
            Some(STOP_GUARD)
        );
    }

    // (P1) Wi-Fi off, then Stop: the OS refuses the wake-up datagram of a node bound to one
    // LAN address. Its receiver must end all the same and give the port back, or the next
    // start on that address fails with AddrInUse until the app restarts.
    #[test]
    fn stop_ends_the_receiver_and_frees_the_port_when_the_wake_datagram_is_refused() {
        let mut node = loopback_node(Some(STOP_GUARD), None);
        let addr = node.local_addr();
        node.wake_refused = true;
        settle();
        let started = Instant::now();
        // (The counter of receivers left behind is process-wide and another test raises it
        // on purpose: the return value is what says whether THIS one ended.)
        assert!(
            node.stop_threads(),
            "the receiver was left behind after {:?}",
            started.elapsed()
        );
        let took = started.elapsed();
        assert!(took < STOP_PATIENCE, "stop took {took:?}");
        assert!(node.receiver.is_none() && node.timer.is_none());
        // Stopping again does nothing.
        assert!(node.stop_threads());
        // The app drops a stopped node; the port is free for the next start at once.
        drop(node);
        let again = UdpSocket::bind(addr);
        assert!(
            again.is_ok(),
            "{addr} is still taken after stop: {:?}",
            again.err()
        );
    }

    // The control of the test above, and the honest end of `stop`: without a standing
    // timeout a receiver whose wake-up datagram is refused cannot be ended. It is left
    // behind, counted, and keeps the port until a datagram reaches it. Windows only: that a
    // read in progress ignores a timeout set afterwards was measured there, nowhere else.
    #[cfg(windows)]
    #[test]
    fn a_receiver_that_cannot_be_woken_is_left_behind_and_counted() {
        let mut node = loopback_node(None, None);
        let addr = node.local_addr();
        node.wake_refused = true;
        settle();
        let stuck_before = stuck_receivers();
        let started = Instant::now();
        assert!(!node.stop_threads(), "the receiver ended without a wake-up");
        assert!(started.elapsed() >= STOP_PATIENCE);
        assert!(stuck_receivers() > stuck_before);
        drop(node);
        let taken = UdpSocket::bind(addr).expect_err("the thread left behind holds the port");
        assert_eq!(taken.kind(), io::ErrorKind::AddrInUse);
        // Any datagram lets the thread see the stop flag: it ends and the port is free again.
        let other = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let freed = wait_until(Duration::from_secs(5), || {
            let _ = other.send_to(&[0u8], addr);
            UdpSocket::bind(addr).is_ok()
        });
        assert!(freed, "{addr} was never given back");
    }

    // The standing timeout must not cost the session: a node that reads with it and a node
    // that reads without meet, and the guarded one stops through the fast path (a datagram).
    #[test]
    fn a_node_with_the_standing_timeout_still_meets_its_peer_and_stops_by_datagram() {
        let plain = loopback_node(None, None);
        let mut guarded = loopback_node(Some(STOP_GUARD), Some(&plain));
        let met = wait_until(Duration::from_secs(5), || {
            plain.is_locked() && guarded.is_locked()
        });
        assert!(
            met,
            "never locked: {:?} / {:?}",
            plain.snapshot(),
            guarded.snapshot()
        );
        assert_eq!(guarded.snapshot().stats.malformed, 0);
        assert!(guarded.stop_threads(), "the receiver was left behind");
        // The goodbye went out before the receiver was stopped: the peer is alone at once.
        let alone = wait_until(Duration::from_millis(2_500), || plain.status().peers == 0);
        assert!(alone, "the peer still counts {}", plain.status().peers);
    }
}
