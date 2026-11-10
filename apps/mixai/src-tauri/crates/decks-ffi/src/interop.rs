//! Cross-app import (rekordbox XML, Serato, Traktor NML, rekordbox USB, Engine DJ) with a
//! preview, options and a report over FFI (WP19-38).
//!
//! Flow for the native shells: `detect_import_format(path)` (or the user picks the format) →
//! `import_preview(library, format, path, options)` (read-only) → `import_run(...)`.
//! A locked library (protect-library lock, WP19-40) fails with `DecksError::Protected`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use decks_library::Source;
use decks_library::migrate::{self, ConflictPolicy, MigrateOptions};

use crate::{DecksError, DecksLibrary, LibraryFormat, MigrationSummary, lock};

/// What happens when an imported track is already in the library.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum ImportConflict {
    /// The library wins; imported values only fill empty fields, existing cues / grid stay.
    KeepExisting,
    /// The import wins (non-empty fields, cues and grid replace the library's).
    #[default]
    PreferImported,
    /// Library metadata wins, gaps are filled, imported cues are added to free slots.
    Merge,
}

/// Options chosen after the preview.
#[derive(Debug, Clone, Default, PartialEq, Eq, uniffi::Record)]
pub struct ImportOptions {
    pub conflict: ImportConflict,
    /// Folders searched for files missing at their recorded path (by name, size, hash).
    pub relocate_roots: Vec<String>,
    /// Correct the source decoder's MP3 offset on cues and grids.
    pub correct_drift: bool,
}

/// Read-only summary of an import.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ImportPreviewRecord {
    pub source: String,
    pub tracks_seen: u32,
    pub new_tracks: u32,
    pub matched_by_path: u32,
    pub matched_by_hash: u32,
    pub missing_files: u32,
    pub relocatable: u32,
    pub cues: u32,
    pub grids: u32,
    pub playlists: u32,
    pub playlist_entries: u32,
    /// First missing paths (at most 50).
    pub missing_sample: Vec<String>,
    /// The library is locked: `import_run` will fail with `Protected`.
    pub protected: bool,
    pub warnings: Vec<String>,
}

/// Result of `import_run`: the migration summary plus relocation and drift counters.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ImportRunReport {
    pub summary: MigrationSummary,
    pub relocated: u32,
    pub drift_fixes: u32,
    pub drift_notes: Vec<String>,
}

/// A format guessed from a picked path; `path` is what to pass to preview / run (for Serato,
/// the `_Serato_` folder).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DetectedImport {
    pub format: LibraryFormat,
    pub path: String,
}

