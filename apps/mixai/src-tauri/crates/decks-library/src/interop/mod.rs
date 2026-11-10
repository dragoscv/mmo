//! DJ software interop. Every format converts to/from the neutral [`Collection`].
//!
//! | Format                     | Read | Write |
//! |----------------------------|------|-------|
//! | rekordbox XML              | yes  | yes   |
//! | Traktor NML                | yes  | yes   |
//! | Serato `.crate`            | yes  | yes   |
//! | Serato Markers2 (GEOB)     | yes  | bytes (frame payload) |
//! | Engine DJ `m.db` (2.x+)    | yes  | no    |
//! | rekordbox `export.pdb`     | yes (tracks, playlists) | no |
//! | Neutral JSON               | yes  | yes   |
//! | OneLibrary                 | blocked (no partner access) | blocked |

pub mod engine;
pub mod json;
pub mod nml;
pub mod pdb;
pub mod rekordbox;
pub mod serato;
pub mod xmltree;

use std::path::{Path, PathBuf};

use crate::model::Collection;
use crate::{Error, Result};

/// A library file format that can be read and/or written as a whole collection.
pub trait Interchange {
    fn name(&self) -> &'static str;
    fn can_write(&self) -> bool {
        true
    }
    fn read(&self, path: &Path) -> Result<Collection>;
    fn write(&self, col: &Collection, path: &Path) -> Result<()>;
}

pub struct RekordboxXml;
pub struct TraktorNml;
pub struct NeutralJson;
pub struct EngineDj;

/// rekordbox `export.pdb`; `volume_root` is the USB root the relative paths hang off.
pub struct RekordboxPdb {
    pub volume_root: PathBuf,
}

/// Serato `_Serato_` folder; crate paths are relative to `volume_root`.
pub struct SeratoCrates {
    pub volume_root: PathBuf,
}

/// OneLibrary (AlphaTheta / Algoriddim / Native Instruments, launched Oct 2025).
///
/// Status 2026-11-09 (WP19-38 blocker): no public specification or SDK, and no AlphaTheta
/// partner access for MixAI. The partners' pages (<https://www.alphatheta.com/en/onelibrary/>)
/// only describe compatibility; the on-device database (`exportLibrary.db`) is
/// SQLCipher-encrypted and documented only by community reverse engineering (e.g.
/// <https://github.com/v1vendi/onelibrary>, MIT, pre-alpha, "not tested on hardware"). A
/// clean-room reader would need a legal review first. Until then this slot refuses I/O; use
/// [`RekordboxXml`] (rekordbox exports it on every plan) for import, [`NeutralJson`] for
/// lossless exchange and `cdj::export_usb` for players.
pub struct OneLibrary;

impl Interchange for RekordboxXml {
    fn name(&self) -> &'static str {
        "rekordbox XML"
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        rekordbox::parse(&std::fs::read_to_string(path)?)
    }
    fn write(&self, col: &Collection, path: &Path) -> Result<()> {
        Ok(std::fs::write(path, rekordbox::to_xml(col))?)
    }
}

impl Interchange for TraktorNml {
    fn name(&self) -> &'static str {
        "Traktor NML"
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        nml::parse(&std::fs::read_to_string(path)?)
    }
    fn write(&self, col: &Collection, path: &Path) -> Result<()> {
        Ok(std::fs::write(path, nml::to_nml(col))?)
    }
}

impl Interchange for NeutralJson {
    fn name(&self) -> &'static str {
        "MixAI neutral JSON"
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        json::parse(&std::fs::read_to_string(path)?)
    }
    fn write(&self, col: &Collection, path: &Path) -> Result<()> {
        Ok(std::fs::write(path, json::to_json(col)?)?)
    }
}

impl Interchange for EngineDj {
    fn name(&self) -> &'static str {
        "Engine DJ m.db"
    }
    fn can_write(&self) -> bool {
        false
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        engine::read(path)
    }
    fn write(&self, _: &Collection, _: &Path) -> Result<()> {
        Err(Error::Unsupported(
            "Engine DJ databases are read-only".into(),
        ))
    }
}

impl Interchange for RekordboxPdb {
    fn name(&self) -> &'static str {
        "rekordbox export.pdb"
    }
    fn can_write(&self) -> bool {
        false
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        pdb::read(path, &self.volume_root)
    }
    fn write(&self, _: &Collection, _: &Path) -> Result<()> {
        Err(Error::Unsupported(
            "export.pdb writing is not supported; use cdj::export_usb (rekordbox XML)".into(),
        ))
    }
}

impl Interchange for SeratoCrates {
    fn name(&self) -> &'static str {
        "Serato crates"
    }
    fn read(&self, path: &Path) -> Result<Collection> {
        serato::read_crates_dir(path, &self.volume_root)
    }
    fn write(&self, col: &Collection, path: &Path) -> Result<()> {
        serato::write_crates_dir(col, path, &self.volume_root)
    }
}

impl Interchange for OneLibrary {
    fn name(&self) -> &'static str {
        "OneLibrary"
    }
    fn can_write(&self) -> bool {
        false
    }
    fn read(&self, _: &Path) -> Result<Collection> {
        Err(Error::Unsupported(ONELIBRARY_PENDING.into()))
    }
    fn write(&self, _: &Collection, _: &Path) -> Result<()> {
        Err(Error::Unsupported(ONELIBRARY_PENDING.into()))
    }
}

pub const ONELIBRARY_PENDING: &str = "OneLibrary: pending a public specification or AlphaTheta \
    partner access (neither available as of 2026-11-09); export rekordbox XML instead";
