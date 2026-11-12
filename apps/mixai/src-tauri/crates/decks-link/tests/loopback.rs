//! Two real nodes over UDP on 127.0.0.1 (no multicast: each test node unicasts its beacons to
//! the other through `extra_peers`, so the test does not depend on what the runner's network
//! lets through). Loopback only, on purpose: listening on a LAN address makes Windows ask the
//! user a firewall question.

use std::io;
use std::net::Ipv4Addr;
use std::thread::sleep;
use std::time::{Duration, Instant};

use decks_link::{
    DEFAULT_PORT, LOCAL_INSTANCES, LinkConfig, LinkNode, key_from_pin, monotonic_micros,
};

/// How long a condition may take before a test gives up. Generous on purpose: the machine
/// that runs the tests is often busy with other builds, and a late thread is not a bug.
const PATIENCE: Duration = Duration::from_secs(5);

/// The second machine's clock: one second ahead of the first.
fn skewed_clock() -> u64 {
    monotonic_micros() + 1_000_000
}

fn wait_until(limit: Duration, mut done: impl FnMut() -> bool) -> Option<Duration> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if done() {
            return Some(start.elapsed());
        }
        sleep(Duration::from_millis(10));
    }
    done().then(|| start.elapsed())
}

/// Beat difference of the two nodes at one instant (b's clock is one second ahead), in ms.
fn beat_error_ms(a: &LinkNode, b: &LinkNode, bpm: f64) -> f64 {
    let now = monotonic_micros();
    let d = a.clock_at(now).beat - b.clock_at(now + 1_000_000).beat;
    d.abs() * 60_000.0 / bpm
}

fn pair(key: u32) -> (LinkNode, LinkNode) {
    let a = LinkNode::start(LinkConfig {
        peer_id: 10,
        tempo: 128.0,
        key,
        ..LinkConfig::loopback(0)
    })
    .expect("node a starts on a free loopback port");
    let b = LinkNode::start(LinkConfig {
        peer_id: 20,
        tempo: 120.0,
        key,
        extra_peers: vec![a.local_addr()],
        clock: skewed_clock,
        ..LinkConfig::loopback(0)
    })
    .expect("node b starts on a free loopback port");
    (a, b)
}

