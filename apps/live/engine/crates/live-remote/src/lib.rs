//! MixAI Live LAN control (protocol v1, `docs/live/remote-protocol.md`).
//!
//! The engine process owns a [`RemoteServer`], and each tick it:
//! 1. drains [`Incoming`] controls, applies them through `Session::apply_control`, then replies;
//! 2. publishes `SessionState` when its revision changes;
//! 3. publishes meters as JSON ([`meters_json`]).

pub mod discovery;
pub mod http;
pub mod osc;
pub mod qr;
pub mod server;
pub mod token;

pub use server::{ClientInfo, DEFAULT_PORT, Incoming, RemoteConfig, RemoteServer, lan_ip};

pub const PROTOCOL_VERSION: u32 = 1;

use live_engine::{Meters, ProbeState, SessionError};
use serde_json::json;

/// The `meters` server message.
pub fn meters_json(m: &Meters) -> String {
    let probe = match m.latency_probe {
        ProbeState::Idle => json!("idle"),
        ProbeState::Running => json!("running"),
        ProbeState::Done(ms) => json!({ "done_ms": ms }),
        ProbeState::Failed => json!("failed"),
    };
    let tune = m.tune.map(|t| {
        json!({
            "freq": t.input.frequency,
            "midi": t.input.midi,
            "cents": t.input.cents(),
            "target": t.target,
            "correction_cents": t.correction_cents,
        })
    });
    json!({
        "type": "meters",
        "in_peak": m.in_peak, "in_rms": m.in_rms,
        "out_peak": m.out_peak, "out_rms": m.out_rms,
        "gr": &m.gr[..m.inserts.min(m.gr.len())],
        "dsp_load": m.dsp_load, "dsp_load_max": m.dsp_load_max,
        "xruns": m.xruns, "clipped": m.clipped,
        "tune": tune, "latency_probe": probe,
        "chain_latency_samples": m.chain_latency_samples,
    })
    .to_string()
}

/// Protocol error code for a session error.
pub fn server_error_code(e: &SessionError) -> &'static str {
    match e {
        SessionError::UnknownInsert(_) => "unknown_insert",
        SessionError::UnknownParam(_) => "unknown_param",
        SessionError::UnknownPreset(_) => "unknown_preset",
        SessionError::UnknownFx(_) => "unknown_fx",
        SessionError::Full => "chain_full",
        SessionError::NoSetlist => "no_setlist",
        SessionError::Preset(_) => "bad_request",
    }
}
