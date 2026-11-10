//! Migration from another DJ application into the [`Library`] (WP19-11, product layer WP19-38).
//!
//! Flow: [`preview`] (read-only: what would be added / matched / missing) → the user picks
//! [`MigrateOptions`] (conflict policy, relocation roots, drift correction) → [`migrate_with`]
//! writes in one pass and returns a [`MigrationReport`]. Writes are refused with
//! [`Error::Protected`] while the protect-library lock is on.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension as _, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::drift::{self, SourceApp};
use crate::interop::{self, Interchange};
use crate::library::{Library, Upserted, upsert_in};
use crate::model::{Collection, Cue, CueKind, TrackRecord};
use crate::util::{self, path_key};
use crate::{Error, Result};

/// Where to migrate from.
#[derive(Debug, Clone)]
pub enum Source {
    /// rekordbox "Export Collection in xml format" file.
    RekordboxXml(PathBuf),
    /// Traktor `collection.nml` (or a playlist export).
    TraktorNml(PathBuf),
    /// Serato `_Serato_` folder + the volume root its relative paths hang off.
    /// Cues/colours/BPM lock are read from each file's `Serato Markers2` tag when present.
    Serato {
        serato_dir: PathBuf,
        volume_root: PathBuf,
    },
    /// Engine DJ `Engine Library/Database2/m.db`.
    EngineDj(PathBuf),
    /// rekordbox USB `PIONEER/rekordbox/export.pdb` + the USB root.
    RekordboxPdb { pdb: PathBuf, volume_root: PathBuf },
    /// MixAI neutral JSON export.
    NeutralJson(PathBuf),
    /// OneLibrary device export (blocked: no partner access, see `interop::OneLibrary`).
    OneLibrary(PathBuf),
    /// Already-parsed collection (tests, custom importers).
    Collection(Collection),
}

impl Source {
    /// The application whose decoder produced the cue / grid times (drift correction).
    pub fn app(&self) -> SourceApp {
        match self {
            Self::RekordboxXml(_) | Self::RekordboxPdb { .. } | Self::OneLibrary(_) => {
                SourceApp::Rekordbox
            }
            Self::TraktorNml(_) => SourceApp::Traktor,
            Self::Serato { .. } => SourceApp::Serato,
            Self::EngineDj(_) => SourceApp::EngineDj,
            Self::NeutralJson(_) => SourceApp::MixAi,
            Self::Collection(_) => SourceApp::Unknown,
        }
    }
}

/// What happens when an imported track matches one already in the library.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictPolicy {
    /// The library wins: imported values only fill empty fields; existing cues and grid stay.
    KeepExisting,
    /// The import wins: non-empty imported fields overwrite; imported cues / grid replace the
    /// existing ones when the import carries any (behaviour before WP19-38).
    #[default]
    PreferImported,
    /// Nothing is lost: library metadata wins and imported values fill gaps; imported cues are
    /// added unless an existing cue takes the same hot-cue slot or sits within 5 ms; the
    /// existing grid stays (the imported one is used only when the library has none).
    Merge,
}

/// Import options chosen after the preview.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MigrateOptions {
    pub conflict: ConflictPolicy,
    /// Folders searched for files that are missing at their recorded path (match by file name,
    /// then by size when the source records it, then by content hash when known).
    pub relocate_roots: Vec<PathBuf>,
    /// Shift cues and grids by the source decoder's MP3 priming offset (`drift::correct_record`).
    pub correct_drift: bool,
}

/// Read-only summary shown before importing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImportPreview {
    pub source: String,
    pub tracks_seen: usize,
    pub new_tracks: usize,
    pub matched_by_path: usize,
    pub matched_by_hash: usize,
    /// Files missing at their recorded path and not found under the relocation roots.
    pub missing_files: usize,
    /// Files missing at their recorded path but found under the relocation roots.
    pub relocatable: usize,
    pub cues: usize,
    pub grids: usize,
    pub playlists: usize,
    pub playlist_entries: usize,
    /// Up to [`PREVIEW_SAMPLE`] missing paths.
    pub missing_sample: Vec<String>,
    /// The protect-library lock is on: running the import will be refused.
    pub protected: bool,
    pub warnings: Vec<String>,
}

/// How many missing paths a preview lists.
pub const PREVIEW_SAMPLE: usize = 50;