fn n(v: usize) -> u32 {
    u32::try_from(v).unwrap_or(u32::MAX)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Maps a library error; `Protected` gets its own variant (the shared `From` impl folds it into
/// `Library`).
fn map_err(e: decks_library::Error) -> DecksError {
    match e {
        decks_library::Error::Protected(reason) => DecksError::Protected { reason },
        other => other.into(),
    }
}

fn source(format: &LibraryFormat, path: &str) -> Source {
    let p = PathBuf::from(path);
    match format {
        LibraryFormat::RekordboxXml => Source::RekordboxXml(p),
        LibraryFormat::TraktorNml => Source::TraktorNml(p),
        LibraryFormat::SeratoCrates { volume_root } => Source::Serato {
            serato_dir: p,
            volume_root: PathBuf::from(volume_root),
        },
        LibraryFormat::EngineDj => Source::EngineDj(p),
        LibraryFormat::RekordboxPdb { volume_root } => Source::RekordboxPdb {
            pdb: p,
            volume_root: PathBuf::from(volume_root),
        },
        LibraryFormat::NeutralJson => Source::NeutralJson(p),
        LibraryFormat::OneLibrary => Source::OneLibrary(p),
    }
}

fn options(o: &ImportOptions) -> MigrateOptions {
    MigrateOptions {
        conflict: match o.conflict {
            ImportConflict::KeepExisting => ConflictPolicy::KeepExisting,
            ImportConflict::PreferImported => ConflictPolicy::PreferImported,
            ImportConflict::Merge => ConflictPolicy::Merge,
        },
        relocate_roots: o
            .relocate_roots
            .iter()
            .filter(|r| !r.trim().is_empty())
            .map(PathBuf::from)
            .collect(),
        correct_drift: o.correct_drift,
    }
}

/// Guesses the import format of a picked file or folder (`None` = not a known DJ library).
#[uniffi::export]
pub fn detect_import_format(path: String) -> Option<DetectedImport> {
    let detected = match migrate::detect_source(Path::new(&path))? {
        Source::RekordboxXml(p) => (LibraryFormat::RekordboxXml, p),
        Source::TraktorNml(p) => (LibraryFormat::TraktorNml, p),
        Source::Serato {
            serato_dir,
            volume_root,
        } => (
            LibraryFormat::SeratoCrates {
                volume_root: s(&volume_root),
            },
            serato_dir,
        ),
        Source::EngineDj(p) => (LibraryFormat::EngineDj, p),
        Source::RekordboxPdb { pdb, volume_root } => (
            LibraryFormat::RekordboxPdb {
                volume_root: s(&volume_root),
            },
            pdb,
        ),
        Source::NeutralJson(p) => (LibraryFormat::NeutralJson, p),
        Source::OneLibrary(p) => (LibraryFormat::OneLibrary, p),
        Source::Collection(_) => return None,
    };
    Some(DetectedImport {
        format: detected.0,
        path: s(&detected.1),
    })
}

/// What an import would do (new / matched / missing, cues, grids, playlists); writes nothing.
#[uniffi::export]
pub fn import_preview(
    library: Arc<DecksLibrary>,
    format: LibraryFormat,
    path: String,
    options: ImportOptions,
) -> Result<ImportPreviewRecord, DecksError> {
    let src = source(&format, &path);
    let opts = self::options(&options);
    let p = migrate::preview(&lock(&library.lib), &src, &opts).map_err(map_err)?;
    Ok(ImportPreviewRecord {
        source: p.source,
        tracks_seen: n(p.tracks_seen),
        new_tracks: n(p.new_tracks),
        matched_by_path: n(p.matched_by_path),
        matched_by_hash: n(p.matched_by_hash),
        missing_files: n(p.missing_files),
        relocatable: n(p.relocatable),
        cues: n(p.cues),
        grids: n(p.grids),
        playlists: n(p.playlists),
        playlist_entries: n(p.playlist_entries),
        missing_sample: p.missing_sample,
        protected: p.protected,
        warnings: p.warnings,
    })
}

/// Runs the import with `options`. Fails with `Protected` while the library is locked.
///
/// A `before-import` snapshot is taken first (same helper as `import_file` / `migrate_from`;
/// file-backed libraries only — an in-memory library has no snapshot folder), so the DJ can
/// roll the whole import back from *Library safety* even under the default `PreferImported`
/// policy, which overwrites cues and grids.
#[uniffi::export]
pub fn import_run(
    library: Arc<DecksLibrary>,
    format: LibraryFormat,
    path: String,
    options: ImportOptions,
) -> Result<ImportRunReport, DecksError> {
    let src = source(&format, &path);
    let opts = self::options(&options);
    library.snapshot_before("import")?;
    let r = migrate::migrate_with(&mut lock(&library.lib), src, &opts).map_err(map_err)?;
    let (relocated, drift_fixes, drift_notes) = (r.relocated, r.drift_fixes, r.drift_notes.clone());
    Ok(ImportRunReport {
        summary: r.into(),
        relocated: n(relocated),
        drift_fixes: n(drift_fixes),
        drift_notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_maps_to_its_own_variant() {
        assert!(matches!(
            map_err(decks_library::Error::Protected("locked".into())),
            DecksError::Protected { reason } if reason == "locked"
        ));
        assert!(matches!(
            map_err(decks_library::Error::Unsupported("x".into())),
            DecksError::Unsupported { .. }
        ));
    }
}
