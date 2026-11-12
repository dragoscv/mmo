# Tempo sync between Decks instances (LAN)

Status: built in the desktop app (Tauri) on 2026-11-11, tracker WP19-29; review fixes the same day (tempo lock
while a deck is the master, session re-founding after the leader drops, TTL 1 on every datagram, loopback port
range, follower-only nudge); re-review fixes on 2026-11-12 (a node bound to one LAN address stops and frees its
port with the interface down, a peer younger than one ping interval is never pushed out of a full peer table, a
start that overlaps the app's exit no longer leaves a node without its goodbye). Crate
`apps/mixai/src-tauri/crates/decks-link`, shell module
`apps/mixai/src-tauri/src/link.rs`, UI `apps/mixai/src/link/`.
The native Compose and SwiftUI apps do not expose it yet (the crate has no UI or engine dependency, so a port only
needs the FFI surface).

Two or more computers that run MixAI Decks on the same network share one tempo, one beat count and one bar phase,
so their decks play in time. The protocol is MixAI's own (MIT OR Apache-2.0, written from scratch). Ableton Link is
GPL: it is not linked, and its messages and wire format are not imitated. A Decks session is therefore **not**
visible to Link-enabled apps.

## Using it

1. Status bar, right side: **LINK**. The dot is a ring while sync is off.
2. Click it, optionally type a 4-digit **PIN**, press **Start**. Do the same on the other computer (same PIN, or
   both empty).
3. The dot is half-filled while the instance is alone or still measuring ("Searching") and filled once it is
   locked to another instance ("Locked"). The chip shows how many other instances are in the session and the role:
   **LEADER** or **FOLLOW**.
4. Turn **SYNC** on for the decks that should follow the shared clock. Tempo sync moves the master clock; a deck
   without SYNC keeps its own tempo.

| Control | What it does |
|---|---|
| Start / Stop | Joins or leaves the session. Stopping puts the master clock source back to what it was, unless you picked another source since: your later choice stands. |
| PIN | Four digits, or empty for an open session. Read when sync starts. A grouping code (same PIN = same session), not a password: see Security. |
| Session BPM, Peers, Offset | Session tempo, other instances in the session, clock offset to the leader in ms (0 on the leader). |
| Propose tempo | Asks the leader for a tempo (20..300 BPM). On the leader it also sets the internal clock tempo. Off while a deck is the leader's master clock: the session tempo is then that deck's tempo, the popover says so on every instance, and a proposal is refused ("the session tempo follows the playing deck") instead of being taken and put back. |
| Nudge −¼ / +¼ | A follower's control: shifts this instance against the session by a quarter beat (stays within half a bar). The session and the other instances do not move. Off on the leader, with the reason shown: the leader's clock is the session, so a shift there would move every follower the other way. To move the whole session, move the leader's master deck (jog, pitch bend). |
| Re-align | Aligns every playing deck to the master clock again (the same as pressing SYNC on each). |

What the roles mean for the engine:

- **Leader**: this instance's master clock is the session. Whatever drives it (a playing deck with a beatgrid, or
  the internal clock) is announced to the others. While the internal clock drives, a tempo proposed by any
  instance sets it. While a deck drives, the tempo is the deck's: proposals are refused and nobody hears another
  tempo in between. The instance that started the session leads it; an instance that joins later follows, whatever
  its id, until the leader leaves.
- **Follower**: the master clock source is switched to `internal` (the master clock panel shows it) and the
  internal clock is steered to the session. While sync runs the source stays `internal`; a source you pick in
  the master clock panel meanwhile is remembered and comes back when sync stops. A follower that takes over as
  leader keeps the nudge it had (nobody jumps at the change) and cannot change it while it leads.
  One case cannot be told apart: **while following, the clock source shown is Internal; the source you had
  before comes back when sync stops**, also when Internal is what you want to keep. The panel already shows
  Internal, so there is nothing to pick, and the engine keeps no record of who set its source. To stay on the
  internal clock after a session, pick Internal once more after pressing Stop.

While sync runs the LINK item always stays in the status bar (on a narrow window only its peer count and role word
give way), so Stop is always one click away.

The first Start makes Windows ask whether MixAI Decks may receive connections ("Windows Security" firewall
question). Allow it on private networks; without it the instance sends but never hears the others.

Closing the app while sync runs says goodbye to the session: the others drop this instance at once.

## Session model

