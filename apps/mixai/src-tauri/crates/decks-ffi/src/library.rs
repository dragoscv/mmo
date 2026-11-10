//! [`DecksLibrary`]: the `decks-library` SQLite catalogue over FFI.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use decks_library::interop::{self, Interchange};
use decks_library::smart::Rule;
use decks_library::{Collection, Library, MusicalKey, Rgb, Source};

use crate::{DecksError, lock};

impl From<decks_library::Error> for DecksError {
    fn from(e: decks_library::Error) -> Self {
        match e {
            decks_library::Error::NotFound(reason) => DecksError::NotFound { reason },
            decks_library::Error::Unsupported(reason) => DecksError::Unsupported { reason },
            decks_library::Error::Protected(reason) => DecksError::Protected { reason },
            decks_library::Error::Rule(r) => DecksError::invalid(format!("smart crate rule: {r}")),
            other => DecksError::Library {
                reason: other.to_string(),
            },
        }
    }
}

// ---- records ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum CueType {
    Hot,
    Memory,
    Loop,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LibraryCue {
    pub kind: CueType,
    /// Hot cue / hot loop slot (0-based).
    pub index: Option<u8>,
    pub start_sec: f64,
    pub end_sec: Option<f64>,
    /// `0xRRGGBB`.
    pub colour: Option<u32>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct LibraryGridAnchor {
    pub sec: f64,
    pub bpm: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct LibraryGrid {
    pub bpm: f64,
    pub first_beat_sec: f64,
    pub downbeat_offset: u8,
    pub anchors: Vec<LibraryGridAnchor>,
    /// Fixed-grid toggle: anchors kept but ignored (WP19-37).
    #[uniffi(default = false)]
    pub fixed: bool,
}

/// A track (library row or interop record).
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct LibraryTrack {
    /// Library UUID (`None` for records not yet in the library).
    pub id: Option<String>,
    pub path: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub label: Option<String>,
    pub year: Option<i32>,
    pub duration_sec: Option<f64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub bpm: Option<f64>,
    /// Camelot (`8A`); also accepts Open Key / musical text on input.
    pub key: Option<String>,
    pub energy: Option<u8>,
    pub rating: Option<u8>,
    /// `0xRRGGBB`.
    pub colour: Option<u32>,
    pub comment: Option<String>,
    pub isrc: Option<String>,
    pub lufs: Option<f64>,
    pub added_at: Option<i64>,
    pub last_played: Option<i64>,
    pub play_count: u32,
    pub cues: Vec<LibraryCue>,
    pub grid: Option<LibraryGrid>,
}

impl From<decks_library::TrackRecord> for LibraryTrack {
    fn from(t: decks_library::TrackRecord) -> Self {
        Self {
            id: t.id,
            path: t.path,
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre,
            label: t.label,
            year: t.year,
            duration_sec: t.duration_sec,
            bitrate: t.bitrate,
            sample_rate: t.sample_rate,
            bpm: t.bpm,
            key: t.key.map(MusicalKey::camelot),
            energy: t.energy,
            rating: t.rating,
            colour: t.colour.map(Rgb::to_u32),
            comment: t.comment,
            isrc: t.isrc,
            lufs: t.lufs,
            added_at: t.added_at,
            last_played: t.last_played,
            play_count: t.play_count,
            cues: t
                .cues
                .into_iter()
                .map(|c| LibraryCue {
                    kind: match c.kind {
                        decks_library::CueKind::Hot => CueType::Hot,
                        decks_library::CueKind::Memory => CueType::Memory,
                        decks_library::CueKind::Loop => CueType::Loop,
                    },
                    index: c.index,
                    start_sec: c.start_sec,
                    end_sec: c.end_sec,
                    colour: c.colour.map(Rgb::to_u32),
                    label: c.label,
                })
                .collect(),
            grid: t.grid.map(|g| LibraryGrid {
                bpm: g.bpm,
                first_beat_sec: g.first_beat_sec,
                downbeat_offset: g.downbeat_offset,
                anchors: g
                    .anchors
                    .into_iter()
                    .map(|a| LibraryGridAnchor {
                        sec: a.sec,
                        bpm: a.bpm,
                    })
                    .collect(),
                fixed: g.fixed,
            }),
        }
    }
}

impl LibraryTrack {
    fn to_record(&self) -> Result<decks_library::TrackRecord, DecksError> {
        let key = match &self.key {
            None => None,
            Some(k) => Some(
                MusicalKey::parse(k)
                    .ok_or_else(|| DecksError::invalid(format!("unknown key notation {k}")))?,
            ),
        };
        Ok(decks_library::TrackRecord {
            id: self.id.clone(),
            source_id: None,
            path: self.path.clone(),
            file_hash: None,
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            genre: self.genre.clone(),
            label: self.label.clone(),
            year: self.year,
            duration_sec: self.duration_sec,
            bitrate: self.bitrate,
            sample_rate: self.sample_rate,
            bpm: self.bpm,
            key,
            energy: self.energy,
            rating: self.rating,
            colour: self.colour.map(Rgb::from_u32),
            comment: self.comment.clone(),
            isrc: self.isrc.clone(),
            lufs: self.lufs,
            added_at: self.added_at,
            last_played: self.last_played,
            play_count: self.play_count,
            cues: self
                .cues
                .iter()
                .map(|c| decks_library::Cue {
                    kind: match c.kind {
                        CueType::Hot => decks_library::CueKind::Hot,
                        CueType::Memory => decks_library::CueKind::Memory,
                        CueType::Loop => decks_library::CueKind::Loop,
                    },
                    index: c.index,
                    start_sec: c.start_sec,
                    end_sec: c.end_sec,
                    colour: c.colour.map(Rgb::from_u32),
                    label: c.label.clone(),
                })
                .collect(),
            grid: self.grid.as_ref().map(|g| decks_library::BeatGrid {
                bpm: g.bpm,
                first_beat_sec: g.first_beat_sec,
                downbeat_offset: g.downbeat_offset,
                anchors: g
                    .anchors
                    .iter()
                    .map(|a| decks_library::GridAnchor {
                        sec: a.sec,
                        bpm: a.bpm,
                    })
                    .collect(),
                fixed: g.fixed,
            }),
        })
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CrateRow {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub is_folder: bool,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SmartCrateRow {
    pub id: i64,
    pub name: String,
    /// Rule tree as JSON (see `decks_library::smart`), e.g.
    /// `{"all":[{"field":"bpm","op":"between","value":[120,128]}]}`.
    pub rule_json: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HistorySessionRow {
    pub id: i64,
    pub name: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct HistoryEntryRow {
    pub position: i64,
    pub track_id: Option<String>,
    pub played_at: i64,
    pub deck: Option<u8>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ScanState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScanFailure {
    pub path: String,
    pub reason: String,
}

/// Progress / result of a background folder scan.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScanStatus {
    pub scan_id: u64,
    pub state: ScanState,
    pub done: u32,
    pub total: u32,
    pub current: String,
    pub added: u32,
    pub updated: u32,
    pub failed: Vec<ScanFailure>,
    pub error: Option<String>,
}

/// Interchange formats for import / export / migration.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum LibraryFormat {
    /// rekordbox "Export Collection in xml format" (read + write).
    RekordboxXml,
    /// Traktor `collection.nml` (read + write).
    TraktorNml,
    /// Serato `_Serato_` folder; paths relative to `volume_root` (read + write).
    SeratoCrates { volume_root: String },
    /// Engine DJ `m.db` (read only).
    EngineDj,
    /// rekordbox USB `export.pdb` (read only).
    RekordboxPdb { volume_root: String },
    /// MixAI neutral JSON (read + write, lossless).
    NeutralJson,
    /// OneLibrary (pending a public spec: always `Unsupported`).
    OneLibrary,
}

impl LibraryFormat {
    fn interchange(&self) -> Box<dyn Interchange> {
        match self {
            Self::RekordboxXml => Box::new(interop::RekordboxXml),
            Self::TraktorNml => Box::new(interop::TraktorNml),
            Self::SeratoCrates { volume_root } => Box::new(interop::SeratoCrates {
                volume_root: PathBuf::from(volume_root),
            }),
            Self::EngineDj => Box::new(interop::EngineDj),
            Self::RekordboxPdb { volume_root } => Box::new(interop::RekordboxPdb {
                volume_root: PathBuf::from(volume_root),
            }),
            Self::NeutralJson => Box::new(interop::NeutralJson),
            Self::OneLibrary => Box::new(interop::OneLibrary),
        }
    }

    fn source(&self, path: &str) -> Source {
        let p = PathBuf::from(path);
        match self {
            Self::RekordboxXml => Source::RekordboxXml(p),
            Self::TraktorNml => Source::TraktorNml(p),
            Self::SeratoCrates { volume_root } => Source::Serato {
                serato_dir: p,
                volume_root: PathBuf::from(volume_root),
            },
            Self::EngineDj => Source::EngineDj(p),
            Self::RekordboxPdb { volume_root } => Source::RekordboxPdb {
                pdb: p,
                volume_root: PathBuf::from(volume_root),
            },
            Self::NeutralJson => Source::NeutralJson(p),
            Self::OneLibrary => Source::OneLibrary(p),
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct MigrationSummary {
    pub source: String,
    pub tracks_seen: u32,
    pub tracks_inserted: u32,
    pub tracks_merged_by_path: u32,
    pub tracks_merged_by_hash: u32,
    pub cues_imported: u32,
    pub grids_imported: u32,
    pub playlists_imported: u32,
    pub playlist_entries: u32,
    pub unmatched_files: Vec<String>,
    pub warnings: Vec<String>,
}

impl From<decks_library::MigrationReport> for MigrationSummary {
    fn from(r: decks_library::MigrationReport) -> Self {
        let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
        Self {
            source: r.source,
            tracks_seen: n(r.tracks_seen),
            tracks_inserted: n(r.tracks_inserted),
            tracks_merged_by_path: n(r.tracks_merged_by_path),
            tracks_merged_by_hash: n(r.tracks_merged_by_hash),
            cues_imported: n(r.cues_imported),
            grids_imported: n(r.grids_imported),
            playlists_imported: n(r.playlists_imported),
            playlist_entries: n(r.playlist_entries),
            unmatched_files: r.unmatched_files,
            warnings: r.warnings,
        }
    }
}

// ---- object -----------------------------------------------------------------------------

/// The MixAI Decks library (one SQLite file). Thread-safe; long scans run on a background
/// thread with their own connection (WAL), so searches stay responsive.
#[derive(uniffi::Object)]
pub struct DecksLibrary {
    pub(crate) lib: Arc<Mutex<Library>>,
    pub(crate) path: Option<PathBuf>,
    scans: Arc<Mutex<ScanGate>>,
    /// Set when a restore left the handle without a real connection (WP19-40 review P1-16).
    pub(crate) unusable: Arc<Mutex<Option<String>>>,
    next_scan: AtomicU64,
}

/// Background scans plus the restore gate behind ONE mutex, so "no scan is running" and "a
/// restore is starting" cannot race (WP19-40 review P1-4).
#[derive(Default)]
struct ScanGate {
    list: Vec<ScanStatus>,
    restoring: bool,
}

fn n32(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

fn set_scan(scans: &Mutex<ScanGate>, id: u64, f: impl FnOnce(&mut ScanStatus)) {
    if let Some(s) = lock(scans).list.iter_mut().find(|s| s.scan_id == id) {
        f(s);
    }
}

fn run_scan(
    lib: &mut Library,
    scans: &Mutex<ScanGate>,
    id: u64,
    folder: &Path,
) -> Result<decks_library::library::ScanReport, decks_library::Error> {
    lib.scan_folder(folder, |p| {
        set_scan(scans, id, |s| {
            s.done = n32(p.done);
            s.total = n32(p.total);
            s.current.clone_from(&p.current);
        });
    })
}

impl DecksLibrary {
    pub(crate) fn with<R>(
        &self,
        f: impl FnOnce(&mut Library) -> Result<R, decks_library::Error>,
    ) -> Result<R, DecksError> {
        let mut guard = lock(&self.lib);
        if let Some(reason) = lock(&self.unusable).clone() {
            return Err(DecksError::Library { reason });
        }
        Ok(f(&mut guard)?)
    }

    /// Raises the restore gate: refuses while a background scan (own connection) is running or
    /// another restore is in flight, so no scan can open the file between the check and the
    /// swap (WP19-40 review P1-4). Pair with [`DecksLibrary::end_restore`].
    pub(crate) fn begin_restore(&self) -> Result<(), DecksError> {
        let mut gate = lock(&self.scans);
        if gate.list.iter().any(|s| s.state == ScanState::Running) {
            return Err(DecksError::invalid(
                "a folder scan is running; restore after it finishes",
            ));
        }
        if gate.restoring {
            return Err(DecksError::invalid("another restore is running"));
        }
        gate.restoring = true;
        Ok(())
    }

    pub(crate) fn end_restore(&self) {
        lock(&self.scans).restoring = false;
    }

    /// Mandatory snapshot before an import / migration (file-backed libraries only). Skipped
    /// while protected: the write itself is refused right after.
    pub(crate) fn snapshot_before(&self, op: &str) -> Result<(), DecksError> {
        let Some(dir) = self.snapshot_dir() else {
            return Ok(());
        };
        self.with(|l| {
            if !l.is_protected()? {
                l.snapshot_before(&dir, op)?;
            }
            Ok(())
        })
    }
}

#[uniffi::export]
impl DecksLibrary {
    /// Open (or create) a library file and apply pending schema migrations. Refuses a corrupt
    /// file (`Library` error "corrupt library"; restore with `restore_snapshot_file`), and takes
    /// the daily automatic snapshot into `<db dir>/snapshots` when one is due (WP19-40).
    #[uniffi::constructor]
    pub fn open(path: String) -> Result<Arc<Self>, DecksError> {
        let lib = Library::open(&path)?;
        let this = Arc::new(Self {
            lib: Arc::new(Mutex::new(lib)),
            path: Some(PathBuf::from(path)),
            scans: Arc::default(),
            unusable: Arc::default(),
            next_scan: AtomicU64::new(1),
        });
        // Best effort: a full disk must not stop the DJ from opening the library.
        if let Err(e) = this.auto_snapshot() {
            eprintln!("[decks-library] automatic snapshot failed: {e}");
        }
        Ok(this)
    }

    /// Throw-away in-memory library (previews, tests).
    #[uniffi::constructor]
    pub fn open_in_memory() -> Result<Arc<Self>, DecksError> {
        Ok(Arc::new(Self {
            lib: Arc::new(Mutex::new(Library::open_in_memory()?)),
            path: None,
            scans: Arc::default(),
            unusable: Arc::default(),
            next_scan: AtomicU64::new(1),
        }))
    }

    pub fn schema_version(&self) -> Result<u32, DecksError> {
        self.with(|l| l.schema_version())
    }

    pub fn track_count(&self) -> Result<i64, DecksError> {
        self.with(|l| l.track_count())
    }

    pub fn track(&self, id: String) -> Result<Option<LibraryTrack>, DecksError> {
        self.with(|l| l.track(&id)).map(|t| t.map(Into::into))
    }

    pub fn track_by_path(&self, path: String) -> Result<Option<LibraryTrack>, DecksError> {
        self.with(|l| l.track_by_path(&path))
            .map(|t| t.map(Into::into))
    }

    /// Insert or merge (by path, then file hash); returns the library id.
    pub fn upsert_track(&self, track: LibraryTrack) -> Result<String, DecksError> {
        let rec = track.to_record()?;
        self.with(|l| l.upsert_track(&rec)).map(|(id, _)| id)
    }

    pub fn delete_track(&self, id: String) -> Result<bool, DecksError> {
        self.with(|l| l.delete_track(&id))
    }

    pub fn all_tracks(&self) -> Result<Vec<LibraryTrack>, DecksError> {
        self.with(|l| l.all_tracks())
            .map(|v| v.into_iter().map(Into::into).collect())
    }

    /// FTS5 prefix search over title / artist / album / genre / comment (empty = newest).
    pub fn search(&self, query: String, limit: u32) -> Result<Vec<LibraryTrack>, DecksError> {
        self.with(|l| l.search(&query, limit as usize))
            .map(|v| v.into_iter().map(Into::into).collect())
    }

    pub fn set_cues(&self, track_id: String, cues: Vec<LibraryCue>) -> Result<(), DecksError> {
        let rec = LibraryTrack {
            cues,
            ..Default::default()
        }
        .to_record()?;
        self.with(|l| l.set_cues(&track_id, &rec.cues))
    }

    pub fn set_grid(&self, track_id: String, grid: LibraryGrid) -> Result<(), DecksError> {
        let rec = LibraryTrack {
            grid: Some(grid),
            ..Default::default()
        }
        .to_record()?;
        let g = rec.grid.expect("grid set above");
        self.with(|l| l.set_grid(&track_id, &g))
    }

    // ---- scan ---------------------------------------------------------------------------

    /// Scan `folder` recursively on a background thread; poll `scan_status`.
    pub fn scan_folder(&self, folder: String) -> Result<u64, DecksError> {
        if !Path::new(&folder).is_dir() {
            return Err(DecksError::NotFound {
                reason: format!("folder {folder}"),
            });
        }
        let id = self.next_scan.fetch_add(1, Ordering::Relaxed);
        {
            let mut gate = lock(&self.scans);
            if gate.restoring {
                return Err(DecksError::invalid(
                    "a snapshot restore is running; scan after it finishes",
                ));
            }
            gate.list.push(ScanStatus {
                scan_id: id,
                state: ScanState::Running,
                done: 0,
                total: 0,
                current: String::new(),
                added: 0,
                updated: 0,
                failed: Vec::new(),
                error: None,
            });
        }
        let scans = Arc::clone(&self.scans);
        let shared = Arc::clone(&self.lib);
        let path = self.path.clone();
        std::thread::Builder::new()
            .name("decks-library-scan".into())
            .spawn(move || {
                let folder = PathBuf::from(folder);
                let result = match &path {
                    // Own connection: the main one stays free for UI queries.
                    Some(p) => {
                        Library::open(p).and_then(|mut l| run_scan(&mut l, &scans, id, &folder))
                    }
                    None => run_scan(&mut lock(&shared), &scans, id, &folder),
                };
                set_scan(&scans, id, |s| match result {
                    Ok(r) => {
                        s.state = ScanState::Done;
                        s.added = n32(r.added);
                        s.updated = n32(r.updated);
                        s.failed = r
                            .failed
                            .into_iter()
                            .map(|(path, reason)| ScanFailure { path, reason })
                            .collect();
                    }
                    Err(e) => {
                        s.state = ScanState::Failed;
                        s.error = Some(e.to_string());
                    }
                });
            })
            .map_err(|e| DecksError::Library {
                reason: format!("spawn scan: {e}"),
            })?;
        Ok(id)
    }

    pub fn scan_status(&self, scan_id: u64) -> Option<ScanStatus> {
        lock(&self.scans)
            .list
            .iter()
            .find(|s| s.scan_id == scan_id)
            .cloned()
    }

    // ---- crates -------------------------------------------------------------------------

    pub fn create_crate(
        &self,
        name: String,
        parent_id: Option<i64>,
        is_folder: bool,
    ) -> Result<i64, DecksError> {
        self.with(|l| l.create_crate(&name, parent_id, is_folder))
    }

    pub fn crates(&self) -> Result<Vec<CrateRow>, DecksError> {
        self.with(|l| l.crates()).map(|v| {
            v.into_iter()
                .map(|c| CrateRow {
                    id: c.id,
                    name: c.name,
                    parent_id: c.parent_id,
                    is_folder: c.is_folder,
                    position: c.position,
                })
                .collect()
        })
    }

    pub fn rename_crate(&self, crate_id: i64, name: String) -> Result<(), DecksError> {
        if !self.with(|l| l.rename_crate(crate_id, &name))? {
            return Err(DecksError::NotFound {
                reason: format!("crate {crate_id}"),
            });
        }
        Ok(())
    }

    /// Delete a crate (children and memberships cascade; tracks stay in the library).
    pub fn delete_crate(&self, crate_id: i64) -> Result<bool, DecksError> {
        self.with(|l| l.delete_crate(crate_id))
    }

    pub fn crate_tracks(&self, crate_id: i64) -> Result<Vec<LibraryTrack>, DecksError> {
        self.with(|l| l.crate_tracks(crate_id))
            .map(|v| v.into_iter().map(Into::into).collect())
    }

    /// Replace the ordered track list of a crate.
    pub fn set_crate_tracks(
        &self,
        crate_id: i64,
        track_ids: Vec<String>,
    ) -> Result<(), DecksError> {
        self.with(|l| l.set_crate_tracks(crate_id, &track_ids))
    }

    pub fn add_to_crate(&self, crate_id: i64, track_id: String) -> Result<(), DecksError> {
        self.with(|l| l.add_to_crate(crate_id, &track_id))
    }

    // ---- smart crates -------------------------------------------------------------------

    pub fn create_smart_crate(&self, name: String, rule_json: String) -> Result<i64, DecksError> {
        let rule = parse_rule(&rule_json)?;
        self.with(|l| l.create_smart_crate(&name, &rule))
    }

    pub fn smart_crates(&self) -> Result<Vec<SmartCrateRow>, DecksError> {
        let rows = self.with(|l| l.smart_crates())?;
        rows.into_iter()
            .map(|c| {
                Ok(SmartCrateRow {
                    id: c.id,
                    name: c.name,
                    rule_json: serde_json::to_string(&c.rule)
                        .map_err(|e| DecksError::invalid(e.to_string()))?,
                })
            })
            .collect()
    }

    pub fn delete_smart_crate(&self, id: i64) -> Result<bool, DecksError> {
        self.with(|l| l.delete_smart_crate(id))
    }

    pub fn evaluate_smart_crate(&self, id: i64) -> Result<Vec<LibraryTrack>, DecksError> {
        self.with(|l| l.evaluate_smart_crate(id))
            .map(|v| v.into_iter().map(Into::into).collect())
    }

    /// Evaluate a rule without storing it (live preview while editing).
    pub fn evaluate_rule(&self, rule_json: String) -> Result<Vec<LibraryTrack>, DecksError> {
        let rule = parse_rule(&rule_json)?;
        self.with(|l| l.evaluate_rule(&rule))
            .map(|v| v.into_iter().map(Into::into).collect())
    }

    // ---- interop ------------------------------------------------------------------------

    /// Read a collection file and merge it into the library (tracks + playlists as crates).
    /// Returns the number of tracks imported. Use `migrate_from` for a full migration with
    /// dedupe by content hash, Serato markers and a report.
    pub fn import_file(&self, format: LibraryFormat, path: String) -> Result<u32, DecksError> {
        let col = format.interchange().read(Path::new(&path))?;
        let n = n32(col.tracks.len());
        self.snapshot_before("import")?;
        self.with(|l| l.import_collection(&col))?;
        Ok(n)
    }

    /// Export the whole library (tracks + crates as playlists).
    pub fn export_file(&self, format: LibraryFormat, path: String) -> Result<(), DecksError> {
        let f = format.interchange();
        if !f.can_write() {
            return Err(DecksError::Unsupported {
                reason: format!("{} is read-only", f.name()),
            });
        }
        let col = self.with(|l| l.to_collection())?;
        f.write(&col, Path::new(&path))?;
        Ok(())
    }

    /// Parse a collection file without touching the library (preview before migrating).
    pub fn read_collection(
        &self,
        format: LibraryFormat,
        path: String,
    ) -> Result<Vec<LibraryTrack>, DecksError> {
        let col: Collection = format.interchange().read(Path::new(&path))?;
        Ok(col.tracks.into_iter().map(Into::into).collect())
    }

    /// One-call migration from another DJ application.
    pub fn migrate_from(
        &self,
        format: LibraryFormat,
        path: String,
    ) -> Result<MigrationSummary, DecksError> {
        let src = format.source(&path);
        self.snapshot_before("migrate")?;
        self.with(|l| decks_library::migrate_from(l, src))
            .map(Into::into)
    }

    // ---- history ------------------------------------------------------------------------

    pub fn start_session(&self, name: Option<String>) -> Result<i64, DecksError> {
        self.with(|l| l.start_session(name.as_deref()))
    }

    pub fn end_session(&self, session_id: i64) -> Result<(), DecksError> {
        self.with(|l| l.end_session(session_id))
    }

    pub fn record_play(
        &self,
        session_id: i64,
        track_id: String,
        deck: Option<u8>,
    ) -> Result<(), DecksError> {
        self.with(|l| l.record_play(session_id, &track_id, deck))
    }

    pub fn sessions(&self) -> Result<Vec<HistorySessionRow>, DecksError> {
        self.with(|l| l.sessions()).map(|v| {
            v.into_iter()
                .map(|s| HistorySessionRow {
                    id: s.id,
                    name: s.name,
                    started_at: s.started_at,
                    ended_at: s.ended_at,
                })
                .collect()
        })
    }

    pub fn session_entries(&self, session_id: i64) -> Result<Vec<HistoryEntryRow>, DecksError> {
        self.with(|l| l.session_entries(session_id)).map(|v| {
            v.into_iter()
                .map(|e| HistoryEntryRow {
                    position: e.position,
                    track_id: e.track_id,
                    played_at: e.played_at,
                    deck: e.deck,
                    title: e.title,
                    artist: e.artist,
                })
                .collect()
        })
    }

    /// Plain-text tracklist (`01. Artist - Title`).
    pub fn tracklist(&self, session_id: i64) -> Result<String, DecksError> {
        self.with(|l| l.tracklist(session_id))
    }
}

fn parse_rule(json: &str) -> Result<Rule, DecksError> {
    serde_json::from_str(json).map_err(|e| DecksError::invalid(format!("smart crate rule: {e}")))
}
