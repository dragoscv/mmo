//! On-disk state: user presets, the current setlist and the MIDI map, under one data directory.
//!
//! Layout (format v1, see `docs/live/presets.md` § Storage):
//!   <dir>/presets/<slug>.json   one user preset per file (factory presets are built in)
//!   <dir>/setlist.json          the last loaded setlist (restored on start)
//!   <dir>/midi.json             MIDI bindings
//!   <dir>/tokens.json           pairing tokens (kept so a restart does not unpair every client)
//!   <dir>/mix.json              the mix (faders, mute, bypass, the monitor option), restored on start
//! Writes go to `<file>.tmp` then rename, so a crash mid-write never leaves a torn file.

use crate::midi::MidiMap;
use crate::preset::{Preset, Setlist};
use crate::session::MixState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Store {
    dir: PathBuf,
}

/// One device pairing as it is written to disk: the token a phone, watch or browser uses, the role
/// it grants and the label the human list shows. One per device, so a single lost phone can be
/// revoked without unpairing the rest of the band.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredPairing {
    pub token: String,
    /// `viewer` | `performer` | `controller`.
    pub role: String,
    #[serde(default)]
    pub label: String,
}

/// Pairing state written once on the first start and reused afterwards, so a restart of the engine
/// process does not unpair every device.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredTokens {
    #[serde(default)]
    pub pairings: Vec<StoredPairing>,
    #[serde(default)]
    pub osc_performer: String,
    #[serde(default)]
    pub osc_controller: String,
    /// Legacy shape (one token per role), what every version before the per-device change wrote.
    /// Read once and turned into pairings, so an existing install does not have to be re-paired;
    /// never written back.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub viewer: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub performer: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub controller: String,
}

impl StoredTokens {
    /// The device pairings, migrating the per-role tokens of an older file the first time.
    pub fn devices(&self) -> Vec<StoredPairing> {
        if !self.pairings.is_empty() {
            return self.pairings.clone();
        }
        [
            ("viewer", &self.viewer),
            ("performer", &self.performer),
            ("controller", &self.controller),
        ]
        .into_iter()
        .filter(|(_, token)| !token.is_empty())
        .map(|(role, token)| StoredPairing {
            token: token.clone(),
            role: role.into(),
            label: String::new(),
        })
        .collect()
    }

    /// `true` when the file is usable as it is (at least one device and both OSC keys).
    pub fn ready(&self) -> bool {
        !self.devices().is_empty()
            && !self.osc_performer.is_empty()
            && !self.osc_controller.is_empty()
    }
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

    pub fn load_tokens(&self) -> Option<StoredTokens> {
        let s = fs::read_to_string(self.dir.join("tokens.json")).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save_tokens(&self, t: &StoredTokens) -> io::Result<()> {
        write_atomic(
            &self.dir.join("tokens.json"),
            &serde_json::to_string_pretty(t).unwrap_or_default(),
        )
    }

    pub fn load_mix(&self) -> Option<MixState> {
        let s = fs::read_to_string(self.dir.join("mix.json")).ok()?;
        serde_json::from_str(&s).ok()
    }

    pub fn save_mix(&self, m: &MixState) -> io::Result<()> {
        write_atomic(
            &self.dir.join("mix.json"),
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

    #[test]
    fn round_trips_tokens_and_mix() {
        let d = tmp("tokens-mix");
        let st = Store::new(&d);
        assert_eq!(st.load_tokens(), None, "nothing saved yet");
        assert!(st.load_mix().is_none());

        let t = StoredTokens {
            pairings: vec![
                StoredPairing {
                    token: "aa".into(),
                    role: "controller".into(),
                    label: "my phone".into(),
                },
                StoredPairing {
                    token: "bb".into(),
                    role: "viewer".into(),
                    label: String::new(),
                },
            ],
            osc_performer: "dd".into(),
            osc_controller: "ee".into(),
            ..Default::default()
        };
        st.save_tokens(&t).unwrap();
        assert_eq!(st.load_tokens(), Some(t.clone()));
        assert!(t.ready());
        assert_eq!(t.devices().len(), 2);
        // A file written before pairings were per device: one token per role, migrated on read.
        let legacy = StoredTokens {
            viewer: "v".into(),
            performer: "p".into(),
            controller: "c".into(),
            osc_performer: "op".into(),
            osc_controller: "oc".into(),
            ..Default::default()
        };
        assert!(legacy.ready());
        let migrated = legacy.devices();
        assert_eq!(migrated.len(), 3);
        assert_eq!(migrated[2].role, "controller");
        // Nothing usable: the host then mints fresh tokens.
        assert!(!StoredTokens::default().ready());

        let mix = MixState {
            main_db: -3.5,
            mute: true,
            monitor_untuned: true,
            ..MixState::default()
        };
        st.save_mix(&mix).unwrap();
        assert_eq!(st.load_mix(), Some(mix));
        assert!(!d.join("mix.json.tmp").exists());
        let _ = fs::remove_dir_all(&d);
    }
}