#[test]
fn two_nodes_on_loopback_lock_and_share_the_beat() {
    let (mut a, mut b) = pair(0);
    assert!(a.local_addr().ip().is_loopback() && b.local_addr().ip().is_loopback());
    assert_ne!(a.local_addr().port(), b.local_addr().port());

    // Locked, the clock offset measured (the follower's clock is one second ahead) and the
    // beats equal at one instant. The tolerances are part of the condition: the first clock
    // sample after a lock may be a slow one, later samples replace it.
    let settled = wait_until(PATIENCE, || {
        a.is_locked()
            && b.is_locked()
            && (b.status().offset_us + 1_000_000).abs() < 15_000
            && beat_error_ms(&a, &b, 128.0) < 15.0
    });
    let (sa, sb) = (a.snapshot(), b.snapshot());
    let settled = settled.unwrap_or_else(|| {
        panic!(
            "not locked on one beat within {PATIENCE:?}: offset {} µs, beat error {:.2} ms\n{sa:?}\n{sb:?}",
            sb.clock.offset_us,
            beat_error_ms(&a, &b, 128.0)
        )
    });
    println!("locked on one beat after {settled:?}");

    assert!(sa.clock.leader, "the lower id leads");
    assert!(!sb.clock.leader);
    assert_eq!((sa.clock.peers, sb.clock.peers), (1, 1));
    assert_eq!(sa.session_id, sb.session_id);
    assert_eq!(sb.clock.bpm, 128.0, "the follower takes the session tempo");
    assert!(!sa.multicast && !sb.multicast);
    assert!(!sa.clock.tempo_locked && !sb.clock.tempo_locked);

    // A tempo asked on the follower comes back from the leader.
    assert!(b.set_tempo(140.0));
    assert!(!b.set_tempo(f64::NAN));
    let took = wait_until(PATIENCE, || {
        a.status().bpm == 140.0 && b.status().bpm == 140.0
    });
    assert!(
        took.is_some(),
        "tempo did not propagate: {} / {}",
        a.status().bpm,
        b.status().bpm
    );
    assert_eq!(a.take_tempo_request(), Some(140.0));

    // While the leader's clock is a playing deck the tempo is not for sale: the follower
    // learns it from the beacons and its proposal is refused, on both sides.
    a.set_tempo_locked(true);
    let told = wait_until(PATIENCE, || b.status().tempo_locked);
    assert!(told.is_some(), "the follower never saw the tempo lock");
    assert!(!b.set_tempo(150.0), "a proposal is refused while locked");
    assert!(!a.set_tempo(150.0), "so is the leader's own");
    sleep(Duration::from_millis(300));
    assert_eq!((a.status().bpm, b.status().bpm), (140.0, 140.0));
    assert_eq!(a.take_tempo_request(), None);
    a.set_tempo_locked(false);
    let freed = wait_until(PATIENCE, || !b.status().tempo_locked);
    assert!(freed.is_some(), "the follower never saw the lock go");

    // Nudge is the follower's control; the leader's is refused.
    assert!(!a.nudge(0.25), "the leader cannot nudge");
    assert!(b.nudge(0.25) && b.nudge(-0.25));

    // The leader's own clock moves the session phase; the follower follows.
    let now = monotonic_micros();
    assert!(a.feed_local_clock(140.0, a.clock_at(now).beat + 0.5, now));
    assert!(
        !b.feed_local_clock(140.0, 0.0, skewed_clock()),
        "a follower's clock is not used"
    );
    let followed = wait_until(PATIENCE, || beat_error_ms(&a, &b, 140.0) < 15.0);
    assert!(
        followed.is_some(),
        "the follower did not take the leader's new phase"
    );

    // Leaving is announced: the other node is alone at once, not after the 3 s timeout.
    let left = Instant::now();
    b.stop();
    b.stop(); // twice is fine
    let alone = wait_until(Duration::from_millis(2_500), || a.status().peers == 0);
    assert!(
        alone.is_some(),
        "the leader still counts {} peers {:?} after the other left (the timeout alone is 3 s)",
        a.status().peers,
        left.elapsed()
    );
    assert!(!a.is_locked());
    assert!(a.status().leader);
    assert_eq!(a.snapshot().stats.malformed, 0);
    a.stop();
}

#[test]
fn nodes_with_different_pins_do_not_meet() {
    // A node only learns addresses from beacons with its own key, so two nodes with different
    // PINs cannot both be told about each other after they started. Three nodes, each address
    // taken from a node that already runs (no port is guessed or reserved):
    //   a (1234) sends to b (4321): b receives beacons with the other PIN;
    //   c (4321) sends to a (1234): a receives beacons with the other PIN.
    let with_pin = |peer_id: u64, pin: &str, peer: Option<&LinkNode>| {
        LinkNode::start(LinkConfig {
            peer_id,
            key: key_from_pin(pin).unwrap(),
            extra_peers: peer.map(|p| p.local_addr()).into_iter().collect(),
            ..LinkConfig::loopback(0)
        })
        .expect("a loopback node starts")
    };
    let b = with_pin(20, "4321", None);
    let a = with_pin(10, "1234", Some(&b));
    let c = with_pin(30, "4321", Some(&a));
    let heard = wait_until(PATIENCE, || {
        a.snapshot().stats.other_key >= 3 && b.snapshot().stats.other_key >= 3
    });
    assert!(
        heard.is_some(),
        "a node never received beacons with the other PIN: a {:?}, b {:?}",
        a.snapshot().stats,
        b.snapshot().stats
    );
    for node in [&a, &b, &c] {
        let s = node.snapshot();
        assert_eq!(s.clock.peers, 0);
        assert!(s.peers.is_empty());
        assert!(s.clock.leader && !s.locked && s.key_set);
        // Refused by the key check, not by the parser, and nothing got through.
        assert_eq!(
            (s.stats.malformed, s.stats.accepted),
            (0, 0),
            "{:?}",
            s.stats
        );
    }
    // The same PIN on both sides does meet.
    let (c, d) = pair(key_from_pin("1234").unwrap());
    let met = wait_until(PATIENCE, || c.is_locked() && d.is_locked());
    assert!(met.is_some());
}

