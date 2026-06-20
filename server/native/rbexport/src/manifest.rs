//! JSON contract between the companion (Node) and the `rbexport` sidecar.
//!
//! The companion resolves the full track list (with DSP analysis) and sends a
//! single `ExportManifest` on stdin. The sidecar writes the USB and emits
//! newline-delimited JSON progress events on stdout.

use serde::{Deserialize, Serialize};

/// One cue point (memory or hot cue) on a track.
#[derive(Debug, Clone, Deserialize)]
pub struct Cue {
    /// Position in milliseconds from track start.
    pub position_ms: f64,
    /// `true` = hot cue (A,B,C…), `false` = memory cue.
    pub is_hot: bool,
    /// Hot-cue slot index (0=A). Ignored for memory cues.
    #[serde(default)]
    pub hot_index: u32,
    /// Optional label shown on the player.
    #[serde(default)]
    pub label: Option<String>,
    /// Optional ARGB color (rekordbox palette index resolved by the writer).
    #[serde(default)]
    pub color: Option<u32>,
}

/// A single detected beat for the beat grid.
#[derive(Debug, Clone, Deserialize)]
pub struct Beat {
    /// Position in milliseconds from track start.
    pub position_ms: f64,
    /// Beat number within the bar, 1-4.
    pub beat_number: u16,
    /// Instantaneous tempo in BPM at this beat.
    pub bpm: f32,
}

/// A track to export.
#[derive(Debug, Clone, Deserialize)]
pub struct Track {
    /// Stable id (companion track id) — used to derive ANLZ folder names.
    pub id: u32,
    /// Absolute source path of the audio file on this machine.
    pub source_path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub label: Option<String>,
    /// Musical key (e.g. "8A" Camelot or "Abm"); writer maps to rekordbox key table.
    pub key: Option<String>,
    pub bpm: Option<f64>,
    pub duration_sec: Option<f64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub year: Option<u32>,
    pub track_number: Option<u32>,
    /// Color label index (rekordbox: 0-7), optional.
    #[serde(default)]
    pub color: Option<u32>,
    /// Rating 0-5 (stars), optional.
    #[serde(default)]
    pub rating: Option<u32>,
    /// Optional artwork file (jpg/png) to embed on the player display.
    #[serde(default)]
    pub artwork_path: Option<String>,
    /// Beat grid (from DSP analysis). Empty = no grid written.
    #[serde(default)]
    pub beats: Vec<Beat>,
    /// Cue points. Empty = writer may auto-insert a memory cue at start.
    #[serde(default)]
    pub cues: Vec<Cue>,
    /// Mono waveform preview samples (0-255 height), if precomputed.
    #[serde(default)]
    pub waveform_preview: Vec<u8>,
    /// Detailed/color waveform samples, if precomputed.
    #[serde(default)]
    pub waveform_detail: Vec<u8>,
}

/// A playlist (optionally nested via `parent`).
#[derive(Debug, Clone, Deserialize)]
pub struct Playlist {
    pub id: u32,
    pub name: String,
    /// Parent playlist id, or 0 for root.
    #[serde(default)]
    pub parent: u32,
    /// `true` for a folder node (no tracks), `false` for a real playlist.
    #[serde(default)]
    pub is_folder: bool,
    /// Ordered track ids (ignored for folders).
    #[serde(default)]
    pub track_ids: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscodePolicy {
    /// Copy everything as-is.
    None,
    /// Transcode only CDJ-incompatible files to AAC 320k.
    Incompatible,
    /// Transcode every track to AAC 320k.
    All,
}

impl Default for TranscodePolicy {
    fn default() -> Self {
        TranscodePolicy::Incompatible
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportOptions {
    /// Write classic `export.pdb`.
    #[serde(default = "default_true")]
    pub write_pdb: bool,
    /// Write Device Library Plus `exportExt.pdb`.
    #[serde(default = "default_true")]
    pub write_ext: bool,
    /// Write `USBANLZ` analysis files.
    #[serde(default = "default_true")]
    pub write_anlz: bool,
    /// Auto memory cue at track start when a track has no cues.
    #[serde(default = "default_true")]
    pub auto_cue: bool,
    #[serde(default)]
    pub transcode: TranscodePolicy,
    /// Path to ffmpeg for transcoding (companion resolves it).
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Top-level manifest sent on stdin.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportManifest {
    /// Destination USB root (e.g. `F:\` or `/Volumes/USB`).
    pub destination: String,
    pub options: ExportOptions,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub playlists: Vec<Playlist>,
}

/// Progress / result event emitted on stdout (newline-delimited JSON).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Progress {
        stage: String,
        done: u32,
        total: u32,
        message: Option<String>,
    },
    Warning {
        message: String,
    },
    Done {
        tracks_written: u32,
        playlists_written: u32,
        bytes_copied: u64,
        pdb: bool,
        ext: bool,
        anlz: bool,
    },
    Error {
        message: String,
    },
}