/// Outcome of a migration.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MigrationReport {
    pub source: String,
    pub tracks_seen: usize,
    pub tracks_inserted: usize,
    pub tracks_merged_by_path: usize,
    pub tracks_merged_by_hash: usize,
    pub cues_imported: usize,
    pub grids_imported: usize,
    pub playlists_imported: usize,
    pub playlist_entries: usize,
    /// Track paths that do not exist on this machine (imported anyway, flagged for relocation).
    pub unmatched_files: Vec<String>,
    pub warnings: Vec<String>,
    /// Missing files re-found under a relocation root (their new path was imported).
    #[serde(default)]
    pub relocated: usize,
    /// Tracks whose cues / grid were shifted by drift correction.
    #[serde(default)]
    pub drift_fixes: usize,
    /// One line per drift fix (`path: +0.026 s (reason)`).
    #[serde(default)]
    pub drift_notes: Vec<String>,
}

// ------------------------------------------------------------------ loading

/// Recorded file size per path key: (bytes, tolerance in bytes).
type Sizes = HashMap<String, (u64, u64)>;

fn load(source: &Source) -> Result<(String, Collection, Sizes)> {
    let read = |f: &dyn Interchange, p: &Path| f.read(p).map(|c| (f.name().to_owned(), c));
    let (name, col) = match source {
        Source::RekordboxXml(p) => read(&interop::RekordboxXml, p)?,
        Source::TraktorNml(p) => read(&interop::TraktorNml, p)?,
        Source::EngineDj(p) => read(&interop::EngineDj, p)?,
        Source::NeutralJson(p) => read(&interop::NeutralJson, p)?,
        Source::OneLibrary(p) => read(&interop::OneLibrary, p)?,
        Source::RekordboxPdb { pdb, volume_root } => read(
            &interop::RekordboxPdb {
                volume_root: volume_root.clone(),
            },
            pdb,
        )?,
        Source::Serato {
            serato_dir,
            volume_root,
        } => read(
            &interop::SeratoCrates {
                volume_root: volume_root.clone(),
            },
            serato_dir,
        )?,
        Source::Collection(c) => ("collection".into(), c.clone()),
    };
    // Sizes only help relocation; a second read of the text file is cheap next to hashing.
    let sizes = match source {
        Source::RekordboxXml(p) => std::fs::read_to_string(p)
            .map(|x| interop::rekordbox::file_sizes(&x))
            .unwrap_or_default(),
        Source::TraktorNml(p) => std::fs::read_to_string(p)
            .map(|x| interop::nml::file_sizes(&x))
            .unwrap_or_default(),
        _ => Sizes::new(),
    };
    Ok((name, col, sizes))
}

// ------------------------------------------------------------------ relocation

/// Lazily built index of the relocation roots: lower-case file name → candidate files.
struct Relocator<'a> {
    roots: &'a [PathBuf],
    index: Option<HashMap<String, Vec<PathBuf>>>,
}

impl<'a> Relocator<'a> {
    fn new(roots: &'a [PathBuf]) -> Self {
        Self { roots, index: None }
    }

    fn index(&mut self) -> &HashMap<String, Vec<PathBuf>> {
        self.index.get_or_insert_with(|| {
            let mut idx: HashMap<String, Vec<PathBuf>> = HashMap::new();
            for root in self.roots {
                for e in walkdir::WalkDir::new(root)
                    .follow_links(false)
                    .into_iter()
                    .filter_map(std::result::Result::ok)
                    .filter(|e| e.file_type().is_file())
                {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    idx.entry(name).or_default().push(e.into_path());
                }
            }
            idx
        })
    }

