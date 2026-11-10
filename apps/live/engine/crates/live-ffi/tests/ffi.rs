//! End-to-end through the FFI types (the same calls Kotlin / Swift make), on the simulated
//! "Null" loopback device so it runs on CI without audio hardware.

use live_ffi::*;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

fn null(lan: bool) -> LocalEngineConfig {
    LocalEngineConfig {
        audio_host: Some("Null".into()),
        buffer_frames: 64,
        lan,
        ..LocalEngineConfig::default()
    }
}

fn state(e: &LiveEngine) -> serde_json::Value {
    serde_json::from_str(&e.state_json().unwrap()).unwrap()
}

#[test]
fn starts_muted_with_the_preset_and_reports_where_to_connect() {
    let e = LiveEngine::start(null(false)).unwrap();
    let r = e.ready();
    assert_eq!(r.local_host, "127.0.0.1");
    assert_eq!(r.lan_host, "127.0.0.1");
    assert!(r.port > 0);
    assert_eq!(r.audio_host, "Null");
    assert_eq!(r.controller_token.len(), 32);
    assert!(r.controller_url.contains(&r.controller_token));
    assert_eq!(
        r.osc_port, None,
        "phones never open OSC (unauthenticated on loopback)"
    );
    let s = state(&e);
    assert_eq!(s["preset"], "Natural Vocal");
    assert_eq!(
        s["mix"]["mute"], true,
        "phones start muted (speaker next to the mic)"
    );
    e.set_mute(false).unwrap();
    assert_eq!(state(&e)["mix"]["mute"], false);
    e.stop();
    assert!(!e.alive());
    assert!(matches!(e.state_json(), Err(LiveError::NotRunning { .. })));
    e.stop(); // idempotent
}

#[test]
fn controls_apply_and_errors_carry_the_protocol_code() {
    let e = LiveEngine::start(null(false)).unwrap();
    e.load_preset("Pop Polish".into()).unwrap();
    assert_eq!(state(&e)["preset"], "Pop Polish");
    e.control_json(r#"{"type":"add_insert","fx":"chorus","at":0}"#.into())
        .unwrap();
    assert_eq!(state(&e)["chain"][0]["fx"], "chorus");
    assert!(matches!(
        e.load_preset("Nope".into()),
        Err(LiveError::Control { ref code, .. }) if code == "unknown_preset"
    ));
    assert!(matches!(
        e.control_json("{not json".into()),
        Err(LiveError::InvalidArgument { .. })
    ));
    // Codes come from the session error itself (not a string match): a full chain is `chain_full`.
    let mut last = Ok(());
    for _ in 0..40 {
        last = e.control_json(r#"{"type":"add_insert","fx":"chorus","at":0}"#.into());
        if last.is_err() {
            break;
        }
    }
    assert!(
        matches!(last, Err(LiveError::Control { ref code, .. }) if code == "chain_full"),
        "{last:?}"
    );
    assert!(matches!(
        e.control_json(r#"{"type":"add_insert","fx":"warp","at":0}"#.into()),
        Err(LiveError::Control { ref code, .. }) if code == "unknown_fx" || code == "chain_full"
    ));
    e.panic().unwrap();
    assert_eq!(state(&e)["mix"]["mute"], true);
    e.stop();
    assert!(matches!(e.panic(), Err(LiveError::NotRunning { .. })));
}

#[test]
fn meters_flow_and_latency_is_measured_on_the_loopback() {
    let e = LiveEngine::start(null(false)).unwrap();
    let t0 = Instant::now();
    while e.meters().unwrap().is_none() {
        assert!(t0.elapsed() < Duration::from_secs(3), "no meters");
        std::thread::sleep(Duration::from_millis(10));
    }
    let r = e.measure_latency(5_000).unwrap();
    let block_ms = 64.0 / 48.0;
    assert!(
        r.round_trip_ms >= block_ms && r.round_trip_ms <= block_ms * 4.0,
        "{r:?}"
    );
    assert_eq!(r.buffer_frames, 64);
    assert_eq!(e.meters().unwrap().unwrap().probe, "done");
}

#[test]
fn rejects_bad_arguments() {
    let bad = LocalEngineConfig {
        buffer_frames: 4,
        ..null(false)
    };
    assert!(matches!(
        LiveEngine::start(bad),
        Err(LiveError::InvalidArgument { .. })
    ));
    let bad_host = LocalEngineConfig {
        audio_host: Some("NoSuchHost".into()),
        ..null(false)
    };
    assert!(matches!(
        LiveEngine::start(bad_host),
        Err(LiveError::Audio { .. })
    ));
    let bad_preset = LocalEngineConfig {
        preset: "Missing".into(),
        ..null(false)
    };
    assert!(matches!(
        LiveEngine::start(bad_preset),
        Err(LiveError::Preset { .. })
    ));
}

#[test]
fn health_endpoint_answers_on_the_reported_port() {
    let e = LiveEngine::start(null(false)).unwrap();
    let mut s = TcpStream::connect(("127.0.0.1", e.ready().port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    s.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut body = String::new();
    let _ = s.read_to_string(&mut body);
    assert!(body.starts_with("HTTP/1.1 200"), "{body}");
}

#[test]
fn helpers_list_the_null_host_and_presets() {
    assert!(
        !live_hosts().iter().any(|h| h == "Null"),
        "the simulated host is not offered to users"
    );
    let d = live_devices(Some("Null".into())).unwrap();
    assert_eq!(d.len(), 1);
    assert!(live_factory_presets().iter().any(|p| p == "Natural Vocal"));
    assert_eq!(live_protocol_version(), 1);
}
