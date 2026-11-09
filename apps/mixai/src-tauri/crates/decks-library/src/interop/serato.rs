//! Serato DJ: `_Serato_/Subcrates/*.crate` (binary, UTF-16BE tags) and the
//! `Serato Markers2` GEOB tag (base64 cue/loop/colour/BPM-lock entries).
//!
//! Crate format: a flat list of `tag(4 ASCII) + len(u32 BE) + payload`; `vrsn` holds the
//! version string, `otrk` containers hold one `ptrk` (track path relative to the volume
//! root, UTF-16BE). Nested crate names use `%%` as folder separator in the file name.
//! Mirrors apps/web/src/lib/serato-crate.ts (writer) and adds a reader.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

use crate::model::{Collection, Cue, CueKind, Playlist, Rgb, TrackRecord};
use crate::util::{normalize_lexically, path_key, sanitize_component};
use crate::{Error, Result};

pub const CRATE_VERSION: &str = "1.0/Serato ScratchLive Crate";

const DEFAULT_COLUMNS: [(&str, &str); 6] = [
    ("song", "551"),
    ("artist", "343"),
    ("bpm", "50"),
    ("key", "50"),
    ("album", "0"),
    ("length", "50"),
];

// ------------------------------------------------------------------ crate binary

fn utf16be(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(u16::to_be_bytes).collect()
}

fn from_utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_be_bytes(*c))
        .collect();
    String::from_utf16_lossy(&units)
}

fn tag(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + payload.len());
    v.extend_from_slice(name);
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

/// Splits a buffer into `(tag, payload)` pairs.
pub fn parse_tags(buf: &[u8]) -> Result<Vec<([u8; 4], &[u8])>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < buf.len() {
        if i + 8 > buf.len() {
            return Err(Error::Format("truncated crate: header past end".into()));
        }
        let name = [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
        let len = u32::from_be_bytes([buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]]) as usize;
        let end = i + 8 + len;
        if end > buf.len() {
            return Err(Error::Format(format!(
                "truncated crate: tag {} needs {len} bytes",
                String::from_utf8_lossy(&name)
            )));
        }
        out.push((name, &buf[i + 8..end]));
        i = end;
    }
    Ok(out)
}

/// Normalises a path to Serato's relative form: forward slashes, no leading slash.
pub fn to_crate_path(rel: &str) -> String {
    let mut p = rel.replace('\\', "/");
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    p.trim_start_matches('/').to_owned()
}

/// Builds a complete `.crate` file.
pub fn build_crate(relative_paths: &[String]) -> Vec<u8> {
    let mut out = tag(b"vrsn", &utf16be(CRATE_VERSION));
    let mut osrt = tag(b"tvcn", &utf16be("song"));
    osrt.extend(tag(b"brev", &[0]));
    out.extend(tag(b"osrt", &osrt));
    for (col, width) in DEFAULT_COLUMNS {
        let mut ovct = tag(b"tvcn", &utf16be(col));
        ovct.extend(tag(b"tvcw", &utf16be(width)));
        out.extend(tag(b"ovct", &ovct));
    }
    for p in relative_paths {
        let rel = to_crate_path(p);
        if !rel.is_empty() {
            out.extend(tag(b"otrk", &tag(b"ptrk", &utf16be(&rel))));
        }
    }
    out
}

/// Parsed crate.
#[derive(Debug, Clone, PartialEq)]
pub struct SeratoCrate {
    pub version: String,
    /// Paths relative to the volume root, in crate order.
    pub tracks: Vec<String>,
}

/// Reads a `.crate` buffer.
pub fn parse_crate(buf: &[u8]) -> Result<SeratoCrate> {
    let mut version = String::new();
    let mut tracks = Vec::new();
    for (name, payload) in parse_tags(buf)? {
        match &name {
            b"vrsn" => version = from_utf16be(payload),
            b"otrk" => {
                for (inner, p) in parse_tags(payload)? {
                    if &inner == b"ptrk" {
                        tracks.push(from_utf16be(p));
                    }
                }
            }
            _ => {}
        }
    }
    if !version.contains("Crate") {
        return Err(Error::Format(format!(
            "not a Serato crate (vrsn {version:?})"
        )));
    }
    Ok(SeratoCrate { version, tracks })
}

fn volume_relative(path: &str, volume_root: &Path) -> String {
    let root = path_key(&volume_root.to_string_lossy());
    let root = root.trim_end_matches('/');
    let norm = path.replace('\\', "/");
    if !root.is_empty() && path_key(&norm).starts_with(&format!("{root}/")) {
        norm[root.len() + 1..].to_owned()
    } else if norm.len() >= 2 && norm.as_bytes()[1] == b':' {
        norm[2..].to_owned()
    } else {
        norm
    }
}

