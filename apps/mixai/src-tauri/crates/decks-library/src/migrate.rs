//! One-call migration from another DJ application into the [`Library`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::interop::{self, Interchange};
use crate::library::{Library, Upserted};
use crate::model::Collection;
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
    /// OneLibrary device export (pending a public spec).
    OneLibrary(PathBuf),
    /// Already-parsed collection (tests, custom importers).
    Collection(Collection),
}

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
}

fn load(source: &Source) -> Result<(String, Collection)> {
    let read = |f: &dyn Interchange, p: &Path| f.read(p).map(|c| (f.name().to_owned(), c));
    match source {
        Source::RekordboxXml(p) => read(&interop::RekordboxXml, p),
        Source::TraktorNml(p) => read(&interop::TraktorNml, p),
        Source::EngineDj(p) => read(&interop::EngineDj, p),
        Source::NeutralJson(p) => read(&interop::NeutralJson, p),
        Source::OneLibrary(p) => read(&interop::OneLibrary, p),
        Source::RekordboxPdb { pdb, volume_root } => read(
            &interop::RekordboxPdb {
                volume_root: volume_root.clone(),
            },
            pdb,
        ),
        Source::Serato {
            serato_dir,
            volume_root,
        } => read(
            &interop::SeratoCrates {
                volume_root: volume_root.clone(),
            },
            serato_dir,
        ),
        Source::Collection(c) => Ok(("collection".into(), c.clone())),
    }
}

/// Imports tracks (deduped by path, then content hash), cues with colours, beat grids and
/// playlists from `source` into `lib`.
pub fn migrate_from(lib: &mut Library, source: Source) -> Result<MigrationReport> {
    let (name, mut col) = load(&source)?;
    let mut report = MigrationReport {
        source: name,
        tracks_seen: col.tracks.len(),
        ..MigrationReport::default()
    };
    let serato = matches!(source, Source::Serato { .. });

    for t in &mut col.tracks {
        let p = Path::new(&t.path);
        if t.path.is_empty() || !p.is_file() {
            report.unmatched_files.push(t.path.clone());
            continue;
        }
        if t.file_hash.is_none() {
            t.file_hash = util::quick_hash(p).ok();
        }
        if serato {
            match interop::serato::read_markers2_from_file(p) {
                Ok(Some(m)) => {
                    if t.colour.is_none() {
                        t.colour = m.track_colour;
                    }
                    if t.cues.is_empty() {
                        t.cues = m.cues;
                    }
                }
                Ok(None) => {}
                Err(e) => report.warnings.push(format!("{}: Markers2: {e}", t.path)),
            }
        }
    }

    // Re-key playlists in case a hash match moved a track to a new path.
    let results = lib.upsert_tracks(&col.tracks)?;
    for (t, (_, how)) in col.tracks.iter().zip(&results) {
        match how {
            Upserted::Inserted => report.tracks_inserted += 1,
            Upserted::MatchedPath => report.tracks_merged_by_path += 1,
            Upserted::MatchedHash => report.tracks_merged_by_hash += 1,
        }
        report.cues_imported += t.cues.len();
        report.grids_imported += usize::from(t.grid.is_some());
    }
    let ids: std::collections::HashMap<String, String> = col
        .tracks
        .iter()
        .zip(&results)
        .map(|(t, (id, _))| (path_key(&t.path), id.clone()))
        .collect();

    let mut missing_refs = HashSet::new();
    for pl in &col.playlists {
        let mut parent = None;
        for f in &pl.folder {
            parent = Some(lib.ensure_crate(f, parent, true)?);
        }
        let crate_id = lib.ensure_crate(&pl.name, parent, false)?;
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
        report.playlist_entries += track_ids.len();
        lib.set_crate_tracks(crate_id, &track_ids)?;
        report.playlists_imported += 1;
    }
    for p in missing_refs {
        report
            .warnings
            .push(format!("playlist entry not in collection: {p}"));
    }
    if report.tracks_seen == 0 && report.playlists_imported == 0 {
        return Err(Error::Format(
            "source contained no tracks or playlists".into(),
        ));
    }
    Ok(report)
}
