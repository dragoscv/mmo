//! Rekordbox ANLZ analysis files (`PIONEER/USBANLZ/Pxxx/<hex>/ANLZ0000.DAT`
//! and `.EXT`). Magic `PMAI`. Contains tagged sections:
//!   PPTH  file path     PQTZ  beat grid       PCOB/PCO2  cue lists
//!   PWAV/PWV2  waveform preview   PWV3/PWV4/PWV5  detail/color waveforms
//!   PVBR  vbr index
//!
//! The `.DAT` holds the path, beat grid, memory/hot cues, and the small mono
//! waveform the CDJ shows while browsing. The `.EXT` holds the high-res color
//! waveform + extended (nxs2) cues. Reference: Deep-Symmetry ANLZ analysis.

use crate::contents::PlacedTrack;
use crate::manifest::{ExportOptions, Track};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

/// Build the on-USB ANLZ folder for a track id, mirroring rekordbox's
/// `USBANLZ/P<NNN>/<8-hex>/` scheme. The hex is derived from the track id.
fn anlz_dir(dest: &Path, track_id: u32, seq: usize) -> std::path::PathBuf {
    let bucket = format!("P{:03}", seq % 1000);
    let hex = format!("{:08X}", track_id);
    dest.join("PIONEER").join("USBANLZ").join(bucket).join(hex)
}

/// A tagged ANLZ section. ANLZ integers are BIG-endian. `len_header` is the
/// number of bytes from the tag start to where the variable body begins (it
/// varies per tag: 12 base + any fixed fields the reader treats as header).
/// `len_tag` is the total section length (header + body).
fn section(tag: &[u8; 4], len_header: u32, fixed: &[u8], body: &[u8]) -> Vec<u8> {
    let total: u32 = 12 + fixed.len() as u32 + body.len() as u32;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(tag);
    out.extend_from_slice(&len_header.to_be_bytes());
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(fixed);
    out.extend_from_slice(body);
    out
}

fn ppth(device_path: &str) -> Vec<u8> {
    // PPTH: lenHeader=16. fixed = u32 path byte-length (incl NUL terminator),
    // body = UTF-16BE path + NUL.
    let utf16: Vec<u16> = device_path.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = (utf16.len() * 2) as u32;
    let mut body = Vec::with_capacity(utf16.len() * 2);
    for u in utf16 {
        body.extend_from_slice(&u.to_be_bytes());
    }
    section(b"PPTH", 16, &byte_len.to_be_bytes(), &body)
}

