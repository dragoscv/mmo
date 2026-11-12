//! OSC over UDP: low-latency faders/buttons from control surfaces (TouchOSC, Lemur...).
//!
//! Off by default. Every address starts with an OSC key: `/<key>/live/...`. The key decides the
//! role (performer or controller); the sender's address grants nothing, loopback included — any
//! local process and any host on the Wi-Fi can send a datagram with a forged source.

use std::net::UdpSocket;
use std::sync::Arc;
use std::time::{Duration, Instant};

use live_engine::Control;
use rosc::{OscPacket, OscType};

use crate::server::{Incoming, Inner};

/// Accepted OSC messages per second, all senders together (a fader sends ~60/s).
pub const MAX_OSC_PER_SEC: u32 = 400;

/// One-second window over the messages that already passed the key and role checks (a flood
/// without a valid key never reaches it, so it cannot starve a real surface). PANIC always passes.
pub(crate) struct Limiter {
    window: Instant,
    count: u32,
}

impl Limiter {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            window: now,
            count: 0,
        }
    }

    pub(crate) fn allow(&mut self, now: Instant, control: &Control) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            self.window = now;
            self.count = 0;
        }
        self.count = self.count.saturating_add(1);
        self.count <= MAX_OSC_PER_SEC || *control == Control::Panic
    }
}

/// Split `/<key>/live/...` into the key and the `/live/...` address. The key has the shape of
/// `token::new_token` (32 hex chars); anything else is not an authenticated address.
pub fn split_key(addr: &str) -> Option<(&str, &str)> {
    let rest = addr.strip_prefix('/')?;
    let cut = rest.find('/')?;
    let (key, tail) = rest.split_at(cut);
    (key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()) && tail.starts_with("/live/"))
        .then_some((key, tail))
}