/// Reads every crate under `serato_dir/Subcrates`.
pub fn read_crates_dir(serato_dir: &Path, volume_root: &Path) -> Result<Collection> {
    let sub = serato_dir.join("Subcrates");
    let mut entries: Vec<PathBuf> = fs::read_dir(&sub)?
        .filter_map(std::result::Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("crate"))
        })
        .collect();
    entries.sort();
    let mut col = Collection::default();
    let mut seen = std::collections::HashSet::new();
    for file in entries {
        let parsed = parse_crate(&fs::read(&file)?)?;
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut parts: Vec<String> = stem.split("%%").map(str::to_owned).collect();
        let name = parts.pop().unwrap_or_default();
        let tracks: Vec<String> = parsed
            .tracks
            .iter()
            .map(|rel| {
                crate::util::path_to_string(&normalize_lexically(&volume_root.join(rel)))
                    .replace('\\', "/")
            })
            .collect();
        for t in &tracks {
            if seen.insert(path_key(t)) {
                col.tracks.push(TrackRecord {
                    path: t.clone(),
                    ..TrackRecord::default()
                });
            }
        }
        col.playlists.push(Playlist {
            name,
            folder: parts,
            tracks,
        });
    }
    Ok(col)
}

/// Writes one crate per playlist into `serato_dir/Subcrates` (folders joined with `%%`).
pub fn write_crates_dir(col: &Collection, serato_dir: &Path, volume_root: &Path) -> Result<()> {
    let sub = serato_dir.join("Subcrates");
    fs::create_dir_all(&sub)?;
    for pl in &col.playlists {
        let mut parts: Vec<String> = pl.folder.iter().map(|f| sanitize_component(f)).collect();
        parts.push(sanitize_component(&pl.name));
        let rel: Vec<String> = pl
            .tracks
            .iter()
            .map(|p| volume_relative(p, volume_root))
            .collect();
        fs::write(
            sub.join(format!("{}.crate", parts.join("%%"))),
            build_crate(&rel),
        )?;
    }
    Ok(())
}

// ------------------------------------------------------------------ Markers2

/// Decoded `Serato Markers2` content.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Markers2 {
    pub track_colour: Option<Rgb>,
    pub bpm_lock: Option<bool>,
    pub cues: Vec<Cue>,
    /// Entries we do not interpret (`FLIP`, unknown), kept for lossless rewrite.
    pub unknown: Vec<(String, Vec<u8>)>,
}

