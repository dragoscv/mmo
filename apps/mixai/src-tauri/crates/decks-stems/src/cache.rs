//! Content-addressed stem cache: `<root>/<key>/{vocals,drums,bass,other}.wav` (32-bit float stereo),
//! the same file names the MMO Server analyzer writes, so server downloads drop straight in.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::{Result, StemKind, StemLayer, Stems, StemsError};

/// Bump when the model or post-processing changes so stale stems are not reused.
pub const CACHE_VERSION: &str = "htdemucs-v1";

/// Cache key = sha256(version ‖ model id ‖ first 4 MiB of the file ‖ file length), hex, 32 chars.
/// Hashing a prefix keeps keying a 100 MB WAV at a few ms; the length catches re-encodes.
pub fn cache_key(path: &Path, model_id: &str) -> Result<String> {
    let mut f = fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut n = 0;
    while n < buf.len() {
        let r = f.read(&mut buf[n..])?;
        if r == 0 {
            break;
        }
        n += r;
    }
    let mut h = Sha256::new();
    h.update(CACHE_VERSION.as_bytes());
    h.update([0]);
    h.update(model_id.as_bytes());
    h.update([0]);
    h.update(&buf[..n]);
    h.update(len.to_le_bytes());
    let digest = h.finalize();
    Ok(digest.iter().take(16).map(|b| format!("{b:02x}")).collect())
}

/// Directory of cached stem sets.
#[derive(Clone, Debug)]
pub struct StemCache {
    root: PathBuf,
}

impl StemCache {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }

    pub fn stem_path(&self, key: &str, kind: StemKind) -> PathBuf {
        self.dir(key).join(format!("{}.wav", kind.file_name()))
    }

    /// All four stems present.
    pub fn contains(&self, key: &str) -> bool {
        valid_key(key)
            && StemKind::CORE_ORDER
                .iter()
                .all(|k| self.stem_path(key, *k).is_file())
    }

    /// Write atomically (temp dir + rename) so a crash never leaves a half set.
    pub fn store(&self, key: &str, stems: &Stems) -> Result<PathBuf> {
        if !valid_key(key) {
            return Err(StemsError::Cache(format!("invalid key {key:?}")));
        }
        fs::create_dir_all(&self.root)?;
        let tmp = self.root.join(format!(".{key}.tmp"));
        if tmp.exists() {
            fs::remove_dir_all(&tmp)?;
        }
        fs::create_dir_all(&tmp)?;
        for kind in StemKind::CORE_ORDER {
            write_wav(
                &tmp.join(format!("{}.wav", kind.file_name())),
                stems.layer(kind),
                stems.sample_rate,
            )?;
        }
        let dir = self.dir(key);
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::rename(&tmp, &dir)?;
        Ok(dir)
    }

    /// Load a complete set; `None` when any stem is missing.
    pub fn load(&self, key: &str) -> Result<Option<Stems>> {
        if !self.contains(key) {
            return Ok(None);
        }
        let mut layers: [StemLayer; 4] = Default::default();
        let mut rate = 0;
        for kind in StemKind::CORE_ORDER {
            let (layer, r) = read_wav(&self.stem_path(key, kind))?;
            if rate != 0 && r != rate {
                return Err(StemsError::Cache(format!(
                    "mixed sample rates {rate} / {r}"
                )));
            }
            rate = r;
            layers[kind.core_index()] = layer;
        }
        Ok(Some(Stems {
            sample_rate: rate,
            layers,
        }))
    }

    /// Remove sets until the cache is at most `max_bytes`, oldest modification first. Returns bytes freed.
    pub fn prune(&self, max_bytes: u64) -> Result<u64> {
        let Ok(rd) = fs::read_dir(&self.root) else {
            return Ok(0);
        };
        let mut sets = Vec::new();
        let mut total = 0u64;
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() || !e.file_name().to_str().is_some_and(valid_key) {
                continue;
            }
            let mut size = 0u64;
            let mut mtime = std::time::SystemTime::UNIX_EPOCH;
            for f in fs::read_dir(&p)?.flatten() {
                if let Ok(m) = f.metadata() {
                    size += m.len();
                    mtime = mtime.max(m.modified().unwrap_or(mtime));
                }
            }
            total += size;
            sets.push((mtime, size, p));
        }
        sets.sort_by_key(|s| s.0);
        let mut freed = 0u64;
        for (_, size, p) in sets {
            if total - freed <= max_bytes {
                break;
            }
            fs::remove_dir_all(&p)?;
            freed += size;
        }
        Ok(freed)
    }
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn write_wav(path: &Path, layer: &StemLayer, rate: u32) -> Result<()> {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w =
        hound::WavWriter::create(path, spec).map_err(|e| StemsError::Cache(e.to_string()))?;
    for (l, r) in layer.left.iter().zip(&layer.right) {
        w.write_sample(*l)
            .map_err(|e| StemsError::Cache(e.to_string()))?;
        w.write_sample(*r)
            .map_err(|e| StemsError::Cache(e.to_string()))?;
    }
    w.finalize().map_err(|e| StemsError::Cache(e.to_string()))
}

