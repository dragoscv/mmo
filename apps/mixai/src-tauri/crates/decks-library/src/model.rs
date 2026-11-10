//! Neutral interchange model shared by the library and every interop format.

use serde::{Deserialize, Serialize};

use crate::keys::MusicalKey;

/// 24-bit colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub const fn from_u32(v: u32) -> Self {
        Self::new((v >> 16) as u8, (v >> 8) as u8, v as u8)
    }

    pub const fn to_u32(self) -> u32 {
        ((self.r as u32) << 16) | ((self.g as u32) << 8) | self.b as u32
    }

    /// `#RRGGBB`.
    pub fn to_hex(self) -> String {
        format!("#{:02X}{:02X}{:02X}", self.r, self.g, self.b)
    }

    /// Accepts `#RRGGBB`, `0xRRGGBB` or `RRGGBB`.
    pub fn parse_hex(s: &str) -> Option<Self> {
        let t = s.trim().trim_start_matches('#');
        let t = t
            .strip_prefix("0x")
            .or_else(|| t.strip_prefix("0X"))
            .unwrap_or(t);
        if t.len() != 6 {
            return None;
        }
        u32::from_str_radix(t, 16).ok().map(Self::from_u32)
    }
}

/// Cue point kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CueKind {
    /// Hot cue (has an `index`).
    Hot,
    /// Memory cue (no index).
    Memory,
    /// Loop: a hot loop when `index` is set, a memory loop otherwise.
    Loop,
}

impl CueKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hot => "hot",
            Self::Memory => "memory",
            Self::Loop => "loop",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "hot" => Some(Self::Hot),
            "memory" => Some(Self::Memory),
            "loop" => Some(Self::Loop),
            _ => None,
        }
    }
}

/// A cue point or loop, positions in seconds from the start of the decoded audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cue {
    pub kind: CueKind,
    /// Hot cue / hot loop slot (0-based, A = 0).
    pub index: Option<u8>,
    pub start_sec: f64,
    pub end_sec: Option<f64>,
    pub colour: Option<Rgb>,
    pub label: Option<String>,
}

/// One tempo marker of a (possibly variable) beat grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct GridAnchor {
    pub sec: f64,
    pub bpm: f64,
}

/// Beat grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatGrid {
    pub bpm: f64,
    pub first_beat_sec: f64,
    /// 0-based position of `first_beat_sec` inside its bar (0 = the first beat is a downbeat).
    pub downbeat_offset: u8,
    /// Extra tempo markers for variable grids (empty for constant grids).
    #[serde(default)]
    pub anchors: Vec<GridAnchor>,
    /// User forced a constant grid: `anchors` are kept but ignored (WP19-37 fixed-grid toggle).
    #[serde(default)]
    pub fixed: bool,
}

/// One track as seen by every format. Unknown fields stay `None`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackRecord {
    /// Library UUID (set when the record comes from the library).
    pub id: Option<String>,
    /// Identifier inside the source format (rekordbox TrackID, Engine id…).
    pub source_id: Option<String>,
    /// Absolute file path (forward or back slashes).
    pub path: String,
    pub file_hash: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub label: Option<String>,
    pub year: Option<i32>,
    pub duration_sec: Option<f64>,
    /// kbit/s.
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bpm: Option<f64>,
    pub key: Option<MusicalKey>,
    /// 1..10.
    pub energy: Option<u8>,
    /// Stars 0..5.
    pub rating: Option<u8>,
    pub colour: Option<Rgb>,
    pub comment: Option<String>,
    pub isrc: Option<String>,
    pub lufs: Option<f64>,
    /// Unix seconds.
    pub added_at: Option<i64>,
    /// Unix seconds.
    pub last_played: Option<i64>,
    pub play_count: u32,
    pub cues: Vec<Cue>,
    pub grid: Option<BeatGrid>,
}

/// Ordered playlist; entries are track paths.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Playlist {
    pub name: String,
    /// Folder path from the root (empty = top level).
    pub folder: Vec<String>,
    pub tracks: Vec<String>,
}

/// A whole library in neutral form.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Collection {
    pub tracks: Vec<TrackRecord>,
    pub playlists: Vec<Playlist>,
}

impl Collection {
    /// Finds a track by path (case- and slash-insensitive).
    pub fn track_by_path(&self, path: &str) -> Option<&TrackRecord> {
        let key = crate::util::path_key(path);
        self.tracks
            .iter()
            .find(|t| crate::util::path_key(&t.path) == key)
    }
}