fn f(args: &[OscType], i: usize) -> Option<f32> {
    match args.get(i)? {
        OscType::Float(v) => Some(*v),
        OscType::Double(v) => Some(*v as f32),
        OscType::Int(v) => Some(*v as f32),
        OscType::Long(v) => Some(*v as f32),
        OscType::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Map an OSC address (without its key) + args to a control (`None` = unknown / malformed).
pub fn to_control(addr: &str, args: &[OscType]) -> Option<Control> {
    let parts: Vec<&str> = addr.trim_start_matches('/').split('/').collect();
    let mix = |field: &str, v: f32| {
        let mut c = Control::SetMix {
            input_db: None,
            main_db: None,
            monitor_db: None,
            monitor_dry: None,
            bypass: None,
            mute: None,
        };
        if let Control::SetMix {
            input_db,
            main_db,
            monitor_db,
            monitor_dry,
            ..
        } = &mut c
        {
            match field {
                "input" => *input_db = Some(v),
                "main" => *main_db = Some(v),
                "monitor" => *monitor_db = Some(v),
                "monitor_dry" => *monitor_dry = Some(v),
                _ => return None,
            }
        }
        Some(c)
    };
    let flag = |bypass: bool, on: bool| Control::SetMix {
        input_db: None,
        main_db: None,
        monitor_db: None,
        monitor_dry: None,
        bypass: bypass.then_some(on),
        mute: (!bypass).then_some(on),
    };
    match parts.as_slice() {
        ["live", "mix", field] => mix(field, f(args, 0)?),
        ["live", "bypass"] => Some(flag(true, f(args, 0).unwrap_or(1.0) > 0.5)),
        ["live", "mute"] => Some(flag(false, f(args, 0).unwrap_or(1.0) > 0.5)),
        ["live", "scene", "next"] => Some(Control::Next),
        ["live", "scene", "prev"] => Some(Control::Prev),
        ["live", "goto"] => Some(Control::Goto {
            song: f(args, 0)? as u32,
            part: f(args, 1).unwrap_or(0.0) as u32,
        }),
        ["live", "tap"] => Some(Control::TapTempo),
        ["live", "panic"] => Some(Control::Panic),
        ["live", "fx", insert, "enabled"] => Some(Control::SetEnabled {
            insert: insert.parse().ok()?,
            on: f(args, 0)? > 0.5,
        }),
        ["live", "fx", insert, param] => Some(Control::SetParam {
            insert: insert.parse().ok()?,
            param: (*param).to_string(),
            value: f(args, 0)?,
        }),
        _ => None,
    }
}

fn walk(p: OscPacket, out: &mut Vec<(String, Vec<OscType>)>) {
    match p {
        OscPacket::Message(m) => out.push((m.addr, m.args)),
        OscPacket::Bundle(b) => {
            for c in b.content {
                walk(c, out);
            }
        }
    }
}

/// Receiver thread. The read has NO timeout: on Windows a datagram that arrives while a timed
/// read expires can be lost, and `/live/panic` travels here. `RemoteServer::stop` sets the flag
/// and wakes the read with a datagram to this socket's own port.
pub(crate) fn run(sock: UdpSocket, inner: Arc<Inner>) {
    let mut buf = [0u8; 4096];
    let mut limiter = Limiter::new(Instant::now());
    while !inner.stopped() {
        let Ok((n, peer)) = sock.recv_from(&mut buf) else {
            // A persistent socket error must not spin a core.
            std::thread::sleep(Duration::from_millis(10));
            continue;
        };
        if inner.stopped() {
            break;
        }
        let Ok((_, packet)) = rosc::decoder::decode_udp(&buf[..n]) else {
            continue;
        };
        let mut msgs = Vec::new();
        walk(packet, &mut msgs);
        for (addr, args) in msgs {
            let Some((key, rest)) = split_key(&addr) else {
                continue;
            };
            let Some(role) = inner.osc_role(key) else {
                continue;
            };
            let Some(control) = to_control(rest, &args) else {
                continue;
            };
            if role < control.required_role() {
                continue;
            }
            if !limiter.allow(Instant::now(), &control) {
                continue;
            }
            inner.push_incoming(Incoming {
                conn: 0,
                client: format!("osc:{}", peer.ip()),
                role,
                id: None,
                control,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_addresses() {
        assert!(matches!(
            to_control("/live/mix/monitor", &[OscType::Float(-6.0)]),
            Some(Control::SetMix { monitor_db: Some(v), .. }) if v == -6.0
        ));
        assert!(matches!(
            to_control("/live/bypass", &[OscType::Int(1)]),
            Some(Control::SetMix {
                bypass: Some(true),
                ..
            })
        ));
        assert_eq!(to_control("/live/scene/next", &[]), Some(Control::Next));
        assert_eq!(
            to_control("/live/fx/12/threshold", &[OscType::Float(-20.0)]),
            Some(Control::SetParam {
                insert: 12,
                param: "threshold".into(),
                value: -20.0
            })
        );
        assert_eq!(
            to_control("/live/fx/x/threshold", &[OscType::Float(1.0)]),
            None
        );
        assert_eq!(to_control("/other", &[]), None);
    }

    #[test]
    fn addresses_need_a_key() {
        let key = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            split_key(&format!("/{key}/live/mix/main")),
            Some((key, "/live/mix/main"))
        );
        // No key, short key, non-hex key, key not followed by /live/.
        assert_eq!(split_key("/live/mix/main"), None);
        assert_eq!(split_key("/0123/live/mix/main"), None);
        assert_eq!(
            split_key("/0123456789abcdef0123456789abcdeg/live/panic"),
            None
        );
        assert_eq!(split_key(&format!("/{key}/other/x")), None);
        assert_eq!(split_key(&format!("/{key}")), None);
        assert_eq!(split_key(""), None);
    }

    #[test]
    fn rate_limit_never_drops_panic() {
        let t0 = Instant::now();
        let mut l = Limiter::new(t0);
        let passed = (0..500).filter(|_| l.allow(t0, &Control::Next)).count();
        assert_eq!(passed, MAX_OSC_PER_SEC as usize);
        // Over the limit: ordinary controls are dropped, PANIC is not.
        assert!(!l.allow(t0, &Control::TapTempo));
        assert!(l.allow(t0, &Control::Panic));
        // A new second opens the window again.
        assert!(l.allow(t0 + Duration::from_millis(1001), &Control::Next));
    }
}
