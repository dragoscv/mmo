//! `rbexport` — Rekordbox USB export sidecar for the MMO companion.
//!
//! Reads an `ExportManifest` (JSON) on stdin, writes the USB layout, and emits
//! newline-delimited `Event` JSON on stdout. Phase 1 writes the audio
//! `Contents/` tree; later phases add `export.pdb`, `USBANLZ`, `exportExt.pdb`.

mod anlz;
mod contents;
mod devicesql;
mod manifest;
mod pdb;

use manifest::{Event, ExportManifest};
use std::io::{Read, Write};
use std::path::Path;

fn emit(ev: &Event) {
    if let Ok(s) = serde_json::to_string(ev) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}

fn main() {
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        emit(&Event::Error {
            message: format!("failed to read stdin: {e}"),
        });
        std::process::exit(1);
    }

    let manifest: ExportManifest = match serde_json::from_str(&input) {
        Ok(m) => m,
        Err(e) => {
            emit(&Event::Error {
                message: format!("invalid manifest JSON: {e}"),
            });
            std::process::exit(1);
        }
    };

    if let Err(e) = run(&manifest) {
        emit(&Event::Error {
            message: e.to_string(),
        });
        std::process::exit(1);
    }
}

fn run(m: &ExportManifest) -> std::io::Result<()> {
    let dest = Path::new(&m.destination);
    std::fs::create_dir_all(dest)?;

    // ── Phase 1: audio layout ───────────────────────────────────────────
    let (placed, bytes) = contents::place_tracks(
        dest,
        &m.tracks,
        &m.options,
        |done, total| {
            emit(&Event::Progress {
                stage: "audio".into(),
                done,
                total,
                message: None,
            });
        },
        |msg| emit(&Event::Warning { message: msg }),
    )?;

    // ── Phase 2/3: ANLZ + databases ─────────────────────────────────────
    let pioneer = dest.join("PIONEER").join("rekordbox");
    std::fs::create_dir_all(&pioneer)?;

    let mut anlz_written = false;
    if m.options.write_anlz {
        anlz_written = anlz::write_all(dest, &m.tracks, &placed, &m.options, |done, total| {
            emit(&Event::Progress {
                stage: "anlz".into(),
                done,
                total,
                message: None,
            });
        })?;
    }

    let mut pdb_written = false;
    if m.options.write_pdb {
        pdb::write_export_pdb(&pioneer.join("export.pdb"), m, &placed)?;
        pdb_written = true;
        emit(&Event::Progress {
            stage: "pdb".into(),
            done: 1,
            total: 1,
            message: Some("export.pdb".into()),
        });
    }

    let mut ext_written = false;
    if m.options.write_ext {
        pdb::write_export_ext_pdb(&pioneer.join("exportExt.pdb"), m, &placed)?;
        ext_written = true;
        emit(&Event::Progress {
            stage: "ext".into(),
            done: 1,
            total: 1,
            message: Some("exportExt.pdb".into()),
        });
    }

    emit(&Event::Done {
        tracks_written: placed.len() as u32,
        playlists_written: m.playlists.len() as u32,
        bytes_copied: bytes,
        pdb: pdb_written,
        ext: ext_written,
        anlz: anlz_written,
    });
    Ok(())
}
