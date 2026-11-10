//! On-disk state: user presets, the current setlist and the MIDI map, under one data directory.
//!
//! Layout (format v1, see `docs/live/presets.md` § Storage):
//!   <dir>/presets/<slug>.json   one user preset per file (factory presets are built in)
//!   <dir>/setlist.json          the last loaded setlist (restored on start)
//!   <dir>/midi.json             MIDI bindings
//! Writes go to `<file>.tmp` then rename, so a crash mid-write never leaves a torn file.

use crate::midi::MidiMap;
use crate::preset::{Preset, Setlist};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

/// File-name slug: lowercase ASCII alphanumerics and dashes (names stay inside the JSON).
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        // Non-ASCII-only names (e.g. emoji) still need a stable, unique file.
        let h = name.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
        });
        format!("preset-{h:016x}")
    } else {
        s
    }
}

fn write_atomic(path: &Path, body: &str) -> io::Result<()> {
    if let Some(p) = path.parent() {
        fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path)
}

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn presets_dir(&self) -> PathBuf {
        self.dir.join("presets")
    }

    /// User presets; unreadable files are reported, not fatal.
    pub fn load_presets(&self) -> (Vec<Preset>, Vec<String>) {
        let mut out = Vec::new();
        let mut warnings = Vec::new();
        let Ok(rd) = fs::read_dir(self.presets_dir()) else {
            return (out, warnings);
        };
        let mut paths: Vec<PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        paths.sort();
        for p in paths {
            match fs::read_to_string(&p)
                .map_err(|e| e.to_string())
                .and_then(|s| Preset::from_json(&s).map_err(|e| e.to_string()))
            {
                Ok(preset) => out.push(preset),
                Err(e) => warnings.push(format!("{}: {e}", p.display())),
            }
        }
        (out, warnings)
    }

    pub fn save_preset(&self, p: &Preset) -> io::Result<()> {
        write_atomic(
            &self.presets_dir().join(format!("{}.json", slug(&p.name))),
            &p.to_json(),
        )
    }

    pub fn delete_preset(&self, name: &str) -> io::Result<()> {
        match fs::remove_file(self.presets_dir().join(format!("{}.json", slug(name)))) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            r => r,
        }
    }

    pub fn load_setlist(&self) -> Option<Setlist> {
        let s = fs::read_to_string(self.dir.join("setlist.json")).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save_setlist(&self, s: &Setlist) -> io::Result<()> {
        write_atomic(
            &self.dir.join("setlist.json"),
            &serde_json::to_string_pretty(s).unwrap_or_default(),
        )
    }

    pub fn load_midi(&self) -> MidiMap {
        fs::read_to_string(self.dir.join("midi.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_midi(&self, m: &MidiMap) -> io::Result<()> {
        write_atomic(
            &self.dir.join("midi.json"),
            &serde_json::to_string_pretty(m).unwrap_or_default(),
        )
    }
}

/// Default data directory per OS (the desktop shell passes its own app-data dir instead).
pub fn default_dir() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.unwrap_or_else(std::env::temp_dir)
        .join("ro.mixai.live")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("live-store-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn slugs_are_filesystem_safe() {
        assert_eq!(slug("My Vocal / Live!"), "my-vocal-live");
        assert_eq!(slug("../../etc"), "etc");
        assert!(slug("🎤").starts_with("preset-"));
        assert_ne!(slug("🎤"), slug("🎸"));
    }

    #[test]
    fn round_trips_presets_setlist_and_midi() {
        let d = tmp("rt");
        let st = Store::new(&d);
        let mut p = crate::preset::factory().remove(0);
        p.name = "Mine".into();
        st.save_preset(&p).unwrap();
        fs::write(d.join("presets/broken.json"), "{").unwrap();
        let (loaded, warnings) = st.load_presets();
        assert_eq!(loaded, vec![p.clone()]);
        assert_eq!(warnings.len(), 1);
        st.delete_preset("Mine").unwrap();
        st.delete_preset("Mine").unwrap(); // idempotent
        assert!(st.load_presets().0.is_empty());

        let sl = Setlist {
            version: 1,
            name: "Gig".into(),
            songs: vec![],
        };
        st.save_setlist(&sl).unwrap();
        assert_eq!(st.load_setlist(), Some(sl));

        let m = MidiMap {
            channel: Some(3),
            ..MidiMap::default()
        };
        st.save_midi(&m).unwrap();
        assert_eq!(st.load_midi(), m);
        assert!(!d.join("midi.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