// "This computer only": two instances started the way the app starts them with
// `bind = 127.0.0.1` (default port, default config) share the port range and find each other
// over loopback, with no multicast and no address that is not loopback.
#[test]
fn two_instances_bound_to_loopback_share_the_port_range_and_lock() {
    // A PIN of their own (per process): a Decks instance, or another run of this test, that
    // happens to use the same ports on this computer is in another session.
    let pin = format!("{:04}", std::process::id() % 10_000);
    let key = key_from_pin(&pin).unwrap();
    let start = |peer_id: u64, tempo: f64| {
        LinkNode::start(LinkConfig {
            bind: Ipv4Addr::LOCALHOST,
            peer_id,
            tempo,
            key,
            ..LinkConfig::default()
        })
    };
    let a = start(10, 128.0).expect("the first instance gets a port of the range 42029..=42032");
    let b = start(20, 120.0).expect("the second instance gets the next free port, not AddrInUse");
    let range = DEFAULT_PORT..DEFAULT_PORT + LOCAL_INSTANCES;
    for node in [&a, &b] {
        let addr = node.local_addr();
        assert!(addr.ip().is_loopback(), "{addr}");
        assert!(range.contains(&addr.port()), "{addr} outside {range:?}");
        assert!(!node.multicast(), "a loopback node announces on no group");
    }
    assert_ne!(a.local_addr().port(), b.local_addr().port());
    let locked = wait_until(PATIENCE, || {
        a.is_locked() && b.is_locked() && a.status().bpm == b.status().bpm
    });
    assert!(
        locked.is_some(),
        "the two instances never met: {:?} / {:?}",
        a.snapshot(),
        b.snapshot()
    );
    let (sa, sb) = (a.snapshot(), b.snapshot());
    assert_eq!((sa.clock.peers, sb.clock.peers), (1, 1));
    assert_eq!(sa.session_id, sb.session_id);
    assert!(sa.clock.leader != sb.clock.leader, "exactly one leads");
    // Every peer either of them knows is a loopback address.
    for p in sa.peers.iter().chain(&sb.peers) {
        assert!(p.addr.ip().is_loopback(), "{}", p.addr);
    }
}

#[test]
fn start_refuses_a_bad_tempo_and_a_taken_port() {
    for tempo in [f64::NAN, 0.0, 301.0, f64::INFINITY] {
        let err = LinkNode::start(LinkConfig {
            tempo,
            ..LinkConfig::loopback(0)
        })
        .expect_err("a bad tempo is refused before any socket opens");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{tempo}");
    }
    let first = LinkNode::start(LinkConfig::loopback(0)).unwrap();
    let port = first.local_addr().port();
    let err = LinkNode::start(LinkConfig::loopback(port)).expect_err("the port is taken");
    assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
    assert_eq!(first.local_addr().ip(), Ipv4Addr::LOCALHOST);
    assert_ne!(
        first.peer_id(),
        0,
        "an id is picked when the config has none"
    );
}

#[test]
fn garbage_on_the_socket_is_counted_and_harmless() {
    let node = LinkNode::start(LinkConfig::loopback(0)).unwrap();
    let socket = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    for len in [0usize, 1, 19, 20, 64, 65, 127, 128, 400] {
        let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + len) as u8).collect();
        socket.send_to(&bytes, node.local_addr()).unwrap();
    }
    let mut almost = b"MXLK\x01\x01".to_vec();
    almost.resize(64, 0xFF);
    socket.send_to(&almost, node.local_addr()).unwrap();
    let seen = wait_until(PATIENCE, || {
        let s = node.snapshot();
        s.stats.malformed + s.io_errors >= 10
    });
    assert!(seen.is_some(), "{:?}", node.snapshot());
    let s = node.snapshot();
    assert_eq!((s.clock.peers, s.stats.accepted), (0, 0));
    assert!(s.clock.leader && s.clock.bpm == 128.0 && s.clock.beat.is_finite());
}
