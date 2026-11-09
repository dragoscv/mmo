//! OSC over UDP: low-latency faders/buttons from control surfaces (TouchOSC, Lemur, the phone
//! apps' fader mode). Accepted only from loopback or from an IP with a paired WebSocket client.

use std::net::UdpSocket;
use std::sync::Arc;

use live_engine::{Control, Role};
use rosc::{OscPacket, OscType};

use crate::server::{Incoming, Inner};

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

/// Map an OSC address + args to a control (`None` = unknown / malformed).
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

pub(crate) fn run(sock: UdpSocket, inner: Arc<Inner>) {
    let mut buf = [0u8; 4096];
    while !inner.stopped() {
        let Ok((n, peer)) = sock.recv_from(&mut buf) else {
            continue;
        };
        let Some(role) = inner.role_of_ip(peer.ip()) else {
            continue;
        };
        let Ok((_, packet)) = rosc::decoder::decode_udp(&buf[..n]) else {
            continue;
        };
        let mut msgs = Vec::new();
        walk(packet, &mut msgs);
        for (addr, args) in msgs {
            if let Some(control) = to_control(&addr, &args)
                && role >= control.required_role()
                && role >= Role::Performer
            {
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
}
