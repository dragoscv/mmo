//! Writes the `Contents/<Artist>/<Album>/<file>` audio tree on the USB and
//! returns, per track, the on-device relative path the databases must point to.
//!
//! CDJ audio compatibility: MP3, AAC/M4A, WAV, AIFF are universal; FLAC/ALAC on
//! newer gear. Incompatible containers (OGG/WMA/Opus) are transcoded to AAC
//! 320k when a policy + ffmpeg are provided. Source files are never modified.

use crate::manifest::{ExportOptions, Track, TranscodePolicy};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Extensions CDJ/XDJ players read directly (no transcode needed).
const COMPATIBLE_EXTS: &[&str] = &["mp3", "m4a", "aac", "wav", "aiff", "aif", "flac", "alac"];

/// Result of laying out the audio for one track.
pub struct PlacedTrack {
    pub id: u32,
    /// On-device path using the player's convention, e.g.
    /// `/Contents/Artist/Album/file.mp3` (forward slashes, leading slash).
    pub device_path: String,
    /// Absolute path on the USB (for ANLZ + size accounting).
    pub abs_path: PathBuf,
    pub bytes: u64,
}

fn sanitize(component: &str) -> String {
    let cleaned: String = component
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        // CDJ path components have practical length limits; keep them sane.
        trimmed.chars().take(120).collect()
    }
}

fn ext_lower(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_compatible(ext: &str) -> bool {
    COMPATIBLE_EXTS.contains(&ext)
}

/// Lay out all tracks under `<dest>/Contents`. Returns placement info and a
/// running byte total. `warn` is called for non-fatal issues.
pub fn place_tracks(
    dest: &Path,
    tracks: &[Track],
    opts: &ExportOptions,
    mut progress: impl FnMut(u32, u32),
    mut warn: impl FnMut(String),
) -> std::io::Result<(Vec<PlacedTrack>, u64)> {
    let contents_root = dest.join("Contents");
    std::fs::create_dir_all(&contents_root)?;

    let mut placed = Vec::with_capacity(tracks.len());
    let mut total_bytes: u64 = 0;
    // Avoid collisions when two tracks resolve to the same device path.
    let mut used: HashMap<String, u32> = HashMap::new();
    let total = tracks.len() as u32;

    for (i, t) in tracks.iter().enumerate() {
        let src = Path::new(&t.source_path);
        if !src.exists() {
            warn(format!("missing source file: {}", t.source_path));
            progress(i as u32 + 1, total);
            continue;
        }

        let artist = sanitize(t.artist.as_deref().unwrap_or("UnknownArtist"));
        let album = sanitize(t.album.as_deref().unwrap_or("UnknownAlbum"));
        let stem = src
            .file_stem()
            .and_then(|s| s.to_str())
            .map(sanitize)
            .unwrap_or_else(|| format!("track-{}", t.id));

        let mut ext = ext_lower(&t.source_path);
        let needs_transcode = match opts.transcode {
            TranscodePolicy::None => false,
            TranscodePolicy::Incompatible => !is_compatible(&ext),
            TranscodePolicy::All => true,
        };

        let mut file_name = if needs_transcode {
            ext = "m4a".to_string();
            format!("{stem}.m4a")
        } else {
            match src.extension().and_then(|e| e.to_str()) {
                Some(e) => format!("{stem}.{e}"),
                None => stem.clone(),
            }
        };

        // De-dupe device path.
        let mut rel = format!("Contents/{artist}/{album}/{file_name}");
        if let Some(n) = used.get_mut(&rel) {
            *n += 1;
            file_name = format!("{stem} ({}).{ext}", *n);
            rel = format!("Contents/{artist}/{album}/{file_name}");
        } else {
            used.insert(rel.clone(), 0);
        }

        let abs = dest.join(&rel);
        std::fs::create_dir_all(abs.parent().unwrap())?;

        // Idempotency: skip if same size already there (and not transcoding).
        let bytes = if needs_transcode {
            match transcode_aac(src, &abs, opts.ffmpeg_path.as_deref()) {
                Ok(b) => b,
                Err(e) => {
                    warn(format!("transcode failed for {}: {e}", t.source_path));
                    progress(i as u32 + 1, total);
                    continue;
                }
            }
        } else {
            copy_if_changed(src, &abs)?
        };

        total_bytes += bytes;
        placed.push(PlacedTrack {
            id: t.id,
            device_path: format!("/{}", rel.replace('\\', "/")),
            abs_path: abs,
            bytes,
        });
        progress(i as u32 + 1, total);
    }

    Ok((placed, total_bytes))
}

fn copy_if_changed(src: &Path, dst: &Path) -> std::io::Result<u64> {
    if let (Ok(s), Ok(d)) = (std::fs::metadata(src), std::fs::metadata(dst)) {
        if s.len() == d.len() {
            return Ok(d.len());
        }
    }
    std::fs::copy(src, dst)
}

fn transcode_aac(src: &Path, dst: &Path, ffmpeg: Option<&str>) -> std::io::Result<u64> {
    let bin = ffmpeg.unwrap_or("ffmpeg");
    let status = Command::new(bin)
        .args(["-y", "-i"])
        .arg(src)
        .args(["-c:a", "aac", "-b:a", "320k", "-movflags", "+faststart"])
        .arg(dst)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other("ffmpeg exited non-zero"));
    }
    Ok(std::fs::metadata(dst).map(|m| m.len()).unwrap_or(0))
}
