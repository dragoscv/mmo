//! # decks-remote — MixAI Decks connected mode (WP19-21, ADR-0014)
//!
//! A small LAN server the Decks app runs on demand so other devices can join without installing
//! anything:
//!
//! * **Phone remote** ([`Role::Controller`]): transport, cue, hot cues, loops, sync, faders, EQ and
//!   crossfader from a phone browser.
//! * **Second screen** ([`Role::Viewer`]): read-only deck state (titles, BPM, time left, phase) for a
//!   tablet, laptop or TV browser.
//! * **Party DJ** ([`Role::Guest`]): guests scan a QR code, request songs and vote; the DJ accepts,
//!   rejects or marks them played ([`RequestQueue`]).
//!
//! Transport: plain HTTP for the page (`/`, `/party`, `/tokens.css`, `/health`) and one WebSocket
//! (`/ws?t=<token>&c=<client>`) with JSON messages ([`ClientMsg`] in, [`ServerMsg`] out). Each role
//! has its own 128-bit token carried in the pairing URL / QR; rotating a token disconnects that
//! role at once. LAN only, no TLS, no cloud relay, no GPL code (own protocol, not Ableton Link).
//!
//! The crate knows nothing about the engine: the app publishes a [`RemoteState`] and drains
//! validated [`RemoteCommand`]s (polling, same convention as `decks-ffi`). Documentation:
//! `docs/decks/remote.md`.

mod http;
mod party;
mod protocol;
mod qr;
mod server;
mod token;

pub use party::{PartyError, PublicRequest, RequestQueue, RequestStatus, SongRequestView};
pub use protocol::{
    ClientMsg, EqBand, MAX_DECKS, RemoteCommand, RemoteDeck, RemoteState, Role, ServerMsg,
};
pub use qr::{QrMatrix, qr_matrix, qr_svg};
pub use server::{ClientInfo, RemoteConfig, RemoteServer, lan_ip};
pub use token::{ct_eq, new_token};

/// Protocol version announced in [`ServerMsg::Hello`]; bump on breaking message changes.
pub const PROTOCOL_VERSION: u32 = 1;