    /// Finds the file `t` refers to under the roots. `Err` carries an ambiguity warning.
    fn find(
        &mut self,
        t: &TrackRecord,
        size: Option<(u64, u64)>,
    ) -> std::result::Result<Option<PathBuf>, String> {
        if self.roots.is_empty() {
            return Ok(None);
        }
        let norm = t.path.replace('\\', "/");
        let Some(name) = norm.rsplit('/').next().filter(|n| !n.is_empty()) else {
            return Ok(None);
        };
        let Some(cands) = self.index().get(&name.to_lowercase()) else {
            return Ok(None);
        };
        let mut cands: Vec<&PathBuf> = cands.iter().collect();
        if let Some(h) = t.file_hash.as_deref().filter(|h| !h.is_empty()) {
            cands.retain(|c| util::quick_hash(c).is_ok_and(|x| x == h));
        } else if let Some((bytes, tol)) = size {
            cands.retain(|c| std::fs::metadata(c).is_ok_and(|m| m.len().abs_diff(bytes) <= tol));
        }
        match cands.len() {
            0 => Ok(None),
            1 => Ok(Some(PathBuf::clone(cands[0]))),
            _ => {
                // Prefer the candidate sharing the most trailing folder names with the old path.
                let old: Vec<String> = norm
                    .split('/')
                    .rev()
                    .skip(1)
                    .map(str::to_lowercase)
                    .collect();
                let score = |p: &PathBuf| {
                    let s = p.to_string_lossy().replace('\\', "/");
                    s.split('/')
                        .rev()
                        .skip(1)
                        .zip(&old)
                        .take_while(|(a, b)| a.to_lowercase() == **b)
                        .count()
                };
                let best = cands.iter().map(|c| score(c)).max().unwrap_or(0);
                let top: Vec<&&PathBuf> = cands.iter().filter(|c| score(c) == best).collect();
                if top.len() == 1 {
                    Ok(Some(PathBuf::clone(top[0])))
                } else {
                    Err(format!(
                        "{}: {} files named {name} under the relocation folders; not relocated",
                        t.path,
                        top.len()
                    ))
                }
            }
        }
    }
}

// ------------------------------------------------------------------ preparation

struct Prepared {
    name: String,
    col: Collection,
    /// Path key of every track as recorded in the source (playlists reference these).
    orig_keys: Vec<String>,
    missing: Vec<String>,
    relocated: usize,
    warnings: Vec<String>,
    drift: Vec<drift::DriftFix>,
}

fn fill_gaps(t: &mut TrackRecord, from: TrackRecord) {
    macro_rules! gap {
        ($($f:ident),*) => { $( if t.$f.is_none() { t.$f = from.$f; } )* };
    }
    gap!(
        title,
        artist,
        album,
        genre,
        label,
        year,
        duration_sec,
        bitrate,
        sample_rate,
        bpm,
        key,
        comment,
        isrc
    );
}

fn prepare(source: &Source, opts: &MigrateOptions, apply_drift: bool) -> Result<Prepared> {
    let (name, mut col, sizes) = load(source)?;
    let serato = matches!(source, Source::Serato { .. });
    let app = source.app();
    let mut relocator = Relocator::new(&opts.relocate_roots);
    let mut p = Prepared {
        name,
        orig_keys: col.tracks.iter().map(|t| path_key(&t.path)).collect(),
        col: Collection::default(),
        missing: Vec::new(),
        relocated: 0,
        warnings: Vec::new(),
        drift: Vec::new(),
    };
    for t in &mut col.tracks {
        if t.path.is_empty() || !Path::new(&t.path).is_file() {
            match relocator.find(t, sizes.get(&path_key(&t.path)).copied()) {
                Ok(Some(found)) => {
                    t.path = util::path_to_string(&found);
                    p.relocated += 1;
                }
                Ok(None) => {
                    p.missing.push(t.path.clone());
                    continue;
                }
                Err(w) => {
                    p.warnings.push(w);
                    p.missing.push(t.path.clone());
                    continue;
                }
            }
        }
        let path = PathBuf::from(&t.path);
        if t.file_hash.is_none() {
            t.file_hash = util::quick_hash(&path).ok();
        }
        // Serato crates and PDB rows carry little metadata: read the file's own tags.
        if t.title.is_none()
            && let Ok(tags) = crate::tags::read_file(&path)
        {
            fill_gaps(t, tags);
        }
        if serato {
            match interop::serato::read_markers2_from_file(&path) {
                Ok(Some(m)) => {
                    if t.colour.is_none() {
                        t.colour = m.track_colour;
                    }
                    if t.cues.is_empty() {
                        t.cues = m.cues;
                    }
                }
                Ok(None) => {}
                Err(e) => p.warnings.push(format!("{}: Markers2: {e}", t.path)),
            }
        }
        if apply_drift
            && opts.correct_drift
            && let Some(fix) = drift::correct_record(t, app)
        {
            p.drift.push(fix);
        }
    }
    p.col = col;
    Ok(p)
}