- A **peer** is one running instance. It has a random 64-bit id and a monotonic clock in microseconds that no
  other peer shares.
- A **session** is a set of peers that agree on one timeline: a tempo (20..=300 BPM) and a beat count that advances
  with it. The bar (quantum) is 4 beats.
- The **leader** holds the timeline: its clock is the session, a follower converts it to its own clock. There are
  no election messages; every beacon carries a flag "I lead". Rules, the same on every peer:
  - the peer that founded a session leads it (it never joined anybody);
  - a peer that joins a session follows the member that says it leads, whatever the ids: a joiner never takes
    the lead from a playing founder;
  - when the leader leaves and nobody says it leads, the lowest id left takes over, on the same timeline;
  - if two members say they lead (two sessions merged in an unusual order), the lower id stays.
- **Clock offset**: each peer pings every other peer (200 ms apart until it has four samples, then once a second).
  Ping and pong carry four timestamps, as in NTP: offset = ((t2 − t1) + (t3 − t4)) / 2, round trip =
  (t4 − t1) − (t3 − t2). Per peer the 8 latest samples are kept, none older than 10 s, and the one with the shortest
  round trip is used. A pong only counts when it answers a ping that was really sent to that peer. A peer that
  leaves 10 pings in a row unanswered is pinged once a second from then on (and gets one unicast beacon a second);
  its first answer brings the fast rate back.
- **Joining**: a peer starts alone, in its own session (id = its own id). When it hears another session, one of
  the two gives way, by a rule both sides evaluate alike: a peer that started less than 2 s ago and is still alone
  gives way; else the session with more members stays (members heard within the last second count); else the one
  with the lower session id. The joining peer takes the beat of the session it joins and never changes it, and
  reports `leader = false` for 500 ms after joining in any case.
- **Tempo change**: any peer may propose a tempo (`SetTempo`). The leader applies it at the moment the proposal
  arrives, without moving the beat, and its next beacons carry it to everybody. A follower repeats the proposal
  every 200 ms for up to 1 s until the leader's beacons show it. **Tempo lock**: while the leader's own clock is
  a playing deck, its beacons carry the flag "tempo locked"; the leader refuses proposals (and its own
  `set_tempo`), and a follower that sees the flag refuses to propose. Nothing is retimed, so no instance hears a
  tempo that the deck would overrule a moment later.
- **Leaving**: a peer that stops sends `Bye`; the others drop it at once. A peer that vanishes is dropped after 3 s
  without a beacon. When the leader goes, the lowest id left leads on the same timeline.
- **A leader that drops and comes back** (Wi-Fi loss): when the leader times out (no `Bye`), the peers left go on
  under a **new session id** that each of them computes from the old id and the id of the lost leader, so they
  agree without a message. For 1 s a member that still announces the old id is read as a member of the new one.
  The returning peer still announces the old id, so it is another session and the joining rule decides: it has
  fewer members, it joins the others and takes their tempo and beat. With one peer on each side the original
  session id is the lower one, so the returning leader's timeline stays. (Before this fix the session id never
  changed, the returning leader was "in session" at once and pulled everybody back to its own timeline.)

Measured in the crate's simulation (unit test, injected clocks): with a 20 ms one-way delay and clocks 1 000 000 µs
apart, a follower's beat is within 1 ms of the leader's after 1 s of exchange at 128 BPM, and stays there.

Measured on 2026-11-11 on one Windows PC with a real audio engine and two nodes over loopback UDP (shell tests,
clocks 3 s apart, 30 samples over 1.5 s each):

| Run | Following engine vs the leader's beat | Following node vs a leading engine |
|---|---|---|
| 14:02 | median +0.07 ms, worst 5.66 ms, 0 re-steers | median 0.22 ms, worst 4.97 ms |
| 14:12 (other builds running on the PC) | median +0.21 ms, worst 113.08 ms, 2 re-steers | median 1.15 ms, worst 629.48 ms |
| 20:48 (other builds running; unit tests of the crate took 8.3 s instead of 0.16 s) | median −0.07 ms, worst 21.34 ms, 1 re-steer | median 12.39 ms, worst 480.55 ms |
| 21:03 | median −0.20 ms, worst 1.15 ms | median 0.27 ms, worst 0.87 ms |
| 22:11 (two-thread node) | median +0.19 ms, worst 0.97 ms | median 0.17 ms, worst 1.16 ms |

