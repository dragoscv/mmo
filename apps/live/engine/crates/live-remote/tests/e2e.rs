//! Loopback end-to-end: a real WebSocket client pairs, receives hello/state, sends controls, gets
//! acks/errors, and role checks hold. Runs the server on 127.0.0.1 with an ephemeral port.

use live_engine::{Control, Role, Session};
use live_remote::{RemoteConfig, RemoteServer};
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr, TcpStream};
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
        r#"{"type":"load_preset","name":"Hard Tune","id":5}"#,
    ))
    .unwrap();
    // The server publishes the new state before the ack (an ack means "state already sent").
    let st = wait_for("state-after-load", &mut c, &s, &mut session, |v| {
        v["type"] == "state" && v["state"]["preset"] == "Hard Tune"
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