/// Library row matching `t` (path first, then content hash), hydrated with cues and grid.
fn existing(lib: &Library, t: &TrackRecord) -> Result<Option<TrackRecord>> {
    if let Some(r) = lib.track_by_path(&t.path)? {
        return Ok(Some(r));
    }
    match t.file_hash.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => match hash_match(lib, h)? {
            Some(id) => lib.track(&id),
            None => Ok(None),
        },
        None => Ok(None),
    }
}

fn hash_match(lib: &Library, hash: &str) -> Result<Option<String>> {
    Ok(lib
        .conn
        .query_row(
            "SELECT id FROM tracks WHERE file_hash = ?1 LIMIT 1",
            [hash],
            |r| r.get(0),
        )
        .optional()?)
}

fn path_match(lib: &Library, path: &str) -> Result<bool> {
    Ok(lib
        .conn
        .query_row(
            "SELECT 1 FROM tracks WHERE path_key = ?1",
            [path_key(path)],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// Two cues collide when they take the same hot slot, or sit within 5 ms with the same kind.
fn collides(a: &Cue, b: &Cue) -> bool {
    let slot = |c: &Cue| match (c.kind, c.index) {
        (CueKind::Memory, _) | (_, None) => None,
        (k, Some(i)) => Some((k == CueKind::Loop, i)),
    };
    (slot(a).is_some() && slot(a) == slot(b))
        || (a.kind == b.kind && (a.start_sec - b.start_sec).abs() < 0.005)
}

/// Applies the conflict policy to an incoming record that matches `old`.
fn apply_policy(t: &mut TrackRecord, old: TrackRecord, policy: ConflictPolicy) {
    if policy == ConflictPolicy::PreferImported {
        return;
    }
    macro_rules! keep {
        ($($f:ident),*) => { $( if old.$f.is_some() { t.$f = old.$f; } )* };
    }
    keep!(
        title,
        artist,
        album,
        genre,
        label,
        year,
        duration_sec,
        bitrate,
        sample_rate,
        bpm,
        key,
        energy,
        rating,
        colour,
        comment,
        isrc,
        lufs
    );
    if old.grid.is_some() {
        t.grid = None; // upsert keeps the stored grid when the record carries none
    }
    if old.cues.is_empty() {
        return;
    }
    t.cues = match policy {
        ConflictPolicy::Merge => {
            let mut all = old.cues;
            for c in t.cues.drain(..) {
                if !all.iter().any(|o| collides(o, &c)) {
                    all.push(c);
                }
            }
            all.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
            all
        }
        _ => Vec::new(), // KeepExisting: stored cues stay untouched
    };
}

// ------------------------------------------------------------------ crates (inside the tx)

/// Id of the crate called `name` under `parent_id`, if it exists.
fn crate_by_name(
    tx: &Transaction<'_>,
    name: &str,
    parent_id: Option<i64>,
    is_folder: bool,
) -> Result<Option<i64>> {
    Ok(tx
        .query_row(
            "SELECT id FROM crates WHERE name = ?1 AND parent_id IS ?2 AND is_folder = ?3",
            params![name, parent_id, is_folder],
            |r| r.get(0),
        )
        .optional()?)
}

fn create_crate_in(
    tx: &Transaction<'_>,
    name: &str,
    parent_id: Option<i64>,
    is_folder: bool,
) -> Result<i64> {
    let pos: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM crates WHERE parent_id IS ?1",
        [parent_id],
        |r| r.get(0),
    )?;
    tx.execute(
        "INSERT INTO crates(name, parent_id, is_folder, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, parent_id, is_folder, pos, util::now_unix()],
    )?;
    Ok(tx.last_insert_rowid())
}

fn ensure_crate_in(
    tx: &Transaction<'_>,
    name: &str,
    parent_id: Option<i64>,
    is_folder: bool,
) -> Result<i64> {
    match crate_by_name(tx, name, parent_id, is_folder)? {
        Some(id) => Ok(id),
        None => create_crate_in(tx, name, parent_id, is_folder),
    }
}

/// How many same-named playlists one source may carry in one folder before the import is
/// refused (`name`, `name (2)`, … `name (64)`); beyond that the source is malformed.
pub const MAX_SAME_NAME_PLAYLISTS: u32 = 64;

/// `name (2)`, `name (3)`, … — the first one no crate under `parent_id` answers to. Used when
/// one source carries two playlists with the same name in the same folder.
fn disambiguated_crate(tx: &Transaction<'_>, name: &str, parent_id: Option<i64>) -> Result<i64> {
    for n in 2..=MAX_SAME_NAME_PLAYLISTS {
        let candidate = format!("{name} ({n})");
        if crate_by_name(tx, &candidate, parent_id, false)?.is_none() {
            return create_crate_in(tx, &candidate, parent_id, false);
        }
    }
    Err(Error::Format(format!(
        "more than {MAX_SAME_NAME_PLAYLISTS} playlists named {name} in the same folder"
    )))
}

fn crate_track_ids(tx: &Transaction<'_>, crate_id: i64) -> Result<Vec<String>> {
    let mut stmt =
        tx.prepare("SELECT track_id FROM crate_tracks WHERE crate_id = ?1 ORDER BY position")?;
    let ids = stmt
        .query_map([crate_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// Replaces the crate's ordered track list (`PreferImported`).
fn replace_crate_tracks(tx: &Transaction<'_>, crate_id: i64, track_ids: &[String]) -> Result<()> {
    tx.execute("DELETE FROM crate_tracks WHERE crate_id = ?1", [crate_id])?;
    insert_crate_tracks(tx, crate_id, track_ids.iter(), 0)
}

/// Appends the track ids the crate does not already hold, keeping its current order
/// (`Merge`, `KeepExisting`). Returns how many were added.
fn append_crate_tracks(tx: &Transaction<'_>, crate_id: i64, track_ids: &[String]) -> Result<usize> {
    let mut present: HashSet<String> = crate_track_ids(tx, crate_id)?.into_iter().collect();
    let next: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position) + 1, 0) FROM crate_tracks WHERE crate_id = ?1",
        [crate_id],
        |r| r.get(0),
    )?;
    let mut added: Vec<&String> = Vec::new();
    for id in track_ids {
        if present.insert(id.clone()) {
            added.push(id);
        }
    }
    insert_crate_tracks(tx, crate_id, added.iter().copied(), next)?;
    Ok(added.len())
}

fn insert_crate_tracks<'a>(
    tx: &Transaction<'_>,
    crate_id: i64,
    ids: impl Iterator<Item = &'a String>,
    from: i64,
) -> Result<()> {
    let mut ins =
        tx.prepare("INSERT INTO crate_tracks(crate_id, position, track_id) VALUES (?1, ?2, ?3)")?;
    for (i, id) in ids.enumerate() {
        ins.execute(params![crate_id, from + i as i64, id])?;
    }
    Ok(())
}

// ------------------------------------------------------------------ public API

/// The volume a Serato folder's relative paths hang off: `/Volumes/<name>` on a macOS external
/// drive, otherwise the root of the path (`C:\`, `E:\`, `/`).
fn serato_volume_root(serato_dir: &Path) -> PathBuf {
    let s = serato_dir.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("/Volumes/")
        && let Some(name) = rest.split('/').next().filter(|n| !n.is_empty())
    {
        return PathBuf::from(format!("/Volumes/{name}"));
    }
    serato_dir
        .ancestors()
        .last()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn sniff(path: &Path, needle: &str) -> bool {
    use std::io::Read as _;
    let mut buf = vec![0u8; 4096];
    let n = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut buf))
        .unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).contains(needle)
}