On a quiet machine the median is a few tenths of a millisecond. On a loaded one single samples are out by tens
to hundreds of milliseconds, and at 20:48 the median of one 1.5 s window was 12 ms. Those large samples were not
investigated; a stalled audio callback would produce them (the engine's beat stops while the session keeps
counting), but that is an assumption, not a finding. The two tests therefore wait, for at most 10 s, for a 1.5 s
window whose median is inside 10 ms: an error that is always there (a wrong phase, a buffer of offset) still
fails them, a loaded machine does not.

## Constants

| Constant | Value |
|---|---|
| Multicast group | `239.255.42.29` (IPv4, administratively scoped), TTL 1 |
| UDP port | `42029`; further instances on the same computer use `42030`..`42032` |
| Beacon interval | 200 ms (5 per second) |
| Peer timeout | 3 s without a beacon |
| Ping interval | 200 ms until 4 samples exist, then 1 s; 1 s for a peer with 10 unanswered pings in a row |
| Clock samples | 8 kept per peer, none older than 10 s, lowest round trip wins; a round trip above 2 s is dropped |
| Quantum | 4 beats |
| Tempo range | 20..=300 BPM |
| Settle time after joining | 500 ms |
| Newborn time | 2 s |
| Peers tracked | 32; when full, the oldest peer that never answered a ping makes room for a new one, but none heard for less than 200 ms (one ping interval) |
| Read timeout of the listening socket | none; 400 ms for a node bound to one LAN address (see Transport, Stopping a node) |
| IP TTL | 1 on every datagram, unicast and multicast |
| Members counted when two sessions meet | those heard within the last 1 s |
| Largest datagram | 64 bytes |

## Transport

- IPv4 UDP only. Beacons go to the multicast group and, by unicast, to every peer already known (multicast is
  often filtered on Wi-Fi; once two peers know each other they no longer depend on it) and to every configured
  extra peer. Ping, pong and tempo proposals are unicast.
- Answers go to the source IP address of a peer's beacons, on the port the beacon names (`reply_port`).
- Every socket sends with IP TTL 1 (unicast and multicast): no router forwards a datagram of the protocol, also
  not an answer to a beacon whose source address was forged.
- The Rust standard library cannot share a UDP port between processes and cannot choose the outgoing interface
  of a multicast datagram. So: the listening socket binds `0.0.0.0:42029` and joins the group on the default
  interface and on the LAN interface (the address of the default route); group datagrams leave from a second socket
  bound to the LAN address; a second instance on the same computer listens on the next port and all local instances
  also announce to `127.0.0.1:42029`..`42032`.
- **This computer only** (`bind = 127.0.0.1`): the same port range, on loopback. Up to four instances find each
  other through `127.0.0.1:42029`..`42032`; there is no multicast and no datagram leaves for another address.
