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
    })
    .unwrap()
}

fn osc_server() -> RemoteServer {
    RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        osc: true,
        engine_name: "Test".into(),
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