fn lenient_b64() -> GeneralPurpose {
    GeneralPurpose::new(
        &STANDARD,
        GeneralPurposeConfig::new()
            .with_encode_padding(false)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
}

fn cstr(b: &[u8]) -> (String, usize) {
    let end = b.iter().position(|&x| x == 0).unwrap_or(b.len());
    (
        String::from_utf8_lossy(&b[..end]).into_owned(),
        (end + 1).min(b.len()),
    )
}

fn be_u32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

/// Parses the GEOB frame payload (after the frame's MIME/filename/description headers):
/// `0x01 0x01` + base64 text (newline-wrapped, padding dropped) + NUL padding.
pub fn parse_markers2(geob_payload: &[u8]) -> Result<Markers2> {
    let body = geob_payload
        .strip_prefix(&[0x01, 0x01])
        .ok_or_else(|| Error::Format("Markers2: missing 0x0101 header".into()))?;
    let mut text: Vec<u8> = body
        .iter()
        .copied()
        .take_while(|&b| b != 0)
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if text.len() % 4 == 1 {
        text.pop(); // Serato emits one stray trailing char in some writes
    }
    let decoded = lenient_b64()
        .decode(&text)
        .map_err(|e| Error::Format(format!("Markers2 base64: {e}")))?;
    parse_markers2_decoded(&decoded)
}

/// Parses already base64-decoded Markers2 bytes (FLAC/MP4 store them that way after decoding
/// the `SERATO_MARKERS_V2` comment).
pub fn parse_markers2_decoded(d: &[u8]) -> Result<Markers2> {
    let mut b = d
        .strip_prefix(&[0x01, 0x01])
        .ok_or_else(|| Error::Format("Markers2: missing inner 0x0101 header".into()))?;
    let mut m = Markers2::default();
    while !b.is_empty() && b[0] != 0 {
        let (name, used) = cstr(b);
        b = &b[used..];
        let len = be_u32(b, 0).ok_or_else(|| Error::Format("Markers2: truncated length".into()))?
            as usize;
        let data = b
            .get(4..4 + len)
            .ok_or_else(|| Error::Format(format!("Markers2: truncated {name}")))?;
        b = &b[4 + len..];
        match name.as_str() {
            "COLOR" if data.len() >= 4 => {
                m.track_colour = Some(Rgb::new(data[1], data[2], data[3]))
            }
            "BPMLOCK" if !data.is_empty() => m.bpm_lock = Some(data[0] != 0),
            "CUE" if data.len() >= 12 => {
                let pos = be_u32(data, 2).unwrap_or(0);
                let (label, _) = cstr(&data[12..]);
                m.cues.push(Cue {
                    kind: CueKind::Hot,
                    index: Some(data[1]),
                    start_sec: f64::from(pos) / 1000.0,
                    end_sec: None,
                    colour: Some(Rgb::new(data[7], data[8], data[9])),
                    label: Some(label).filter(|s| !s.is_empty()),
                });
            }
            // 0x00, idx, start u32, end u32, ff ff ff ff, 0x00 r g b, locked, name\0
            "LOOP" if data.len() >= 20 => {
                let start = be_u32(data, 2).unwrap_or(0);
                let end = be_u32(data, 6).unwrap_or(0);
                let (label, _) = cstr(&data[19..]);
                m.cues.push(Cue {
                    kind: CueKind::Loop,
                    index: Some(data[1]),
                    start_sec: f64::from(start) / 1000.0,
                    end_sec: Some(f64::from(end) / 1000.0),
                    colour: Some(Rgb::new(data[15], data[16], data[17])),
                    label: Some(label).filter(|s| !s.is_empty()),
                });
            }
            _ => m.unknown.push((name, data.to_vec())),
        }
    }
    Ok(m)
}

fn entry(out: &mut Vec<u8>, name: &str, data: &[u8]) {
    out.extend_from_slice(name.as_bytes());
    out.push(0);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
}

fn ms(sec: f64) -> [u8; 4] {
    ((sec * 1000.0).round().max(0.0) as u32).to_be_bytes()
}

/// Encodes decoded Markers2 bytes (`0x01 0x01` + entries + NUL).
pub fn encode_markers2_decoded(m: &Markers2) -> Vec<u8> {
    let mut out = vec![0x01, 0x01];
    if let Some(c) = m.track_colour {
        entry(&mut out, "COLOR", &[0, c.r, c.g, c.b]);
    }
    for c in &m.cues {
        let colour = c.colour.unwrap_or(Rgb::new(0xCC, 0, 0));
        let label = c.label.as_deref().unwrap_or("");
        match c.kind {
            CueKind::Loop => {
                let mut d = vec![0, c.index.unwrap_or(0)];
                d.extend_from_slice(&ms(c.start_sec));
                d.extend_from_slice(&ms(c.end_sec.unwrap_or(c.start_sec)));
                d.extend_from_slice(&[
                    0xFF, 0xFF, 0xFF, 0xFF, 0x00, colour.r, colour.g, colour.b, 0x00,
                ]);
                d.extend_from_slice(label.as_bytes());
                d.push(0);
                entry(&mut out, "LOOP", &d);
            }
            // Serato has only indexed hot cues; memory cues take the next free slot.
            _ => {
                let mut d = vec![0, c.index.unwrap_or(0)];
                d.extend_from_slice(&ms(c.start_sec));
                d.extend_from_slice(&[0, colour.r, colour.g, colour.b, 0, 0]);
                d.extend_from_slice(label.as_bytes());
                d.push(0);
                entry(&mut out, "CUE", &d);
            }
        }
    }
    for (name, data) in &m.unknown {
        entry(&mut out, name, data);
    }
    if let Some(lock) = m.bpm_lock {
        entry(&mut out, "BPMLOCK", &[u8::from(lock)]);
    }
    out.push(0);
    out
}

/// Encodes the GEOB frame payload: `0x01 0x01` + base64 wrapped at 72 chars + NUL padding
/// to at least 470 bytes (what Serato writes).
pub fn encode_markers2(m: &Markers2) -> Vec<u8> {
    let b64 = lenient_b64().encode(encode_markers2_decoded(m));
    let mut out = vec![0x01, 0x01];
    for (i, chunk) in b64.as_bytes().chunks(72).enumerate() {
        if i > 0 {
            out.push(b'\n');
        }
        out.extend_from_slice(chunk);
    }
    out.push(0);
    if out.len() < 470 {
        out.resize(470, 0);
    }
    out
}

/// Assigns free hot-cue slots to cues that have none (Serato needs an index for every cue).
pub fn assign_slots(cues: &[Cue]) -> Vec<Cue> {
    let mut used: Vec<u8> = cues.iter().filter_map(|c| c.index).collect();
    cues.iter()
        .map(|c| {
            let mut c = c.clone();
            if c.index.is_none() {
                let free = (0u8..=255).find(|i| !used.contains(i)).unwrap_or(0);
                used.push(free);
                c.index = Some(free);
            }
            c
        })
        .collect()
}

// ------------------------------------------------------------------ ID3v2 GEOB scan

fn syncsafe(b: &[u8]) -> usize {
    b.iter()
        .take(4)
        .fold(0usize, |acc, x| (acc << 7) | usize::from(x & 0x7F))
}

/// Finds a GEOB frame by description in an ID3v2.3/2.4 tag at the start of `data` and
/// returns its object bytes. Unsynchronised tags are not supported (Serato never writes them).
pub fn find_geob(data: &[u8], description: &str) -> Option<Vec<u8>> {
    if data.len() < 10 || &data[..3] != b"ID3" {
        return None;
    }
    let major = data[3];
    let flags = data[5];
    let size = syncsafe(&data[6..10]);
    let end = (10 + size).min(data.len());
    let mut i = 10;
    if flags & 0x40 != 0 {
        let ext = if major == 4 {
            syncsafe(data.get(10..14)?)
        } else {
            u32::from_be_bytes(data.get(10..14)?.try_into().ok()?) as usize + 4
        };
        i += ext;
    }
    while i + 10 <= end {
        let id = &data[i..i + 4];
        if id[0] == 0 {
            break;
        }
        let fsize = if major == 4 {
            syncsafe(&data[i + 4..i + 8])
        } else {
            u32::from_be_bytes(data[i + 4..i + 8].try_into().ok()?) as usize
        };
        let body = data.get(i + 10..i + 10 + fsize)?;
        if id == b"GEOB" && !body.is_empty() {
            let enc = body[0];
            let mut p = 1;
            let mime_end = body[p..].iter().position(|&b| b == 0)? + p;
            p = mime_end + 1;
            let (_, desc, rest) = split_encoded(&body[p..], enc)?;
            if desc == description {
                return Some(rest.to_vec());
            }
        }
        i += 10 + fsize;
    }
    None
}

fn split_encoded(b: &[u8], enc: u8) -> Option<(String, String, &[u8])> {
    if enc == 1 || enc == 2 {
        let term = |s: &[u8]| {
            s.as_chunks::<2>()
                .0
                .iter()
                .position(|c| *c == [0, 0])
                .map(|p| p * 2)
        };
        let e1 = term(b)?;
        let f = from_utf16_any(&b[..e1]);
        let r = &b[e1 + 2..];
        let e2 = term(r)?;
        let d = from_utf16_any(&r[..e2]);
        Some((f, d, &r[e2 + 2..]))
    } else {
        let e1 = b.iter().position(|&x| x == 0)?;
        let r = &b[e1 + 1..];
        let e2 = r.iter().position(|&x| x == 0)?;
        Some((
            String::from_utf8_lossy(&b[..e1]).into_owned(),
            String::from_utf8_lossy(&r[..e2]).into_owned(),
            &r[e2 + 1..],
        ))
    }
}

fn from_utf16_any(b: &[u8]) -> String {
    match b {
        [0xFF, 0xFE, rest @ ..] => {
            let u: Vec<u16> = rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            String::from_utf16_lossy(&u)
        }
        [0xFE, 0xFF, rest @ ..] => from_utf16be(rest),
        other => from_utf16be(other),
    }
}

/// Reads `Serato Markers2` from an MP3/AIFF file's ID3v2 tag, if present.
pub fn read_markers2_from_file(path: &Path) -> Result<Option<Markers2>> {
    use std::io::Read as _;
    let mut f = fs::File::open(path)?;
    let mut head = vec![0u8; 10];
    if f.read_exact(&mut head).is_err() || &head[..3] != b"ID3" {
        return Ok(None);
    }
    let size = syncsafe(&head[6..10]);
    let mut tag = head;
    f.take(size as u64).read_to_end(&mut tag)?;
    find_geob(&tag, "Serato Markers2")
        .map(|p| parse_markers2(&p))
        .transpose()
}
