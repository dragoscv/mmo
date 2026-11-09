//! Real sockets on loopback: pages, auth, roles, commands, state push, party flow, token rotation.

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpStream};
use std::time::{Duration, Instant};

use decks_remote::{
    RemoteCommand, RemoteConfig, RemoteDeck, RemoteServer, RemoteState, RequestStatus, Role,
    ServerMsg,
};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

fn server() -> RemoteServer {
    RemoteServer::start(RemoteConfig {
        bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
        ..Default::default()
    })
    .unwrap()
}

fn get(port: u16, path: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).unwrap();
    out
}

fn connect(port: u16, token: &str, client: &str) -> Result<Ws, tungstenite::Error> {
    let (ws, _) = tungstenite::connect(format!("ws://127.0.0.1:{port}/ws?t={token}&c={client}"))?;
    if let MaybeTlsStream::Plain(s) = ws.get_ref() {
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    }
    Ok(ws)
}

fn recv(ws: &mut Ws) -> ServerMsg {
    loop {
        match ws.read().expect("message") {
            Message::Text(t) => return serde_json::from_str(t.as_str()).unwrap(),
            Message::Close(_) => panic!("closed"),
            _ => {}
        }
    }
}

/// Read until `pred` matches (skipping other pushes), within 5 s.
fn until(ws: &mut Ws, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        let m = recv(ws);
        if pred(&m) {
            return m;
        }
    }
    panic!("expected message not received");
}

fn send(ws: &mut Ws, json: &str) {
    ws.send(Message::text(json.to_string())).unwrap();
}

fn wait_for<T>(mut f: impl FnMut() -> Option<T>) -> T {
    let end = Instant::now() + Duration::from_secs(5);
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
    assert!(get(s.port(), "/tokens.css").contains("--background"));
    assert!(get(s.port(), "/health").ends_with("ok"));
    assert!(get(s.port(), "/nope").starts_with("HTTP/1.1 404"));
    assert!(
        get(s.port(), "/ws?t=bad").starts_with("HTTP/1.1 404"),
        "no upgrade"
    );
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
    let end = Instant::now() + Duration::from_secs(5);
    let closed = loop {
        match viewer.read() {
            Ok(Message::Close(_)) | Err(_) => break true,
            Ok(_) if Instant::now() < end => {}
            Ok(_) => break false,
        }
    };
    assert!(closed, "viewer disconnected after rotation");
    assert!(connect(s.port(), &old, "v").is_err());
    let mut v2 = connect(s.port(), &new, "v").unwrap();
    assert!(matches!(recv(&mut v2), ServerMsg::Hello { .. }));
    send(&mut ctl, r#"{"type":"ping"}"#);
    until(&mut ctl, |m| matches!(m, ServerMsg::Pong));
}