fn pqtz(t: &Track) -> Option<Vec<u8>> {
    if t.beats.is_empty() {
        return None;
    }
    // PQTZ: lenHeader=24. fixed = u32 unknown(0), u32 unknown2(0x80000),
    // u32 beat_count. body = beats[] each {u16 beat_number, u16 tempo×100,
    // u32 time_ms}.
    let mut fixed = Vec::new();
    fixed.extend_from_slice(&0u32.to_be_bytes());
    fixed.extend_from_slice(&0x80000u32.to_be_bytes());
    fixed.extend_from_slice(&(t.beats.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(t.beats.len() * 8);
    for beat in &t.beats {
        body.extend_from_slice(&beat.beat_number.to_be_bytes());
        body.extend_from_slice(&((beat.bpm * 100.0) as u16).to_be_bytes());
        body.extend_from_slice(&(beat.position_ms as u32).to_be_bytes());
    }
    Some(section(b"PQTZ", 24, &fixed, &body))
}

fn pcob(t: &Track, opts: &ExportOptions) -> Vec<u8> {
    // Memory/hot cue list (PCOB = nxs1 cue list). Auto-insert a start memory
    // cue when the track has none and auto_cue is on.
    let mut cues: Vec<(f64, bool, u32, Option<&str>)> = t
        .cues
        .iter()
        .map(|c| (c.position_ms, c.is_hot, c.hot_index, c.label.as_deref()))
        .collect();
    if cues.is_empty() && opts.auto_cue {
        cues.push((0.0, false, 0, Some("Start")));
    }

    let mut entries = Vec::new();
    let mut count = 0u32;
    for (pos, is_hot, hot_index, _label) in &cues {
        let mut e = Vec::new();
        e.extend_from_slice(b"PCPT"); // cue point tag
        e.extend_from_slice(&0x1Cu32.to_be_bytes()); // len header
        e.extend_from_slice(&0x38u32.to_be_bytes()); // len entry
        let hot = if *is_hot { *hot_index + 1 } else { 0 };
        e.extend_from_slice(&hot.to_be_bytes()); // hot cue number (0=memory)
        e.extend_from_slice(&4u32.to_be_bytes()); // status: 4=active
        e.extend_from_slice(&0x10000u32.to_be_bytes()); // unknown
        e.extend_from_slice(&0u16.to_be_bytes()); // order_first
        e.extend_from_slice(&0u16.to_be_bytes()); // order_last
        e.push(if *is_hot { 1 } else { 0 }); // type: 1=hot,2=loop
        e.push(0);
        e.extend_from_slice(&0u16.to_be_bytes());
        e.extend_from_slice(&(*pos as u32).to_be_bytes()); // time ms
        e.extend_from_slice(&0xFFFFFFFFu32.to_be_bytes()); // loop_time (none)
        e.extend_from_slice(&[0u8; 16]); // unknown tail
        entries.extend_from_slice(&e);
        count += 1;
    }

    // PCOB: lenHeader=24. fixed = u32 type(0=memory,1=hot), u16 unknown,
    // u16 count, u32 memory_count. body = PCPT entries.
    let mut fixed = Vec::new();
    fixed.extend_from_slice(&0u32.to_be_bytes()); // type 0 = memory list
    fixed.extend_from_slice(&0u16.to_be_bytes()); // unknown
    fixed.extend_from_slice(&(count as u16).to_be_bytes());
    fixed.extend_from_slice(&(count).to_be_bytes()); // memory_count (u32)
    section(b"PCOB", 24, &fixed, &entries)
}

/// PWAV mono preview (400 bytes). lenHeader=20: fixed = u32 len_entry_bytes,
/// u32 0x10000.
fn pwav(samples: &[u8]) -> Option<Vec<u8>> {
    if samples.is_empty() {
        return None;
    }
    let mut fixed = Vec::new();
    fixed.extend_from_slice(&(samples.len() as u32).to_be_bytes());
    fixed.extend_from_slice(&0x10000u32.to_be_bytes());
    Some(section(b"PWAV", 20, &fixed, samples))
}

/// Generic PWV waveform section. lenHeader=24: fixed = u32 len_entry (bytes per
/// column), u32 entries, u32 flags. `data` = entries × len_entry bytes.
fn pwv(tag: &[u8; 4], len_entry: u32, flags: u32, data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() {
        return None;
    }
    let entries = (data.len() as u32) / len_entry;
    let mut fixed = Vec::new();
    fixed.extend_from_slice(&len_entry.to_be_bytes());
    fixed.extend_from_slice(&entries.to_be_bytes());
    fixed.extend_from_slice(&flags.to_be_bytes());
    Some(section(tag, 24, &fixed, data))
}

/// PWV3 — full-res scroll waveform (1 byte/column: low 5 bits height, top 3
/// bits whiteness). flags 0x960000.
fn pwv3(samples: &[u8]) -> Option<Vec<u8>> {
    pwv(b"PWV3", 1, 0x960000, samples)
}

/// PWV5 — color scroll waveform (2 bytes/column). flags 0x960305. The CDJ-3000
/// uses this for its color waveform display.
fn pwv5(color: &[u8]) -> Option<Vec<u8>> {
    pwv(b"PWV5", 2, 0x960305, color)
}

/// PWV4 — color preview waveform (6 bytes/column, 1200 columns). flags 0.
#[allow(dead_code)]
fn pwv4(color_preview: &[u8]) -> Option<Vec<u8>> {
    pwv(b"PWV4", 6, 0, color_preview)
}

/// Derive a full-res mono waveform (PWV3) from the detail samples (height 0-31
/// in low 5 bits, whiteness in top 3). Falls back to scaling the 0-255 input.
fn to_pwv3_bytes(detail: &[u8]) -> Vec<u8> {
    detail
        .iter()
        .map(|&v| {
            let height = (v >> 3) & 0x1F; // 0-31
            let whiteness = 0x05u8; // mid whiteness
            (whiteness << 5) | height
        })
        .collect()
}

/// Derive a 2-byte color waveform column (PWV5) from a mono height sample.
/// Encoding: byte0 = (d<<5)|blue? Pioneer packs RGB+height into 2 bytes; we
/// approximate a neutral blue/white scheme keyed on height so the CDJ shows a
/// real waveform shape even without true spectral color analysis.
fn to_pwv5_bytes(detail: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(detail.len() * 2);
    for &v in detail {
        let height = (v >> 3) & 0x1F; // 0-31
        // 2-byte little color word: 5 bits each r/g/b + height nibble.
        let r = (height / 2) & 0x07;
        let g = (height / 2) & 0x07;
        let blue = 0x07u8;
        let b0 = (r << 5) | (g << 2) | (blue >> 1);
        let b1 = ((blue & 1) << 7) | (height << 2);
        out.push(b0);
        out.push(b1);
    }
    out
}

fn assemble_anlz(sections: &[Vec<u8>]) -> Vec<u8> {
    let mut body = Vec::new();
    for s in sections {
        body.extend_from_slice(s);
    }
    // File header: PMAI, len_header(u32 be)=0x1C, len_file(u32 be), pad to 0x1C.
    let len_header: u32 = 0x1C;
    let len_file = len_header + body.len() as u32;
    let mut out = Vec::with_capacity(len_file as usize);
    out.extend_from_slice(b"PMAI");
    out.extend_from_slice(&len_header.to_be_bytes());
    out.extend_from_slice(&len_file.to_be_bytes());
    out.extend_from_slice(&[0u8; 0x10]); // unknown header padding
    out.extend_from_slice(&body);
    out
}

/// Write `.DAT` (+ `.EXT`) for every track. Returns true if anything written.
pub fn write_all(
    dest: &Path,
    tracks: &[Track],
    placed: &[PlacedTrack],
    opts: &ExportOptions,
    mut progress: impl FnMut(u32, u32),
) -> std::io::Result<bool> {
    let placed_by_id: BTreeMap<u32, &PlacedTrack> = placed.iter().map(|p| (p.id, p)).collect();
    let total = tracks.len() as u32;
    let mut wrote = false;

    for (seq, t) in tracks.iter().enumerate() {
        let Some(pt) = placed_by_id.get(&t.id) else {
            progress(seq as u32 + 1, total);
            continue;
        };
        let dir = anlz_dir(dest, t.id, seq);
        std::fs::create_dir_all(&dir)?;

        // .DAT: path + beatgrid + cues + mono waveform.
        let mut dat_sections = vec![ppth(&pt.device_path)];
        if let Some(q) = pqtz(t) {
            dat_sections.push(q);
        }
        dat_sections.push(pcob(t, opts));
        if let Some(w) = pwav(&t.waveform_preview) {
            dat_sections.push(w);
        }
        let dat = assemble_anlz(&dat_sections);
        std::fs::File::create(dir.join("ANLZ0000.DAT"))?.write_all(&dat)?;

        // .EXT: full-res + color waveforms (CDJ-3000 reads PWV5/PWV4) + nxs2
        // beatgrid/cues. Written when a detail waveform is available.
        if !t.waveform_detail.is_empty() {
            let mut ext_sections = vec![ppth(&pt.device_path)];
            if let Some(q) = pqtz(t) {
                ext_sections.push(q); // base beatgrid also lives in .EXT
            }
            if let Some(w) = pwv3(&to_pwv3_bytes(&t.waveform_detail)) {
                ext_sections.push(w);
            }
            if let Some(w) = pwv5(&to_pwv5_bytes(&t.waveform_detail)) {
                ext_sections.push(w);
            }
            let ext = assemble_anlz(&ext_sections);
            std::fs::File::create(dir.join("ANLZ0000.EXT"))?.write_all(&ext)?;
        }

        wrote = true;
        progress(seq as u32 + 1, total);
    }

    Ok(wrote)
}