- **No network at start**: when the computer has no route yet (the LAN address resolves to loopback), the node
  runs without the group and the status says so (`multicast: false`, the popover shows "Not announced on the
  network"). It looks for a LAN address again every 5 s and joins the group when there is one, without a restart.
- A node has two threads. The receiver blocks in `recv_from` with no timeout and stamps the clock the moment a
  datagram wakes it (measured on Windows: 0.15 ms after the datagram arrives); answers leave at once. The timer
  wakes every 20 ms and sends what is due. Callers never wait for the network.
- **Stopping a node.** The standard library cannot cancel a blocking read, so Stop sets a flag and wakes the
  receiver with a one-byte datagram from the node's own socket to its own port. A node that listens on every
  interface or on `127.0.0.1` sends that datagram over loopback, which is always there. A node bound to **one LAN
  address** (`bind = 192.168.1.20`) can only send from that address: with its interface down (Wi-Fi off, which is
  when somebody presses Stop) the OS refuses the datagram. Before 2026-11-12 the receiver then slept on with the
  port, and the next Start on that address failed with "address in use" until the app restarted. Now such a node
  reads with a standing 400 ms timeout, so its receiver sees the flag about that much later (0.9 s was seen once
  on a PC busy with other builds), ends, and the port is free. Only that bind mode has the timeout (and with it
  the small loss described in the next point, for a
  datagram that arrives in the instant the timeout fires; it only fires after 400 ms of silence, and a member
  sends five beacons a second). The app's popover starts sync on every interface, so it never uses that mode;
  `link_start` with a `bind` does. Measured on loopback on 2026-11-12 (Windows 11, std sockets, one PC busy with
  other builds): a read that is already blocked does not see a timeout set afterwards from another thread (6 of
  6 still blocked 1.5 s after a 20 ms timeout was set), so setting one at Stop alone would not help; a receiver
  with a standing 400 ms timeout got 40 of 40 datagrams at beacon cadence (3 timeouts in 10 s) and 93 of 95 from
  a sender that sends when its own 400 ms timeout fires (the worst case). A receiver that cannot be ended within
  3 s is left behind and counted (`decks_link::stuck_receivers()`); with the standing timeout that should not
  happen.
- Why not one thread with a 20 ms read timeout (the first design): on Windows a datagram that arrives while the
  timeout of a blocking receive fires can be dropped. Measured on loopback on 2026-11-11 (std sockets, one PC): a
  receiver with a 20 ms read timeout lost 5 of 494 datagrams from a sender that sends when its own 20 ms timeout
  fires, a receiver without a timeout 0 of 510 from the same sender, and the timeout receiver 0 of 232 when the
  sender sent between two timer ticks. Two instances on one computer wake on the same tick: with the first
  design the loopback tests failed in 6 of 160 runs (a tempo proposal sent five times, none arrived, no thread
  stalled). Between two computers the timers are not aligned for long, so the effect there would have been
  rarer; it was not measured.

## Wire format (version 1)

Little-endian, fixed length per kind. A datagram whose length is not exactly the length of its kind is refused.

Header, 20 bytes:

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 4 | magic | `MXLK` |
| 4 | 1 | version | 1 |
| 5 | 1 | kind | 1 beacon, 2 ping, 3 pong, 4 set tempo, 5 bye |
| 6 | 1 | flags | beacon: bit 0 = newborn (started under 2 s ago, alone); bit 1 = the sender leads its session; bit 2 = the sender's tempo follows a playing deck (only meaningful with bit 1); other bits ignored |
| 7 | 1 | reserved | 0 when sent, ignored when read |
| 8 | 4 | key | u32, 0 = open session |
| 12 | 8 | peer_id | u64, never 0 |

Body (offsets from the start of the datagram):

| Kind | Total length | Fields |
|---|---|---|
| Beacon | 64 | 20 `session_id` u64 · 28 `tempo` f64 (BPM) · 36 `beat` f64 · 44 `t_origin` u64 (sender clock, µs, at which `beat` holds) · 52 `t_send` u64 (sender clock, µs) · 60 `reply_port` u16 (0 = source port) · 62 `quantum` u8 (4) · 63 `members` u8 (peers in the sender's session, itself included) |
| Ping | 32 | 20 `seq` u32 · 24 `t_send` u64 |
| Pong | 48 | 20 `seq` u32 · 24 `t_send` u64 (echo of the ping) · 32 `t_recv` u64 · 40 `t_reply` u64 |
| SetTempo | 44 | 20 `session_id` u64 · 28 `bpm` f64 · 36 `at_beat` f64 (the proposer's session beat; informative) |
| Bye | 28 | 20 `session_id` u64 |

Refused: another magic, version or kind; a wrong length; an id of 0; a tempo that is not finite or outside
20..=300; a beat that is not finite or beyond ±1e9; a time stamp above 2^60; a beacon whose `t_origin` is more than
one hour from its `t_send` or whose quantum is not 4. Decoding never panics (tests: round trip, every truncation
length, every padded length, 120 000 fuzzed datagrams).

## Security

- **One network segment.** Every datagram the node sends, to the group or to one address, has IP TTL 1, so no
  router forwards it, and there is no relay server. The feature is meant for a trusted network (your own router,
  a hotspot between two laptops), not for venue or public Wi-Fi.
- **Answers go to an address that can be forged.** A node answers a beacon at the beacon's source IP address and
  the port the beacon names; UDP source addresses are not verified. What bounds the effect: TTL 1 keeps every
  answer on the segment; a peer that never answers a ping gets five beacons and five pings a second for about
  2 s, then one of each per second; a forged peer is forgotten 3 s after its last beacon; at most 32 peers are
  tracked. So one forged beacon costs a victim on the same segment about 20 small datagrams per instance. A
  sender that keeps the same 32 forged identities alive holds about 64 datagrams a second per instance on the
  victim; one that keeps inventing new identities (each starts at the fast rate) can hold up to 32 × 10 = 320
  a second per instance, at most 64 bytes each (about 20 kB/s). It cannot be aimed at a host beyond the first
  router, and whoever can do this is on the segment already and could send that traffic directly.
- **No authentication, no encryption.** Any device on the network segment that speaks the protocol can join an
  open session and set its tempo (unless a deck is the leader's master); one that sends beacons saying it leads,
  with a lower id than the leader, takes the timeline and controls the beat as well. Nothing but tempo, beat and
  phase travels: no audio, no track names, no library data.
- **The PIN is a grouping code, not a password.** A 4-digit PIN gives the session a 32-bit key (FNV-1a over
  `MXLK-pin:` and the digits, never 0); every datagram carries it and datagrams with another key are ignored. No
  PIN = key 0 = open session. It keeps two groups of DJs on one network apart, and other people's instances out
  of your session by accident. It does not keep anyone out who wants in: the key travels in clear and there are
  only 10 000 PINs. The app words it that way too ("Same PIN = same session. A grouping code, not a password.").
- **Input handling.** Every datagram is bounds-checked and range-checked before use; malformed ones are counted
  and dropped. A flood cannot grow memory (at most 32 peers, 8 samples and 8 open pings per peer, 64 queued pongs).
  When the peer table is full, the oldest peer that never answered a ping is dropped for a newcomer, so made-up
  ids cannot keep real instances out for good (a peer whose clock was measured is never dropped for one). A peer
  heard for less than 200 ms is not dropped either: a real newcomer needs one round trip to answer its first
  ping, and before 2026-11-12 a sender that invented ids faster than that could push it out again before the
  answer arrived. When every unmeasured peer is that young, the newcomer is refused instead and gets in with a
  later beacon (it sends one every 200 ms). What is left to a flood: while it lasts, a full table takes at most
  one newcomer per slot that falls free, and a real newcomer competes with the made-up ids for it, so joining can
  take several beacons; once in, it is measured within one round trip and stays.
- **What a hostile device on the segment can do** to a session it can reach: make the followers play at any tempo
  within 20..=300 BPM and at any phase, make instances join and leave sessions, and have each instance send the
  bounded traffic above to an address on the same segment. It cannot run code, read anything but tempo, beat and
  phase, or reach beyond the segment through this protocol.

## API

Crate `decks-link` (no dependency, MSRV 1.87):

- `LinkSession`: the state machine, no sockets. `new(peer_id, local_tempo)` / `with_key`, `on_datagram(bytes, from,
  now_us)`, `tick(now_us) -> Vec<Outgoing>`, `clock_at(now_us) -> LinkClock { bpm, beat, phase_in_quantum, peers,
  leader, offset_us, tempo_locked }`, `set_tempo` (false while the tempo is locked), `set_tempo_locked(bool)`
  (the app says whether its own clock is a playing deck), `set_local_clock(bpm, beat, now_us)` (used while
  leading; small differences are taken gradually so audio-callback jitter does not reach the followers),
  `nudge(delta_beats, now_us)` (false while this peer holds the timeline), `is_locked`, `leave`.
- `LinkNode`: sockets and two threads (receiver, timer). `start(LinkConfig { multicast_addr, port, bind, peer_id, tempo, key,
  extra_peers, local_instances, clock })`, `stop`, `status`, `clock_at`, `set_tempo`, `set_tempo_locked`,
  `feed_local_clock`, `nudge`, `multicast`, `snapshot`. `LinkConfig::loopback(port)` = `127.0.0.1`, one port, no
  multicast (tests, demos); `LinkConfig { bind: 127.0.0.1, ..default }` = this computer only, port range shared.
- `key_from_pin("1234")`, `random_peer_id()`, `lan_ip()`, `stuck_receivers()` (receiver threads a stop could not
  end, in this process; 0 when healthy).

Tauri commands (`src-tauri/src/link.rs`); the event `link://state` carries the same `LinkStatus` at 4 Hz while
sync runs and once when it stops:

| Command | Arguments | Returns |
|---|---|---|
| `link_status` | — | `LinkStatus { running, locked, leader, peers, bpm, beat, phase, offsetUs, pinSet, nudgeBeats, hostUs, multicast, port, pending, tempoLocked }` |
| `link_start` | `pin?` (4 digits), `bind?` (IPv4, default every interface; `127.0.0.1` = this computer only), `port?` (default 42029) | `LinkStatus`, or `could not start tempo sync: <reason>` (the address or port cannot be bound; `the app is closing` once the app began to exit) |
| `link_stop` | — | `LinkStatus` |
| `link_set` | `bpm?` (20..300), `nudgeBeats?` (±4) | `LinkStatus`, or an error and nothing changed: `tempo follows the playing deck` (a `bpm` while `tempoLocked`), `nudge is not available while this instance leads` (a `nudgeBeats` while `leader`), `bpm must be within 20..300`, `nudge must be within -4..4 beats`, `tempo sync is not running` |

The UI maps those error texts to sentences (`src/link/link-math.ts` `errorKey`); `src/link/contract.test.ts` reads
`link.rs` and fails when a text, a status field, a command parameter or the event name no longer match.

The shell pump runs every 50 ms on the engine time base (`mixai_core::host_micros()`): every tick it tells the node
whether the engine's master clock is a deck (`tempoLocked`); while leading it feeds
`engine.clock_state()` to the node; while following it sets the clock source to `internal` and calls
`engine.steer_internal_clock(bpm, beat, host_us)` when the tempo differs, when the phase is off by more than
20 ms, or when the median of the last 7 measurements is off by more than 2 ms. In between the internal clock runs on
the sample clock. `engine.clock_state()` returns beat, tempo, source and time stamp of one audio callback (the
reader checks the stamp before and after and retries; it used to be able to pair the beat of one block with the
stamp of the next, one buffer apart). Stopping, restarting and closing the app stop the node thread outside the
state and engine locks. Start and Stop hold a lifecycle lock for their whole length; the exit hook does not wait
for it (an exit must not hang on a start that is opening sockets): it sets a "closing" flag, then takes and
stops the running node. A start that was creating its node at that moment finds the flag when it comes to store
the node, stops that node itself (goodbye included) and answers `the app is closing`; the hook then gives a
start or stop that is in flight up to 500 ms to finish, so that goodbye leaves before the process ends. Before
2026-11-12 such a node was stored after the hook had run and left without a goodbye.

## Limits

- IPv4 only; one network segment; no relay over the internet.
- Not compatible with Ableton Link, MIDI clock or Pro DJ Link (MIDI clock is separate: see
  [mapping-format.md](mapping-format.md)).
- Audio output latency is not compensated between computers: two machines with different buffer sizes are apart
  by the difference of their output latencies. Nudge on the follower covers what the ear hears.
- A follower's master clock is the internal clock, so a deck cannot be the master clock source there while sync
  runs.
- Stopping sync on a follower puts back the clock source it had before, also when the DJ would have wanted to
  stay on Internal: while following the panel already shows Internal, so that wish cannot be expressed, and the
  engine does not record who set its source (see Using it, Follower). Telling the two apart needs the master
  clock command of the shell to report the DJ's choice to the sync module; not built.
- The stop path of a node bound to one LAN address with its interface down is tested on loopback with the
  wake-up datagram switched off in the test (the tests listen on `127.0.0.1` only); a real interface going down
  was not tried. On Linux and macOS the same code runs; the measurement that a blocked read ignores a later
  timeout was made on Windows only.
- While a deck is the leader's master clock nobody can set the session tempo from the popover; the leader's DJ
  moves the deck's tempo fader.
- The LAN address is looked up when sync starts (and every 5 s until there is one). If the computer moves to
  another network while sync runs, stop and start sync.
- The goodbye on closing the app is wired to the app's exit event; no test runs a real app exit, so until it was
  seen once on two instances it is expected behaviour, not a measured one. Without it the others drop the
  instance after the 3 s timeout, as before.
- The beacon flags "leads" and "tempo locked" were added the day the feature was built, before any release
  carried it; the wire version stayed 1. A build from before that change (none was shipped, per the round's
  brief) would be followed only by the lowest-id rule.
- Tests cover the protocol in simulation and two real nodes over loopback UDP. As of 2026-11-11 the multicast path
  of the node (listening on `0.0.0.0`, joining the group, the second sending socket, the retry when the network
  comes up late) has not been executed once, and two computers were never tried: listening on a LAN address makes
  Windows ask its firewall question, which the tests avoid on purpose. The port range for several instances is
  exercised on loopback (`two_instances_bound_to_loopback_share_the_port_range_and_lock`). That TTL 1 is really
  on the wire was not captured; the code sets it and fails the start when the OS refuses.
