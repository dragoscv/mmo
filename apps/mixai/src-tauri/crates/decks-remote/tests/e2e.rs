//! Real sockets on loopback: pages, auth, roles, commands, state push, party flow, token rotation.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpStream};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use decks_remote::{
    DEAD_AFTER, MAX_CLIENTS, OVERLAY_READ_ONLY, OnAirTrack, RemoteCommand, RemoteConfig,
    RemoteDeck, RemoteServer, RemoteState, RequestStatus, Role, ServerMsg, is_token,
};
use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

/// Every wait in this file ends as soon as what it waits for happens; only a failure takes
/// this long. Generous because the suite also runs while the machine is saturated by builds.
const LIMIT: Duration = Duration::from_secs(20);

/// What a client's reader thread hands to the test.
enum Heard {
    Msg(ServerMsg),
    /// The server closed the socket (a close frame, or the connection is gone).
    Closed,
}

/// A WebSocket client that behaves like a browser tab: a thread of its own keeps reading, so
/// the server's pings are answered whether or not the test is looking at this socket.
///
/// Why not a plain socket: one that nobody reads from sends no pong, and the server drops a
/// device that stays silent for `DEAD_AFTER` (5 s). A test that holds two sockets and waits
/// on one of them loses the other when the machine is slow enough (seen: three tests red in
/// one run of thirty while builds saturated the CPU, each with "connection aborted" on the
/// socket it had parked). A real page never parks: the browser answers pings by itself.
///
/// Dropping the client says goodbye (close frame) and ends the thread.
struct Ws {
    inbox: mpsc::Receiver<Heard>,
    out: mpsc::Sender<String>,
}

fn server() -> RemoteServer {
    RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ..Default::default()
    })
    .unwrap()
}

fn get(port: u16, path: &str) -> String {
    get_host(port, path, &format!("127.0.0.1:{port}"))
}

/// `GET path` with the `Host` header as given.
fn get_host(port: u16, path: &str, host: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

fn connect(port: u16, token: &str, client: &str) -> Result<Ws, tungstenite::Error> {
    let (mut ws, _) =
        tungstenite::connect(format!("ws://127.0.0.1:{port}/ws?t={token}&c={client}"))?;
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        // Short: between two reads the thread sends what the test queued.
        s.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
    }
    let (heard, inbox) = mpsc::channel::<Heard>();
    let (out, queued) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        loop {
            // What the test wants sent, in order; the test dropping the client = leave.
            loop {
                match queued.try_recv() {
                    Ok(json) => {
                        if ws.send(Message::text(json)).is_err() {
                            let _ = heard.send(Heard::Closed);
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        return;
                    }
                }
            }
            match ws.read() {
                Ok(Message::Text(t)) => {
                    let msg = serde_json::from_str(t.as_str())
                        .unwrap_or_else(|e| panic!("not a server message ({e}): {t}"));
                    let _ = heard.send(Heard::Msg(msg));
                }
                Ok(Message::Close(_)) => {
                    // The answer to the close frame is queued by the read: let it leave.
                    let _ = ws.flush();
                    let _ = heard.send(Heard::Closed);
                    return;
                }
                // A ping: the read queued the pong, the next read or flush sends it.
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    let _ = ws.flush();
                }
                Err(_) => {
                    let _ = heard.send(Heard::Closed);
                    return;
                }
            }
        }
    });
    Ok(Ws { inbox, out })
}

/// The next message the server sent to this client. Panics when none comes within [`LIMIT`]
/// (a message that never comes fails the test instead of hanging it) or the socket closed.
fn recv(ws: &mut Ws) -> ServerMsg {
    match ws.inbox.recv_timeout(LIMIT) {
        Ok(Heard::Msg(m)) => m,
        Ok(Heard::Closed) | Err(RecvTimeoutError::Disconnected) => {
            panic!("the server closed the socket")
        }
        Err(RecvTimeoutError::Timeout) => panic!("no message within {LIMIT:?}"),
    }
}

/// Read until `pred` matches (skipping other pushes), within [`LIMIT`].
fn until(ws: &mut Ws, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
    let end = Instant::now() + LIMIT;
    while Instant::now() < end {
        let m = recv(ws);
        if pred(&m) {
            return m;
        }
    }
    panic!("expected message not received");
}

fn send(ws: &mut Ws, json: &str) {
    ws.out
        .send(json.to_string())
        .expect("the client is still there");
}

fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + LIMIT;
    while Instant::now() < end {
        if let Some(v) = f() {
            return v;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out");
}

#[test]
fn serves_pages_with_security_headers_and_404s() {
    let s = server();
    let page = get(s.port(), "/");
    assert!(page.starts_with("HTTP/1.1 200"));
    assert!(page.contains("Content-Security-Policy: default-src 'none'"));
    assert!(page.contains("X-Frame-Options: DENY"));
    assert!(page.contains("MixAI Decks Remote"));
    assert!(get(s.port(), "/party").contains("MixAI Party"));
    let now = get(s.port(), "/now?t=whatever&align=right");
    assert!(now.starts_with("HTTP/1.1 200"), "{}", &now[..40]);
    assert!(now.contains("Content-Type: text/html; charset=utf-8"));
    assert!(now.contains("Content-Security-Policy: default-src 'none'"));
    assert!(now.contains("X-Frame-Options: DENY"));
    assert!(now.contains("Cache-Control: no-store"));
    assert!(now.contains("MixAI Now playing"));
    assert!(get(s.port(), "/now/").starts_with("HTTP/1.1 404"));
    assert!(get(s.port(), "/tokens.css").contains("--background"));
    assert!(get(s.port(), "/health").ends_with("ok"));
    assert!(get(s.port(), "/nope").starts_with("HTTP/1.1 404"));
    assert!(
        get(s.port(), "/ws?t=bad").starts_with("HTTP/1.1 404"),
        "no upgrade"
    );
    // The pages answer to an address or `localhost`, never to a DNS name (a name that
    // resolves to this computer is how a page on another site would reach it).
    let port = s.port();
    for by_address in [
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
        "192.168.1.20".to_string(),
    ] {
        let now = get_host(port, "/now", &by_address);
        assert!(now.starts_with("HTTP/1.1 200"), "{by_address}");
        assert!(now.contains("MixAI Now playing"), "{by_address}");
    }
    for by_name in [
        format!("evil.example:{port}"),
        format!("my-pc.local:{port}"),
        format!("127.0.0.1.evil.example:{port}"),
    ] {
        for path in ["/now", "/", "/party", "/health", "/tokens.css", "/nope"] {
            let refused = get_host(port, path, &by_name);
            assert!(
                refused.starts_with("HTTP/1.1 403") && refused.ends_with("host"),
                "{by_name} {path}: {}",
                refused.lines().next().unwrap_or("")
            );
            // The refusal carries the same headers as every answer, and no page.
            assert!(refused.contains("X-Frame-Options: DENY"));
            assert!(!refused.contains("<html"));
        }
    }
}

#[test]
fn wrong_token_and_foreign_origin_are_refused() {
    let s = server();
    assert!(connect(s.port(), "00000000000000000000000000000000", "x").is_err());
    let mut raw = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
    let t = s.token(Role::Controller);
    write!(
        raw,
        "GET /ws?t={t} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://evil.example\r\n\r\n",
        s.port()
    )
    .unwrap();
    let mut out = String::new();
    raw.read_to_string(&mut out).unwrap();
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
    assert!(out.ends_with("origin"), "{out}");
    // The same socket request from a page whose own DNS name points here: its origin IS its
    // host, so the origin check passes; the host check refuses it, right code or not.
    for t in [s.token(Role::Controller), s.overlay_token()] {
        let mut raw = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
        write!(
            raw,
            "GET /ws?t={t} HTTP/1.1\r\nHost: evil.example:{0}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://evil.example:{0}\r\n\r\n",
            s.port()
        )
        .unwrap();
        let mut out = String::new();
        raw.read_to_string(&mut out).unwrap();
        assert!(
            out.starts_with("HTTP/1.1 403") && out.ends_with("host"),
            "{out}"
        );
    }
    assert!(s.clients().is_empty());
}

#[test]
fn controller_commands_reach_the_app_validated_and_state_is_pushed() {
    let s = server();
    let mut c = connect(s.port(), &s.token(Role::Controller), "phone-1").unwrap();
    match recv(&mut c) {
        ServerMsg::Hello { role, client, .. } => {
            assert_eq!(role, Role::Controller);
            assert_eq!(client, "phone-1");
        }
        m => panic!("{m:?}"),
    }
    send(
        &mut c,
        r#"{"type":"command","command":{"cmd":"play","deck":1}}"#,
    );
    send(
        &mut c,
        r#"{"type":"command","command":{"cmd":"volume","deck":0,"value":3.0}}"#,
    );
    send(
        &mut c,
        r#"{"type":"command","command":{"cmd":"play","deck":9}}"#,
    );
    let err = until(&mut c, |m| matches!(m, ServerMsg::Error { .. }));
    assert!(matches!(err, ServerMsg::Error { reason } if reason.contains("deck 9")));
    let cmds = wait_for(|| {
        let v = s.drain_commands();
        (!v.is_empty()).then_some(v)
    });
    let mut all = cmds;
    if all.len() < 2 {
        all.extend(wait_for(|| {
            let v = s.drain_commands();
            (!v.is_empty()).then_some(v)
        }));
    }
    assert_eq!(
        all,
        vec![
            ("phone-1".to_string(), RemoteCommand::Play { deck: 1 }),
            (
                "phone-1".to_string(),
                RemoteCommand::Volume {
                    deck: 0,
                    value: 1.0
                }
            ),
        ]
    );
    s.publish(RemoteState {
        decks: vec![RemoteDeck {
            deck: 0,
            title: Some("Strobe".into()),
            playing: true,
            volume: 1.0,
            ..Default::default()
        }],
        master_bpm: 128.0,
        ..Default::default()
    });
    let st = until(
        &mut c,
        |m| matches!(m, ServerMsg::State { state } if state.master_bpm == 128.0),
    );
    assert!(
        matches!(st, ServerMsg::State { state } if state.decks[0].title.as_deref() == Some("Strobe"))
    );
    assert_eq!(s.clients().len(), 1);
    assert_eq!(s.clients()[0].role, Role::Controller);
}

#[test]
fn viewer_and_guest_cannot_control_decks() {
    let s = server();
    for role in [Role::Viewer, Role::Guest] {
        let mut ws = connect(s.port(), &s.token(role), "x1").unwrap();
        recv(&mut ws);
        send(
            &mut ws,
            r#"{"type":"command","command":{"cmd":"play","deck":0}}"#,
        );
        until(
            &mut ws,
            |m| matches!(m, ServerMsg::Error { reason } if reason.contains("cannot control")),
        );
    }
    assert!(s.drain_commands().is_empty());
}

#[test]
fn party_flow_request_merge_vote_moderate() {
    let s = server();
    let guest_token = s.token(Role::Guest);
    let mut g1 = connect(s.port(), &guest_token, "g1").unwrap();
    let mut g2 = connect(s.port(), &guest_token, "g2").unwrap();
    let mut dj = connect(s.port(), &s.token(Role::Controller), "dj").unwrap();
    recv(&mut g1);
    recv(&mut g2);
    recv(&mut dj);
    s.publish(RemoteState {
        decks: vec![RemoteDeck {
            deck: 0,
            title: Some("Levels".into()),
            artist: Some("Avicii".into()),
            playing: true,
            volume: 1.0,
            ..Default::default()
        }],
        ..Default::default()
    });
    until(
        &mut g1,
        |m| matches!(m, ServerMsg::NowPlaying { titles } if titles == &vec!["Avicii — Levels".to_string()]),
    );
    send(
        &mut g1,
        r#"{"type":"request","title":"Strobe","artist":"deadmau5"}"#,
    );
    let id = match until(&mut g1, |m| matches!(m, ServerMsg::Requested { .. })) {
        ServerMsg::Requested { id, merged } => {
            assert!(!merged);
            id
        }
        _ => unreachable!(),
    };
    send(
        &mut g2,
        r#"{"type":"request","title":"strobe","artist":"Deadmau5"}"#,
    );
    until(&mut g2, |m| {
        matches!(m, ServerMsg::Requested { merged: true, .. })
    });
    let votes = wait_for(|| {
        s.requests()
            .first()
            .filter(|r| r.votes == 2)
            .map(|r| r.votes)
    });
    assert_eq!(votes, 2);
    send(
        &mut dj,
        &format!(r#"{{"type":"moderate","id":{id},"action":"accept"}}"#),
    );
    until(
        &mut g1,
        |m| matches!(m, ServerMsg::Requests { items, .. } if items.iter().any(|r| r.id == id && r.status == RequestStatus::Accepted && r.mine)),
    );
    // Guests cannot moderate.
    send(
        &mut g2,
        &format!(r#"{{"type":"moderate","id":{id},"action":"reject"}}"#),
    );
    until(
        &mut g2,
        |m| matches!(m, ServerMsg::Error { reason } if reason.contains("only the DJ")),
    );
    // Closing requests reaches guests.
    s.set_party_open(false);
    until(&mut g2, |m| {
        matches!(
            m,
            ServerMsg::Requests {
                party_open: false,
                ..
            }
        )
    });
    send(&mut g2, r#"{"type":"request","title":"Late"}"#);
    until(
        &mut g2,
        |m| matches!(m, ServerMsg::Error { reason } if reason.contains("closed")),
    );
}

#[test]
fn rotating_a_token_disconnects_that_role_only() {
    let s = server();
    let mut viewer = connect(s.port(), &s.token(Role::Viewer), "v").unwrap();
    let mut ctl = connect(s.port(), &s.token(Role::Controller), "c").unwrap();
    recv(&mut viewer);
    recv(&mut ctl);
    let old = s.token(Role::Viewer);
    let new = s.rotate_token(Role::Viewer);
    assert_ne!(old, new);
    assert!(
        closed_by_server(&mut viewer),
        "viewer disconnected after rotation"
    );
    assert!(connect(s.port(), &old, "v").is_err());
    let mut v2 = connect(s.port(), &new, "v").unwrap();
    assert!(matches!(recv(&mut v2), ServerMsg::Hello { .. }));
    send(&mut ctl, r#"{"type":"ping"}"#);
    until(&mut ctl, |m| matches!(m, ServerMsg::Pong));
}

// ---- stream overlay (`/now`, WP19-59) ----

fn track(id: &str, title: &str, artist: Option<&str>) -> OnAirTrack {
    OnAirTrack {
        id: id.into(),
        title: Some(title.into()),
        artist: artist.map(str::to_string),
    }
}

fn on_air(title: Option<&str>, artist: Option<&str>) -> ServerMsg {
    ServerMsg::OnAir {
        title: title.map(str::to_string),
        artist: artist.map(str::to_string),
    }
}

/// Whether the server closes this socket within [`LIMIT`] (messages still on their way are
/// read past). It does so within a session poll (30 ms); the wait ends at once when the
/// socket closes, and a socket that stays open fails the caller after the limit.
fn closed_by_server(ws: &mut Ws) -> bool {
    let end = Instant::now() + LIMIT;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        match ws.inbox.recv_timeout(left) {
            Ok(Heard::Closed) | Err(RecvTimeoutError::Disconnected) => return true,
            Ok(Heard::Msg(_)) => {}
            Err(RecvTimeoutError::Timeout) => return false,
        }
    }
}

#[test]
fn the_overlay_code_is_kept_when_well_formed_and_replaced_when_not() {
    let cfg = || RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ..Default::default()
    };
    let saved = "00112233445566778899aabbccddeeff";
    let s = RemoteServer::start_with_overlay(cfg(), Some(saved.into())).unwrap();
    assert_eq!(s.overlay_token(), saved);
    assert_eq!(
        s.overlay_url(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        format!("http://127.0.0.1:{}/now?t={saved}", s.port())
    );
    let mut o = connect(s.port(), saved, "obs").unwrap();
    assert_eq!(recv(&mut o), on_air(None, None));
    // Anything that is not exactly a token is not taken over: a fresh code is made instead.
    for bad in [
        "",
        "short",
        "00112233445566778899AABBCCDDEEFF",
        "00112233445566778899aabbccddeeff0",
        "0011223344556677+899aabbccddeeff",
        "00112233445566778899aabbccddeef&",
    ] {
        let s = RemoteServer::start_with_overlay(cfg(), Some(bad.into())).unwrap();
        let t = s.overlay_token();
        assert_ne!(t, bad);
        assert!(is_token(&t), "{t}");
        assert!(
            connect(s.port(), bad, "obs").is_err(),
            "{bad:?} opens nothing"
        );
    }
    // No code given: a fresh one per start, never a role's code.
    let (a, b) = (server(), server());
    assert!(is_token(&a.overlay_token()));
    assert_ne!(a.overlay_token(), b.overlay_token());
    for role in [Role::Controller, Role::Viewer, Role::Guest] {
        assert_ne!(a.overlay_token(), a.token(role));
    }
}

#[test]
fn an_overlay_hears_the_on_air_track_at_connect_and_on_change_and_nothing_else() {
    let s = server();
    s.publish_on_air(Some(track("t1", "Strobe", Some("deadmau5"))));
    let mut o = connect(s.port(), &s.overlay_token(), "obs").unwrap();
    // No hello: the first message is what is on air right now.
    assert_eq!(recv(&mut o), on_air(Some("Strobe"), Some("deadmau5")));
    let listed = s.clients();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].overlay, "listed as a stream overlay");
    assert_eq!(
        (listed[0].id.as_str(), listed[0].role),
        ("obs", Role::Viewer)
    );
    // Everything the other pages are told about happens: deck state, the request queue, the
    // party switch, the controls lock. A second screen next to the overlay does get the state.
    let mut viewer = connect(s.port(), &s.token(Role::Viewer), "tv").unwrap();
    let mut guest = connect(s.port(), &s.token(Role::Guest), "g").unwrap();
    recv(&mut viewer);
    recv(&mut guest);
    assert!(s.clients().iter().filter(|c| !c.overlay).count() == 2);
    s.publish(RemoteState {
        decks: vec![RemoteDeck {
            deck: 0,
            title: Some("Levels".into()),
            artist: Some("Avicii".into()),
            playing: true,
            volume: 1.0,
            ..Default::default()
        }],
        master_bpm: 126.0,
        ..Default::default()
    });
    until(
        &mut viewer,
        |m| matches!(m, ServerMsg::State { state } if state.master_bpm == 126.0),
    );
    until(&mut guest, |m| matches!(m, ServerMsg::NowPlaying { .. }));
    send(&mut guest, r#"{"type":"request","title":"One More Time"}"#);
    until(&mut guest, |m| matches!(m, ServerMsg::Requested { .. }));
    s.set_party_open(false);
    s.set_controls_locked(true);
    until(&mut guest, |m| {
        matches!(
            m,
            ServerMsg::Requests {
                party_open: false,
                ..
            }
        )
    });
    // The same track again (a new object, a doubled track with another id): not a change.
    s.publish_on_air(Some(track("t1", "Strobe", Some("deadmau5"))));
    s.publish_on_air(Some(track("t1-on-deck-b", "Strobe", Some("deadmau5"))));
    // Several session polls later, the next thing the overlay ever receives is the next
    // on-air change: none of the above reached it.
    std::thread::sleep(Duration::from_millis(250));
    s.publish_on_air(Some(track("t2", "Levels", None)));
    assert_eq!(recv(&mut o), on_air(Some("Levels"), None));
    s.publish_on_air(None);
    assert_eq!(recv(&mut o), on_air(None, None));
    // An overlay that joins while nothing is on air is told so at once.
    let mut late = connect(s.port(), &s.overlay_token(), "obs2").unwrap();
    assert_eq!(recv(&mut late), on_air(None, None));
}

#[test]
fn an_overlay_cannot_command_request_vote_or_moderate() {
    let s = server();
    let mut guest = connect(s.port(), &s.token(Role::Guest), "g").unwrap();
    recv(&mut guest);
    send(&mut guest, r#"{"type":"request","title":"Strobe"}"#);
    let id = match until(&mut guest, |m| matches!(m, ServerMsg::Requested { .. })) {
        ServerMsg::Requested { id, .. } => id,
        _ => unreachable!(),
    };
    let mut o = connect(s.port(), &s.overlay_token(), "obs").unwrap();
    assert_eq!(recv(&mut o), on_air(None, None));
    for refused in [
        r#"{"type":"command","command":{"cmd":"play","deck":0}}"#.to_string(),
        r#"{"type":"command","command":{"cmd":"master_volume","value":0}}"#.to_string(),
        r#"{"type":"command","command":{"cmd":"cue","deck":0,"pressed":false}}"#.to_string(),
        r#"{"type":"request","title":"From the overlay"}"#.to_string(),
        format!(r#"{{"type":"vote","id":{id}}}"#),
        format!(r#"{{"type":"moderate","id":{id},"action":"reject"}}"#),
    ] {
        send(&mut o, &refused);
        // The very next message is the refusal (an overlay is sent nothing unasked here).
        assert_eq!(
            recv(&mut o),
            ServerMsg::Error {
                reason: OVERLAY_READ_ONLY.to_string()
            },
            "{refused}"
        );
    }
    send(&mut o, r#"{"type":"ping"}"#);
    assert_eq!(recv(&mut o), ServerMsg::Pong);
    // Nothing reached the app: no command, and the queue is as the guest left it.
    assert!(s.drain_commands().is_empty());
    let requests = s.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        (requests[0].votes, requests[0].status),
        (1, RequestStatus::Pending)
    );
}

#[test]
fn a_new_overlay_code_disconnects_the_overlay_and_only_it() {
    let s = server();
    let mut o = connect(s.port(), &s.overlay_token(), "obs").unwrap();
    let mut ctl = connect(s.port(), &s.token(Role::Controller), "c").unwrap();
    let mut viewer = connect(s.port(), &s.token(Role::Viewer), "v").unwrap();
    assert_eq!(recv(&mut o), on_air(None, None));
    recv(&mut ctl);
    recv(&mut viewer);
    // A new code for a role leaves the overlay connected.
    s.rotate_token(Role::Viewer);
    assert!(closed_by_server(&mut viewer), "the viewer is disconnected");
    s.publish_on_air(Some(track("t1", "Strobe", None)));
    assert_eq!(recv(&mut o), on_air(Some("Strobe"), None));
    // A new overlay code: the overlay goes, the phone stays.
    let old = s.overlay_token();
    let new = s.rotate_overlay_token();
    assert_ne!(old, new);
    assert!(is_token(&new));
    assert_eq!(s.overlay_token(), new);
    assert!(closed_by_server(&mut o), "the overlay is disconnected");
    assert!(
        connect(s.port(), &old, "obs").is_err(),
        "the old code is refused"
    );
    let mut o2 = connect(s.port(), &new, "obs").unwrap();
    assert_eq!(recv(&mut o2), on_air(Some("Strobe"), None));
    send(&mut ctl, r#"{"type":"ping"}"#);
    until(&mut ctl, |m| matches!(m, ServerMsg::Pong));
    assert_eq!(s.token(Role::Controller).len(), 32);
    let left: Vec<(String, bool)> = s.clients().into_iter().map(|c| (c.id, c.overlay)).collect();
    assert_eq!(left, [("c".to_string(), false), ("obs".to_string(), true)]);
}

#[test]
fn overlays_count_against_the_device_limit() {
    let s = server();
    let token = s.overlay_token();
    // Every client answers the server's pings by itself (see `Ws`), so none of the 48 is
    // dropped as silent however long the test takes.
    let mut overlays: Vec<_> = (0..MAX_CLIENTS)
        .map(|i| connect(s.port(), &token, &format!("obs-{i}")).unwrap())
        .collect();
    assert_eq!(s.clients().len(), MAX_CLIENTS);
    // Full: a phone with the right code is turned away (and an overlay too).
    assert!(connect(s.port(), &s.token(Role::Controller), "phone").is_err());
    assert!(connect(s.port(), &token, "one-more").is_err());
    assert_eq!(
        s.clients().len(),
        MAX_CLIENTS,
        "nobody was dropped to make room"
    );
    // One overlay leaves: the phone gets in.
    drop(overlays.pop());
    wait_for(|| (s.clients().len() == MAX_CLIENTS - 1).then_some(()));
    let mut phone = connect(s.port(), &s.token(Role::Controller), "phone").unwrap();
    assert!(matches!(recv(&mut phone), ServerMsg::Hello { .. }));
}

#[test]
fn a_silent_overlay_is_dropped_like_any_other_device() {
    let s = server();
    let start = Instant::now();
    // An OBS that froze or left the network: the socket stays open, nothing is read or answered.
    let mut dead = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
    write!(
        dead,
        "GET /ws?t={}&c=frozen HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        s.overlay_token(),
        s.port()
    )
    .unwrap();
    wait_for(|| (s.clients().len() == 1).then_some(()));
    assert!(s.clients()[0].overlay);
    let end = Instant::now() + DEAD_AFTER + Duration::from_secs(4);
    while !s.clients().is_empty() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    let took = start.elapsed();
    assert!(s.clients().is_empty(), "the silent overlay is dropped");
    assert!(
        took >= DEAD_AFTER - Duration::from_secs(1),
        "not before {DEAD_AFTER:?}: {took:?}"
    );
    drop(dead);
}