/// Reads float or 16/24/32-bit int WAVs (the server writes 16-bit PCM), mono is duplicated.
fn read_wav(path: &Path) -> Result<(StemLayer, u32)> {
    let mut r = hound::WavReader::open(path)
        .map_err(|e| StemsError::Cache(format!("{}: {e}", path.display())))?;
    let spec = r.spec();
    let ch = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<std::result::Result<_, _>>(),
        hound::SampleFormat::Int => {
            let scale = 1.0 / (1u64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            r.samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<std::result::Result<_, _>>()
        }
    }
    .map_err(|e| StemsError::Cache(e.to_string()))?;
    let frames = samples.len() / ch;
    let mut layer = StemLayer {
        left: Vec::with_capacity(frames),
        right: Vec::with_capacity(frames),
    };
    for f in samples.chunks_exact(ch) {
        layer.left.push(f[0]);
        layer.right.push(if ch > 1 { f[1] } else { f[0] });
    }
    Ok((layer, spec.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stems(frames: usize, rate: u32) -> Stems {
        let mk = |g: f32| StemLayer {
            left: (0..frames).map(|i| (i as f32 * 0.01).sin() * g).collect(),
            right: (0..frames).map(|i| (i as f32 * 0.02).cos() * g).collect(),
        };
        Stems {
            sample_rate: rate,
            layers: [mk(0.1), mk(0.2), mk(0.3), mk(0.4)],
        }
    }

    #[test]
    fn store_then_load_round_trips_bit_exact() {
        let d = tempfile::tempdir().unwrap();
        let c = StemCache::new(d.path());
        let s = stems(2000, 48_000);
        assert!(!c.contains("abc"));
        c.store("abc", &s).unwrap();
        assert!(c.contains("abc"));
        assert!(c.stem_path("abc", StemKind::Vocals).ends_with("vocals.wav"));
        assert_eq!(c.load("abc").unwrap(), Some(s));
        assert!(!d.path().join(".abc.tmp").exists());
    }

    #[test]
    fn missing_stem_means_not_cached() {
        let d = tempfile::tempdir().unwrap();
        let c = StemCache::new(d.path());
        c.store("k1", &stems(10, 44_100)).unwrap();
        fs::remove_file(c.stem_path("k1", StemKind::Bass)).unwrap();
        assert!(!c.contains("k1"));
        assert_eq!(c.load("k1").unwrap(), None);
    }

    #[test]
    fn reads_server_style_16_bit_pcm() {
        let d = tempfile::tempdir().unwrap();
        let c = StemCache::new(d.path());
        fs::create_dir_all(c.dir("srv")).unwrap();
        for kind in StemKind::CORE_ORDER {
            let spec = hound::WavSpec {
                channels: 2,
                sample_rate: 44_100,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut w = hound::WavWriter::create(c.stem_path("srv", kind), spec).unwrap();
            for _ in 0..4 {
                w.write_sample(16384i16).unwrap();
                w.write_sample(-32768i16).unwrap();
            }
            w.finalize().unwrap();
        }
        let s = c.load("srv").unwrap().unwrap();
        assert_eq!(s.sample_rate, 44_100);
        assert_eq!(s.frames(), 4);
        assert!((s.layers[0].left[0] - 0.5).abs() < 1e-6);
        assert!((s.layers[0].right[0] + 1.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_path_traversal_keys() {
        let d = tempfile::tempdir().unwrap();
        let c = StemCache::new(d.path());
        assert!(c.store("../x", &stems(4, 44_100)).is_err());
        assert!(!c.contains("../x"));
    }

    #[test]
    fn key_depends_on_content_and_model() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a.bin");
        let b = d.path().join("b.bin");
        fs::write(&a, b"hello world").unwrap();
        fs::write(&b, b"hello world!").unwrap();
        let ka = cache_key(&a, "htdemucs").unwrap();
        assert_eq!(ka.len(), 32);
        assert_eq!(ka, cache_key(&a, "htdemucs").unwrap());
        assert_ne!(ka, cache_key(&b, "htdemucs").unwrap());
        assert_ne!(ka, cache_key(&a, "htdemucs_6s").unwrap());
    }

    #[test]
    fn prune_drops_oldest_sets_first() {
        let d = tempfile::tempdir().unwrap();
        let c = StemCache::new(d.path());
        c.store("old", &stems(1000, 44_100)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        c.store("new", &stems(1000, 44_100)).unwrap();
        let one_set: u64 = fs::read_dir(c.dir("new"))
            .unwrap()
            .flatten()
            .map(|e| e.metadata().unwrap().len())
            .sum();
        let freed = c.prune(one_set).unwrap();
        assert_eq!(freed, one_set);
        assert!(!c.contains("old"));
        assert!(c.contains("new"));
        assert_eq!(c.prune(u64::MAX).unwrap(), 0);
    }
}
