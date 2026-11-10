//! MixAI Decks library (ADR-0014, tracker WP19-11).
//!
//! * [`Library`]: SQLite catalogue (WAL, foreign keys, FTS5) with tracks, cues, beat grids,
//!   crates, smart crates, history sessions and an analysis blob cache.
//! * [`interop`]: import/export for rekordbox XML, Traktor NML, Serato crates + Markers2,
//!   Engine DJ (read), rekordbox `export.pdb` (read), neutral JSON and the OneLibrary slot.
//! * [`migrate::migrate_from`]: one-call migration into the library.
//! * [`cdj::export_usb`]: rekordbox-compatible XML + folder layout on a USB stick.
//!
//! All interop goes through the neutral [`model::Collection`].
#![forbid(unsafe_code)]

pub mod cdj;
pub mod colour;
pub mod drift;
pub mod interop;
pub mod keys;
pub mod library;
pub mod migrate;
pub mod model;
pub mod safety;
pub mod schema;
pub mod smart;
pub mod tags;
pub mod util;

pub use keys::MusicalKey;
pub use library::Library;
pub use migrate::{MigrationReport, Source, migrate_from};
pub use model::{BeatGrid, Collection, Cue, CueKind, GridAnchor, Playlist, Rgb, TrackRecord};

/// Library error type.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("xml: {0}")]
    Xml(String),
    #[error("format: {0}")]
    Format(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid smart crate rule: {0}")]
    Rule(String),
    #[error("not found: {0}")]
    NotFound(String),
    /// The protect-library lock is on; imports and bulk edits are refused (WP19-38/40).
    #[error("protected: {0}")]
    Protected(String),
}

pub type Result<T> = std::result::Result<T, Error>;
