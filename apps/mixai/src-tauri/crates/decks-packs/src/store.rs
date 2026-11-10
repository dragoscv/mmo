//! Installed packs on disk: `<dir>/<id>.mixaipack` + `<dir>/index.json` (id -> sha256 +
//! installedAt). Every archive is re-verified on `list`; writes are atomic (tmp + rename) and
//! serialised by one mutex per store.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::{KeyTables, PackInfo, inspect_with, short, trust_rank, valid_pack_id};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    sha256: String,
    installed_at: u64,
}

type Index = BTreeMap<String, IndexEntry>;

/// A pack that is in the index but was skipped by [`PackStore::list`] (readable English reason).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedPack {
    pub id: String,
    pub reason: String,
}

/// Path-based pack store (the Tauri app passes its app-data `packs` dir, native apps their own).
pub struct PackStore {
    dir: PathBuf,
    keys: KeyTables<'static>,
    lock: Mutex<()>,
}

fn read_index(dir: &Path) -> Index {
    std::fs::read(dir.join("index.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write `bytes` to `path` through a sibling `.tmp` file and a rename (no torn files).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn write_index(dir: &Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("index.json"), &bytes)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PackStore {
    /// Store in `dir` (created on first write) verified against the built-in trust keys.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::with_keys(dir, crate::BUILTIN_KEYS)
    }

    /// Store with custom key tables (tests).
    pub fn with_keys(dir: impl Into<PathBuf>, keys: KeyTables<'static>) -> Self {
        Self {
            dir: dir.into(),
            keys,
            lock: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ensure_dir(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot create {}: {e}", self.dir.display()))
    }

    fn archive_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.mixaipack"))
    }

    /// Validate, verify and store a pack. A less trusted pack never replaces an installed one
    /// with the same id.
    pub fn install(&self, bytes: &[u8]) -> Result<PackInfo, String> {
        let mut info = inspect_with(bytes, &self.keys)?;
        self.ensure_dir()?;
        let _guard = self.guard();
        let path = self.archive_path(&info.manifest.id);
        if let Some(old) = std::fs::read(&path)
            .ok()
            .and_then(|b| inspect_with(&b, &self.keys).ok())
            && trust_rank(info.trust) < trust_rank(old.trust)
        {
            return Err(format!(
                "a more trusted pack with the id '{}' is already installed; remove it first",
                info.manifest.id
            ));
        }
        write_atomic(&path, bytes)?;
        let mut index = read_index(&self.dir);
        let installed_at = now_ms();
        index.insert(
            info.manifest.id.clone(),
            IndexEntry {
                sha256: info.sha256.clone(),
                installed_at,
            },
        );
        write_index(&self.dir, &index)?;
        info.installed_at = Some(installed_at);
        Ok(info)
    }

    /// Installed packs that still verify and match the index, plus the ones skipped (and why).
    pub fn list_detailed(&self) -> (Vec<PackInfo>, Vec<SkippedPack>) {
        let index = {
            let _guard = self.guard();
            read_index(&self.dir)
        };
        let mut out = Vec::new();
        let mut skipped = Vec::new();
        for (id, entry) in index {
            if !valid_pack_id(&id) {
                skipped.push(SkippedPack {
                    id: short(&id),
                    reason: "invalid id in the index".into(),
                });
                continue;
            }
            let bytes = match std::fs::read(self.archive_path(&id)) {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(SkippedPack {
                        reason: format!("cannot read archive: {e}"),
                        id,
                    });
                    continue;
                }
            };
            match inspect_with(&bytes, &self.keys) {
                Ok(mut info) if info.manifest.id == id && info.sha256 == entry.sha256 => {
                    info.installed_at = Some(entry.installed_at);
                    out.push(info);
                }
                Ok(_) => skipped.push(SkippedPack {
                    id,
                    reason: "stored archive does not match the index".into(),
                }),
                Err(e) => skipped.push(SkippedPack {
                    id,
                    reason: format!("no longer valid: {e}"),
                }),
            }
        }
        (out, skipped)
    }

    /// Installed packs that still verify and match the index.
    pub fn list(&self) -> Vec<PackInfo> {
        self.list_detailed().0
    }

    /// Delete a pack (no error when it is not installed).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        if !valid_pack_id(id) {
            return Err(format!("invalid pack id '{}'", short(id)));
        }
        let _guard = self.guard();
        let path = self.archive_path(id);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("cannot delete pack: {e}"))?;
        }
        let mut index = read_index(&self.dir);
        if index.remove(id).is_some() {
            write_index(&self.dir, &index)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PackTrust, sign_pack};
    use ed25519_dalek::SigningKey;
    use std::io::{Cursor, Write};

    const NO_KEYS: KeyTables<'static> = KeyTables {
        official: &[],
        verified: &[],
    };

    fn pack(id: &str, name: &str) -> Vec<u8> {
        let manifest = format!(
            r#"{{"v":1,"id":"{id}","name":"{name}","version":"1.0.0","kind":"skin","author":"Example","tokens":"tokens.json"}}"#
        );
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, b) in [
            ("manifest.json", manifest.as_bytes()),
            (
                "tokens.json",
                br##"{"mode":"light","colors":{"primary":"#112233"}}"##.as_slice(),
            ),
        ] {
            w.start_file(n, opts).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn install_list_remove_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = PackStore::with_keys(tmp.path().join("packs"), NO_KEYS);
        assert!(store.list().is_empty(), "missing dir = empty store");
        let info = store.install(&pack("com.example.skin.a", "A")).unwrap();
        assert!(info.installed_at.is_some());
        store.install(&pack("com.example.skin.b", "B")).unwrap();
        let ids: Vec<_> = store.list().into_iter().map(|p| p.manifest.id).collect();
        assert_eq!(ids, ["com.example.skin.a", "com.example.skin.b"]);
        store.remove("com.example.skin.a").unwrap();
        assert_eq!(store.list().len(), 1);
        store.remove("com.example.skin.a").unwrap();
        assert!(store.remove("../evil").is_err());
        assert!(
            !store.dir().join("index.tmp").exists(),
            "atomic write leaves no tmp"
        );
    }

    #[test]
    fn tampered_archive_on_disk_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let store = PackStore::with_keys(tmp.path(), NO_KEYS);
        store.install(&pack("com.example.skin.a", "A")).unwrap();
        std::fs::write(
            tmp.path().join("com.example.skin.a.mixaipack"),
            pack("com.example.skin.a", "Changed"),
        )
        .unwrap();
        let (ok, skipped) = store.list_detailed();
        assert!(ok.is_empty());
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].reason.contains("does not match"), "{skipped:?}");
    }

    #[test]
    fn less_trusted_pack_never_replaces_a_signed_one() {
        let tmp = tempfile::tempdir().unwrap();
        let store = PackStore::with_keys(tmp.path(), NO_KEYS);
        let key = SigningKey::from_bytes(&[5u8; 32]);
        let signed = sign_pack(&pack("com.example.skin.a", "A"), &key, "me-2026").unwrap();
        assert_eq!(store.install(&signed).unwrap().trust, PackTrust::Community);
        let err = store.install(&pack("com.example.skin.a", "A")).unwrap_err();
        assert!(err.contains("more trusted"), "{err}");
    }
}
