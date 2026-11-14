//! Loopback end-to-end: a real WebSocket client pairs, receives hello/state, sends controls, gets
//! acks/errors, and role checks hold. Runs the server on 127.0.0.1 with an ephemeral port.

use live_engine::{Control, Role, Session};
use live_remote::{RemoteConfig, RemoteServer};
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, TcpStream, UdpSocket};
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket, stream::MaybeTlsStream};

fn server() -> RemoteServer {
    RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        osc: false,
        engine_name: "Test".into(),
        secrets: None,
    })
    .unwrap()
}

fn osc_server() -> RemoteServer {
    RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        osc: true,
        engine_name: "Test".into(),
        secrets: None,
    })
    .unwrap()
}

fn osc_send(sock: &UdpSocket, port: u16, addr: &str, args: Vec<rosc::OscType>) {
    let pkt = rosc::OscPacket::Message(rosc::OscMessage {
        addr: addr.into(),
        args,
    });
    sock.send_to(&rosc::encoder::encode(&pkt).unwrap(), ("127.0.0.1", port))
        .unwrap();
}

/// Pump the engine side until `done` holds (or 2 s pass) and say whether it did.
fn pump_until(s: &RemoteServer, session: &mut Session, done: impl Fn(&Session) -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(2) {
        pump(s, session);
        if done(session) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn connect(
    s: &RemoteServer,
    token: &str,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, tungstenite::Error> {
    let url = format!("ws://127.0.0.1:{}/ws?t={token}&c=test-1", s.port());
    let (ws, _) = tungstenite::connect(url)?;
    if let MaybeTlsStream::Plain(t) = ws.get_ref() {
        t.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    }
    Ok(ws)
}

/// Read messages until `pred` matches one (pumping the engine side meanwhile).
fn wait_for(
    label: &str,
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    s: &RemoteServer,
    session: &mut Session,
    pred: impl Fn(&Value) -> bool,
) -> Value {
    let t0 = Instant::now();
    let mut seen: Vec<String> = Vec::new();
    loop {
        pump(s, session);
        match ws.read() {
            Ok(Message::Text(t)) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if pred(&v) {
                    return v;
                }
                seen.push(v.to_string());
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{label}: read error {e}; seen {seen:?}"),
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "{label}: timed out; seen {seen:?}"
        );
    }
}

/// The engine side of one tick.
fn pump(s: &RemoteServer, session: &mut Session) {
    let mut replies = Vec::new();
    for inc in s.drain() {
        let r = session.apply_control(inc.control, Instant::now());
        replies.push((
            inc.conn,
            inc.id,
            r.map(|_| ())
                .map_err(|e| (live_remote::server_error_code(&e), e.to_string())),
        ));
    }
    s.publish_state(&session.state());
    for (conn, id, r) in replies {
        s.reply(conn, id, r);
    }
}

#[test]
fn pair_control_and_roles() {
    let s = server();
    let mut session = Session::new(48000.0, 128);
    session.load_preset("Natural Vocal").unwrap();
    // Wrong token: HTTP 401, no upgrade.
    assert!(connect(&s, "deadbeef").is_err());

    let mut c = connect(&s, &s.token(Role::Controller)).unwrap();
    let hello = wait_for("L85", &mut c, &s, &mut session, |v| v["type"] == "hello");
    assert_eq!(hello["protocol"], 1);
    assert_eq!(hello["role"], "controller");
    assert_eq!(hello["engine_name"], "Test");
    let st = wait_for("L89", &mut c, &s, &mut session, |v| v["type"] == "state");
    assert_eq!(st["state"]["preset"], "Natural Vocal");

    c.send(Message::text(
        r#"{"type":"load_preset","name":"Hard Snap","id":5}"#,
    ))
    .unwrap();
    // The server publishes the new state before the ack (an ack means "state already sent").
    let st = wait_for("state-after-load", &mut c, &s, &mut session, |v| {
        v["type"] == "state" && v["state"]["preset"] == "Hard Snap"
    });
    assert!(st["state"]["chain"].as_array().unwrap().len() >= 5);
    let ack = wait_for("ack-load", &mut c, &s, &mut session, |v| v["type"] == "ack");
    assert_eq!(ack["id"], 5);

    c.send(Message::text(
        r#"{"type":"load_preset","name":"Nope","id":6}"#,
    ))
    .unwrap();
    let err = wait_for("L107", &mut c, &s, &mut session, |v| v["type"] == "error");
    assert_eq!(err["code"], "unknown_preset");
    assert_eq!(err["id"], 6);

    // A viewer may not change anything; the server refuses before the engine sees it.
    let mut v = connect(&s, &s.token(Role::Viewer)).unwrap();
    wait_for("L113", &mut v, &s, &mut session, |m| m["type"] == "hello");
    v.send(Message::text(r#"{"type":"next","id":1}"#)).unwrap();
    let e = wait_for("L115", &mut v, &s, &mut session, |m| m["type"] == "error");
    assert_eq!(e["code"], "forbidden");

    // Performer may change scenes / mix but not edit the chain.
    let mut p = connect(&s, &s.token(Role::Performer)).unwrap();
    wait_for("L120", &mut p, &s, &mut session, |m| m["type"] == "hello");
    p.send(Message::text(r#"{"type":"set_mix","mute":true,"id":2}"#))
        .unwrap();
    assert_eq!(
        wait_for("L124", &mut p, &s, &mut session, |m| m["type"] == "ack")["id"],
        2
    );
    assert!(session.mix.mute);
    p.send(Message::text(
        r#"{"type":"add_insert","fx":"reverb","at":0,"id":3}"#,
    ))
    .unwrap();
    assert_eq!(
        wait_for("L133", &mut p, &s, &mut session, |m| m["type"] == "error")["code"],
        "forbidden"
    );

    // Rotating the controller token disconnects the controller.
    s.rotate_token(Role::Controller);
    let t0 = Instant::now();
    loop {
        pump(&s, &mut session);
        match c.read() {
            Ok(Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                break;
            }
            Err(tungstenite::Error::Io(e))
                if e.kind() != std::io::ErrorKind::WouldBlock
                    && e.kind() != std::io::ErrorKind::TimedOut =>
            {
                break;
            }
            _ => {}
        }
        assert!(
            t0.elapsed() < Duration::from_secs(5),
            "controller not disconnected"
        );
    }
    let _ = Control::Next;
}

/// OSC is authorised by the key in the address and by nothing else: a datagram from loopback
/// (the address the old code trusted as controller) without the key changes nothing.
#[test]
fn osc_needs_a_key_even_from_loopback() {
    use rosc::OscType::Float;
    let s = osc_server();
    let port = s.osc_port().unwrap();
    let mut session = Session::new(48000.0, 128);
    session.load_preset("Natural Vocal").unwrap();
    let sock = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    let performer = s.osc_key(Role::Performer).unwrap();
    let controller = s.osc_key(Role::Controller).unwrap();
    assert_ne!(performer, controller);
    assert_ne!(
        performer,
        s.token(Role::Performer),
        "key must not be the pairing token"
    );
    assert!(s.osc_key(Role::Viewer).is_none());

    // A paired controller is connected from 127.0.0.1: its address must grant nothing.
    let mut c = connect(&s, &s.token(Role::Controller)).unwrap();
    let hello = wait_for("osc-hello", &mut c, &s, &mut session, |v| {
        v["type"] == "hello"
    });
    assert_eq!(hello["osc"]["port"], port);
    assert_eq!(hello["osc"]["controller_key"], controller.as_str());
    assert_eq!(hello["osc"]["performer_key"], performer.as_str());

    let wrong = "0123456789abcdef0123456789abcdef";
    osc_send(&sock, port, "/live/mix/main", vec![Float(-20.0)]);
    osc_send(
        &sock,
        port,
        &format!("/{wrong}/live/mix/main"),
        vec![Float(-20.0)],
    );
    osc_send(&sock, port, "/live/bypass", vec![Float(1.0)]);
    assert!(
        !pump_until(&s, &mut session, |x| x.mix.main_db != 0.0 || x.mix.bypass),
        "an OSC datagram without the key changed the mix"
    );

    // Performer key: mix yes, chain parameters no.
    let gate = session.state().chain[0].id;
    let before = session.state().chain[0].params.clone();
    osc_send(
        &sock,
        port,
        &format!("/{performer}/live/mix/main"),
        vec![Float(-20.0)],
    );
    assert!(pump_until(&s, &mut session, |x| x.mix.main_db == -20.0));
    osc_send(
        &sock,
        port,
        &format!("/{performer}/live/fx/{gate}/threshold"),
        vec![Float(-30.0)],
    );
    assert!(
        !pump_until(&s, &mut session, |x| x.state().chain[0].params != before),
        "the performer key edited the chain"
    );

    // Controller key: chain parameters too.
    osc_send(
        &sock,
        port,
        &format!("/{controller}/live/fx/{gate}/threshold"),
        vec![Float(-30.0)],
    );
    assert!(pump_until(&s, &mut session, |x| x.state().chain[0].params != before));

    // A viewer gets no key at all.
    let mut v = connect(&s, &s.token(Role::Viewer)).unwrap();
    let hello = wait_for("osc-viewer", &mut v, &s, &mut session, |m| {
        m["type"] == "hello"
    });
    assert!(hello.get("osc").is_none(), "{hello}");
    // A performer gets only its own.
    let mut p = connect(&s, &s.token(Role::Performer)).unwrap();
    let hello = wait_for("osc-perf", &mut p, &s, &mut session, |m| {
        m["type"] == "hello"
    });
    assert_eq!(hello["osc"]["performer_key"], performer.as_str());
    assert!(hello["osc"].get("controller_key").is_none(), "{hello}");

    // Rotating the role token retires its OSC key.
    s.rotate_token(Role::Performer);
    assert_ne!(s.osc_key(Role::Performer).unwrap(), performer);
    osc_send(
        &sock,
        port,
        &format!("/{performer}/live/mix/main"),
        vec![Float(-40.0)],
    );
    assert!(!pump_until(&s, &mut session, |x| x.mix.main_db == -40.0));
}

#[test]
fn osc_is_off_unless_asked_for() {
    let s = server();
    assert_eq!(s.osc_port(), None);
    assert!(s.osc_key(Role::Controller).is_none());
    assert!(!RemoteConfig::default().osc);
    assert!(!live_remote::HostConfig::default().osc);
    let mut session = Session::new(48000.0, 128);
    session.load_preset("Natural Vocal").unwrap();
    let mut c = connect(&s, &s.token(Role::Controller)).unwrap();
    let hello = wait_for("no-osc", &mut c, &s, &mut session, |v| v["type"] == "hello");
    assert!(hello.get("osc").is_none(), "{hello}");
}

#[test]
fn health_and_catalogue_over_http() {
    use std::io::{Read, Write};
    let s = server();
    for (path, needle) in [
        ("/health", "\"protocol\":1"),
        ("/api/fx", "\"autotune\""),
        ("/", "<html"),
    ] {
        let mut t = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
        write!(t, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut body = String::new();
        t.read_to_string(&mut body).unwrap();
        assert!(
            body.starts_with("HTTP/1.1 200"),
            "{path}: {}",
            &body[..40.min(body.len())]
        );
        assert!(body.contains(needle), "{path}");
        assert!(body.contains("Content-Security-Policy"));
    }
}

/// A host that keeps its pairings on disk hands them to the server, so a restart keeps every device
/// paired; and one device can be revoked without touching the others.
#[test]
fn supplied_pairings_are_reused_and_one_can_be_revoked() {
    let set = live_remote::TokenSet {
        pairings: vec![
            live_remote::SeedPairing {
                token: "controller-1".into(),
                role: Role::Controller,
                label: "laptop".into(),
            },
            live_remote::SeedPairing {
                token: "viewer-1".into(),
                role: Role::Viewer,
                label: "tv".into(),
            },
        ],
        osc_keys: ["osc-p".into(), "osc-c".into()],
    };
    let s = RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        osc: false,
        engine_name: "Test".into(),
        secrets: Some(set),
    })
    .unwrap();
    // Both seeded tokens work, and the missing role got one so the pairing URLs still point
    // somewhere.
    assert_eq!(s.token(Role::Controller), "controller-1");
    assert_eq!(s.token(Role::Viewer), "viewer-1");
    assert_ne!(s.token(Role::Performer), "");
    assert_eq!(s.pairings().len(), 3);

    // Mint one more device and revoke exactly it.
    let extra = s
        .add_pairing(Role::Performer, "second phone")
        .expect("room");
    assert_eq!(s.pairings().len(), 4);
    assert_eq!(extra.label, "second phone");
    assert!(s.revoke_pairing(extra.id));
    assert!(
        !s.revoke_pairing(extra.id),
        "revoking twice is not an error, just false"
    );
    assert_eq!(s.pairings().len(), 3);
    assert_eq!(
        s.token(Role::Viewer),
        "viewer-1",
        "the others are untouched"
    );
}

/// A control flood must not be able to take the panic button away: PANIC is exempt from the
/// per-second cap (200), so it lands even when the same client is flooding the server. The test
/// also insists that the cap actually engaged, so it cannot pass by sending nothing.
#[test]
fn a_flood_does_not_eat_the_panic() {
    use std::io::ErrorKind::{TimedOut, WouldBlock};

    let s = server();
    let mut session = Session::new(48000.0, 128);
    session.load_preset("Natural Vocal").unwrap();
    let mut p = connect(&s, &s.token(Role::Performer)).unwrap();
    wait_for("flood-hello", &mut p, &s, &mut session, |m| {
        m["type"] == "hello"
    });

    for i in 0..260u32 {
        p.send(Message::text(format!(
            r#"{{"type":"set_mix","main_db":-1.0,"id":{i}}}"#
        )))
        .unwrap();
    }
    p.send(Message::text(r#"{"type":"panic","id":9000}"#))
        .unwrap();

    let mut saw_limited = false;
    let mut panic_acked = false;
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(5) && !(saw_limited && panic_acked) {
        pump(&s, &mut session);
        match p.read() {
            Ok(Message::Text(t)) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["code"] == "rate_limited" {
                    saw_limited = true;
                }
                if v["type"] == "ack" && v["id"] == 9000 {
                    panic_acked = true;
                }
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), WouldBlock | TimedOut) => {}
            Err(e) => panic!("flood read: {e}"),
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(saw_limited, "the flood must have hit the rate cap");
    assert!(panic_acked, "the panic must get through the flood");
    assert!(session.mix.panic, "the panic is latched in the state");
}

/// Raw connections are capped before a thread is spawned, so the count must not leak: after far
/// more short-lived connections than the cap, the server must still answer.
#[test]
fn many_short_connections_do_not_exhaust_the_cap() {
    use std::io::{Read as _, Write as _};

    let s = server();
    for _ in 0..(live_remote::server::MAX_CONNS + 20) {
        let t = TcpStream::connect(("127.0.0.1", s.port())).unwrap();
        drop(t);
    }
    let mut ok = false;
    for _ in 0..40 {
        let Ok(mut t) = TcpStream::connect(("127.0.0.1", s.port())) else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        t.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        if write!(t, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
            continue;
        }
        let mut body = String::new();
        let _ = t.read_to_string(&mut body);
        if body.starts_with("HTTP/1.1 200") {
            ok = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        ok,
        "the connection cap leaked and the server stopped answering"
    );
}

/// Pairing is per device now: a controller mints one for a new phone, sees the list, and revoking
/// that one device drops only its socket — the other devices keep their tokens.
#[test]
fn a_controller_pairs_and_revokes_one_device() {
    use std::io::ErrorKind::{TimedOut, WouldBlock};

    let s = server();
    let mut session = Session::new(48000.0, 128);
    session.load_preset("Natural Vocal").unwrap();
    let mut c = connect(&s, &s.token(Role::Controller)).unwrap();
    wait_for("pair-hello", &mut c, &s, &mut session, |m| {
        m["type"] == "hello"
    });
    // The list arrives on connect: one seeded pairing per role.
    let d = wait_for("devices-on-connect", &mut c, &s, &mut session, |m| {
        m["type"] == "devices"
    });
    assert_eq!(d["devices"].as_array().unwrap().len(), 3);

    // A performer may not mint one.
    let mut perf = connect(&s, &s.token(Role::Performer)).unwrap();
    wait_for("perf-hello", &mut perf, &s, &mut session, |m| {
        m["type"] == "hello"
    });
    perf.send(Message::text(r#"{"type":"pair","role":"viewer","id":3}"#))
        .unwrap();
    let e = wait_for("pair-forbidden", &mut perf, &s, &mut session, |m| {
        m["type"] == "error"
    });
    assert_eq!(e["code"], "forbidden");

    // A controller mints a device and the whole list comes back.
    c.send(Message::text(
        r#"{"type":"pair","role":"performer","label":"guitar phone","id":1}"#,
    ))
    .unwrap();
    let ack = wait_for("pair-ack", &mut c, &s, &mut session, |m| {
        m["type"] == "ack" && m["id"] == 1
    });
    let new_id = ack["pairing"].as_u64().expect("the ack names the pairing");
    let d = wait_for("devices-after-pair", &mut c, &s, &mut session, |m| {
        m["type"] == "devices" && m["devices"].as_array().unwrap().len() == 4
    });
    let token = d["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["label"] == "guitar phone")
        .and_then(|p| p["token"].as_str())
        .expect("the new pairing is listed with its token")
        .to_string();

    // That token pairs the new device...
    let mut phone = connect(&s, &token).unwrap();
    wait_for("phone-hello", &mut phone, &s, &mut session, |m| {
        m["type"] == "hello"
    });

    // ... and revoking exactly it drops that socket, leaving the controller alone.
    c.send(Message::text(format!(
        r#"{{"type":"unpair","device":{new_id},"id":2}}"#
    )))
    .unwrap();
    let ack = wait_for("unpair-ack", &mut c, &s, &mut session, |m| {
        m["type"] == "ack" && m["id"] == 2
    });
    assert_eq!(ack["revoked"], 1);
    let t0 = Instant::now();
    let mut closed = false;
    while t0.elapsed() < Duration::from_secs(3) {
        pump(&s, &mut session);
        match phone.read() {
            Ok(Message::Close(_))
            | Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                closed = true;
                break;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), WouldBlock | TimedOut) => {}
            Err(_) => {
                closed = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(closed, "the revoked device must be disconnected");
    assert!(
        !s.pairings().iter().any(|p| p.id == new_id),
        "it is gone from the list"
    );
}