/// Guesses the source format from a picked file or folder: a `.xml` with `DJ_PLAYLISTS` =
/// rekordbox, `.nml` = Traktor, a `_Serato_` folder (or a folder / drive containing one, or its
/// `database V2`) = Serato, `export.pdb` (or a USB root with `PIONEER/rekordbox/export.pdb`) =
/// rekordbox device library, Engine DJ `m.db`, MixAI neutral JSON. `None` = not recognised.
pub fn detect_source(path: &Path) -> Option<Source> {
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    if path.is_dir() {
        let serato = if name == "_serato_" {
            Some(path.to_path_buf())
        } else {
            Some(path.join("_Serato_")).filter(|p| p.is_dir())
        };
        if let Some(dir) = serato {
            return Some(Source::Serato {
                volume_root: serato_volume_root(&dir),
                serato_dir: dir,
            });
        }
        let pdb = path.join("PIONEER").join("rekordbox").join("export.pdb");
        if pdb.is_file() {
            return Some(Source::RekordboxPdb {
                pdb,
                volume_root: path.to_path_buf(),
            });
        }
        return None;
    }
    if !path.is_file() {
        return None;
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match (name.as_str(), ext.as_str()) {
        ("database v2", _) => {
            let dir = path.parent()?.to_path_buf();
            Some(Source::Serato {
                volume_root: serato_volume_root(&dir),
                serato_dir: dir,
            })
        }
        ("export.pdb", _) => Some(Source::RekordboxPdb {
            pdb: path.to_path_buf(),
            // USB/PIONEER/rekordbox/export.pdb
            volume_root: path.ancestors().nth(3)?.to_path_buf(),
        }),
        ("m.db", _) => Some(Source::EngineDj(path.to_path_buf())),
        (_, "nml") => Some(Source::TraktorNml(path.to_path_buf())),
        (_, "xml") if sniff(path, "DJ_PLAYLISTS") => Some(Source::RekordboxXml(path.to_path_buf())),
        (_, "json") if sniff(path, interop::json::FORMAT) => {
            Some(Source::NeutralJson(path.to_path_buf()))
        }
        _ => None,
    }
}

/// Reads `source` and reports what an import would do, without writing anything.
pub fn preview(lib: &Library, source: &Source, opts: &MigrateOptions) -> Result<ImportPreview> {
    let p = prepare(source, opts, false)?;
    let mut out = ImportPreview {
        source: p.name,
        tracks_seen: p.col.tracks.len(),
        missing_files: p.missing.len(),
        relocatable: p.relocated,
        missing_sample: p.missing.iter().take(PREVIEW_SAMPLE).cloned().collect(),
        protected: lib.is_protected()?,
        warnings: p.warnings,
        playlists: p.col.playlists.len(),
        ..ImportPreview::default()
    };
    for t in &p.col.tracks {
        out.cues += t.cues.len();
        out.grids += usize::from(t.grid.is_some());
        if path_match(lib, &t.path)? {
            out.matched_by_path += 1;
        } else if let Some(h) = t.file_hash.as_deref().filter(|h| !h.is_empty())
            && hash_match(lib, h)?.is_some()
        {
            out.matched_by_hash += 1;
        } else {
            out.new_tracks += 1;
        }
    }
    let known: HashSet<&String> = p.orig_keys.iter().collect();
    out.playlist_entries = p
        .col
        .playlists
        .iter()
        .flat_map(|pl| &pl.tracks)
        .filter(|t| known.contains(&path_key(t)))
        .count();
    if out.tracks_seen == 0 && out.playlists == 0 {
        out.warnings
            .push("source contained no tracks or playlists".into());
    }
    Ok(out)
}

/// Imports tracks (deduped by path, then content hash), cues with colours, beat grids and
/// playlists from `source` into `lib`, with the default options (imported data wins, no
/// relocation, no drift correction).
pub fn migrate_from(lib: &mut Library, source: Source) -> Result<MigrationReport> {
    migrate_with(lib, source, &MigrateOptions::default())
}

/// Full import with options. Refused with [`Error::Protected`] while the library is locked.
pub fn migrate_with(
    lib: &mut Library,
    source: Source,
    opts: &MigrateOptions,
) -> Result<MigrationReport> {
    migrate_guarded(lib, source, opts, Library::is_protected)
}

pub(crate) fn migrate_guarded(
    lib: &mut Library,
    source: Source,
    opts: &MigrateOptions,
    is_protected: impl Fn(&Library) -> Result<bool>,
) -> Result<MigrationReport> {
    if is_protected(lib)? {
        return Err(Error::Protected(
            "the library is locked (protect library); unlock it before importing".into(),
        ));
    }
    let Prepared {
        name,
        mut col,
        orig_keys,
        missing,
        relocated,
        warnings,
        drift,
    } = prepare(&source, opts, true)?;
    let mut report = MigrationReport {
        source: name,
        tracks_seen: col.tracks.len(),
        unmatched_files: missing,
        warnings,
        relocated,
        drift_fixes: drift.len(),
        drift_notes: drift
            .iter()
            .map(|f| format!("{}: {:+.3} s ({})", f.path, f.shift_sec, f.reason))
            .collect(),
        ..MigrationReport::default()
    };

    // Cues already in the library that a Merge re-writes (not counted as imported).
    let mut kept_cues = vec![0usize; col.tracks.len()];
    if opts.conflict != ConflictPolicy::PreferImported {
        for (t, kept) in col.tracks.iter_mut().zip(&mut kept_cues) {
            if let Some(old) = existing(lib, t)? {
                if opts.conflict == ConflictPolicy::Merge {
                    *kept = old.cues.len();
                }
                apply_policy(t, old, opts.conflict);
            }
        }
    }

    // One transaction for tracks, cues, grids and crates: a failure anywhere rolls the whole
    // import back and leaves the library exactly as it was (review P1-6).
    let missing_refs = {
        let tx = lib.conn.transaction()?;
        let mut ids: HashMap<String, String> = HashMap::new();
        for ((t, orig), kept) in col.tracks.iter().zip(&orig_keys).zip(&kept_cues) {
            let (id, how) = upsert_in(&tx, t)?;
            match how {
                Upserted::Inserted => report.tracks_inserted += 1,
                Upserted::MatchedPath => report.tracks_merged_by_path += 1,
                Upserted::MatchedHash => report.tracks_merged_by_hash += 1,
            }
            report.cues_imported += t.cues.len().saturating_sub(*kept);
            report.grids_imported += usize::from(t.grid.is_some());
            // Playlists reference the recorded path; a relocated track answers to both.
            ids.insert(orig.clone(), id.clone());
            ids.insert(path_key(&t.path), id);
        }

        let mut missing_refs = HashSet::new();
        // (parent folder crate, playlist name) already written by THIS import: a source with
        // two same-named playlists in one folder gets `name (2)` rather than one merged crate.
        let mut seen: HashSet<(Option<i64>, String)> = HashSet::new();
        for pl in &col.playlists {
            let mut parent = None;
            for f in &pl.folder {
                parent = Some(ensure_crate_in(&tx, f, parent, true)?);
            }
            let crate_id = if seen.insert((parent, pl.name.clone())) {
                ensure_crate_in(&tx, &pl.name, parent, false)?
            } else {
                disambiguated_crate(&tx, &pl.name, parent)?
            };
            let track_ids: Vec<String> = pl
                .tracks
                .iter()
                .filter_map(|p| {
                    let id = ids.get(&path_key(p)).cloned();
                    if id.is_none() {
                        missing_refs.insert(p.clone());
                    }
                    id
                })
                .collect();
            // The conflict policy governs crates too: only PreferImported replaces an
            // existing user crate; the others add what is missing and keep the rest.
            report.playlist_entries += match opts.conflict {
                ConflictPolicy::PreferImported => {
                    replace_crate_tracks(&tx, crate_id, &track_ids)?;
                    track_ids.len()
                }
                _ => append_crate_tracks(&tx, crate_id, &track_ids)?,
            };
            report.playlists_imported += 1;
        }
        if report.tracks_seen == 0 && report.playlists_imported == 0 {
            return Err(Error::Format(
                "source contained no tracks or playlists".into(),
            ));
        }
        tx.commit()?;
        missing_refs
    };
    let mut missing_refs: Vec<String> = missing_refs.into_iter().collect();
    missing_refs.sort();
    for p in missing_refs {
        report
            .warnings
            .push(format!("playlist entry not in collection: {p}"));
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_library_refuses_import_and_writes_nothing() {
        let mut lib = Library::open_in_memory().unwrap();
        let col = Collection {
            tracks: vec![TrackRecord {
                path: "/nowhere/a.mp3".into(),
                title: Some("A".into()),
                ..TrackRecord::default()
            }],
            playlists: vec![],
        };
        let err = migrate_guarded(
            &mut lib,
            Source::Collection(col.clone()),
            &MigrateOptions::default(),
            |_| Ok(true),
        )
        .unwrap_err();
        assert!(matches!(err, Error::Protected(_)), "{err}");
        assert_eq!(lib.track_count().unwrap(), 0);
        // Unlocked: the same import goes through.
        let r = migrate_guarded(
            &mut lib,
            Source::Collection(col),
            &MigrateOptions::default(),
            |_| Ok(false),
        )
        .unwrap();
        assert_eq!(r.tracks_inserted, 1);
    }
}
