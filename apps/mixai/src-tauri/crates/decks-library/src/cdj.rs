//! CDJ / USB export.
//!
//! Writes a rekordbox-compatible layout:
//! ```text
//! <usb>/Contents/<Artist>/<Album>/<file>   copied audio
//! <usb>/PIONEER/                           marker folder (players look for it)
//! <usb>/rekordbox.xml                      collection + playlists, Location = USB paths
//! <usb>/_Serato_/Subcrates/*.crate         same playlists for Serato (optional)
//! ```
//! Players read `PIONEER/rekordbox/export.pdb`, which this crate does NOT write: no
//! permissively licensed DeviceSQL writer exists (rekordcrate's `Page` is not writable) and
//! OneLibrary is unpublished. Import `rekordbox.xml` into rekordbox and use "Export to
//! device" for players without XML/USB-library support.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::Result;
use crate::interop::{rekordbox, serato};
use crate::model::Collection;
use crate::util::{path_key, sanitize_component};

/// Export options.
#[derive(Debug, Clone)]
pub struct UsbExportOptions {
    /// Copy audio into `Contents/` (false = reference files where they are).
    pub copy_audio: bool,
    /// Also write Serato crates.
    pub serato_crates: bool,
    /// Skip copying when the destination already has a file of the same size.
    pub skip_existing: bool,
}

impl Default for UsbExportOptions {
    fn default() -> Self {
        Self {
            copy_audio: true,
            serato_crates: true,
            skip_existing: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsbExportReport {
    pub tracks_written: usize,
    pub files_copied: usize,
    pub files_skipped: usize,
    pub missing_files: Vec<String>,
    pub xml_path: String,
    pub pdb_written: bool,
}

fn destination(usb: &Path, t: &crate::model::TrackRecord) -> PathBuf {
    let src = Path::new(&t.path);
    let file = src
        .file_name()
        .map(|f| sanitize_component(&f.to_string_lossy()))
        .unwrap_or_else(|| "track".into());
    usb.join("Contents")
        .join(sanitize_component(
            t.artist.as_deref().unwrap_or("Unknown Artist"),
        ))
        .join(sanitize_component(
            t.album.as_deref().unwrap_or("Unknown Album"),
        ))
        .join(file)
}

/// Exports `col` to the USB root `usb`.
pub fn export_usb(
    col: &Collection,
    usb: &Path,
    opts: &UsbExportOptions,
) -> Result<UsbExportReport> {
    fs::create_dir_all(usb.join("PIONEER"))?;
    let mut report = UsbExportReport::default();
    let mut out = col.clone();
    let mut renamed: HashMap<String, String> = HashMap::new();

    if opts.copy_audio {
        for t in &mut out.tracks {
            let src = PathBuf::from(&t.path);
            if !src.is_file() {
                report.missing_files.push(t.path.clone());
                continue;
            }
            let dst = destination(usb, t);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent)?;
            }
            let same = opts.skip_existing
                && dst
                    .metadata()
                    .ok()
                    .zip(src.metadata().ok())
                    .is_some_and(|(a, b)| a.len() == b.len());
            if same {
                report.files_skipped += 1;
            } else {
                fs::copy(&src, &dst)?;
                report.files_copied += 1;
            }
            let new_path = crate::util::path_to_string(&dst).replace('\\', "/");
            renamed.insert(path_key(&t.path), new_path.clone());
            t.path = new_path;
        }
        for pl in &mut out.playlists {
            for p in &mut pl.tracks {
                if let Some(n) = renamed.get(&path_key(p)) {
                    p.clone_from(n);
                }
            }
        }
    }

    let xml_path = usb.join("rekordbox.xml");
    fs::write(&xml_path, rekordbox::to_xml(&out))?;
    report.xml_path = crate::util::path_to_string(&xml_path);
    report.tracks_written = out.tracks.len();
    if opts.serato_crates {
        serato::write_crates_dir(&out, &usb.join("_Serato_"), usb)?;
    }
    Ok(report)
}
