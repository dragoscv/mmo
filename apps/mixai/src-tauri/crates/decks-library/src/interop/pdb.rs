//! rekordbox device export (`PIONEER/rekordbox/export.pdb`, DeviceSQL), read only.
//!
//! Native reader following the public reverse-engineering notes
//! (<https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html>).
//! rekordcrate 0.3 (MPL-2.0) was evaluated: it parses the same structures but keeps the
//! `Track` / `PlaylistEntry` fields private with no accessors, and its `Page` type is not
//! writable — so neither reading nor writing could go through it.
//!
//! Read: tracks (title, artist, album, genre, label, key, BPM, duration, bitrate, sample rate,
//! year, rating, colour, play count, comment, date added, file path) and the playlist tree.
//! Not read: cues, beat grids and waveforms (they live in `PIONEER/USBANLZ/*.DAT|EXT`).

use std::collections::HashMap;
use std::path::Path;

use crate::colour::rekordbox_track_colour;
use crate::keys::MusicalKey;
use crate::model::{Collection, Playlist, TrackRecord};
use crate::util::{normalize_lexically, parse_date};
use crate::{Error, Result};

const PAGE_HEADER: usize = 0x28;

/// Playlist tree row: (parent id, sort order, is folder, name).
type TreeNode = (u32, u32, bool, String);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PageType {
    Tracks = 0,
    Genres = 1,
    Artists = 2,
    Albums = 3,
    Labels = 4,
    Keys = 5,
    PlaylistTree = 7,
    PlaylistEntries = 8,
}

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// Decodes a DeviceSQL string at `at`.
pub fn device_string(b: &[u8], at: usize) -> Option<String> {
    let kind = *b.get(at)?;
    if kind & 1 == 1 {
        let len = usize::from(kind >> 1).checked_sub(1)?;
        return b
            .get(at + 1..at + 1 + len)
            .map(|s| String::from_utf8_lossy(s).into_owned());
    }
    let len = usize::from(u16le(b, at + 1)?).checked_sub(4)?;
    let body = b.get(at + 4..at + 4 + len)?;
    match kind {
        0x40 => Some(String::from_utf8_lossy(body).into_owned()),
        0x90 => {
            let units: Vec<u16> = body
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// Byte offsets (absolute, into the file) of every present row of a table.
fn table_rows(file: &[u8], page_size: usize, first: u32, last: u32) -> Vec<usize> {
    let mut rows = Vec::new();
    let mut idx = first as usize;
    let mut guard = 0;
    loop {
        let base = idx * page_size;
        let Some(page) = file.get(base..base + page_size) else {
            break;
        };
        let next = u32le(page, 0x0C).unwrap_or(u32::MAX) as usize;
        let small = u16::from(page[0x18]);
        let flags = page[0x1B];
        let large = u16le(page, 0x22).unwrap_or(0);
        let num = if large > small && large != 0x1FFF {
            large
        } else {
            small
        };
        if flags & 0x40 == 0 && num > 0 {
            let groups = usize::from(num).div_ceil(16);
            for g in 0..groups {
                let end = page_size - g * 36;
                let present = u16le(page, end - 4).unwrap_or(0);
                for i in 0..16 {
                    if present & (1 << i) != 0
                        && let Some(off) = u16le(page, end - 4 - 2 * (i + 1))
                    {
                        rows.push(base + PAGE_HEADER + usize::from(off));
                    }
                }
            }
        }
        guard += 1;
        if idx == last as usize || guard > 1_000_000 || next == idx {
            break;
        }
        idx = next;
    }
    rows
}

fn name_row(file: &[u8], row: usize, id_at: usize, str_at: usize) -> Option<(u32, String)> {
    Some((
        u32le(file, row + id_at)?,
        device_string(file, row + str_at)?,
    ))
}

/// Reads `export.pdb`; track paths are joined onto `volume_root`.
pub fn read(path: &Path, volume_root: &Path) -> Result<Collection> {
    parse(&std::fs::read(path)?, volume_root)
}

/// Parses an `export.pdb` buffer.
pub fn parse(file: &[u8], volume_root: &Path) -> Result<Collection> {
    if u32le(file, 0) != Some(0) {
        return Err(Error::Format(
            "not a DeviceSQL export (bad signature)".into(),
        ));
    }
    let page_size = u32le(file, 4).unwrap_or(0) as usize;
    let num_tables = u32le(file, 8).unwrap_or(0) as usize;
    if !(512..=65_536).contains(&page_size) || num_tables > 64 {
        return Err(Error::Format("implausible PDB header".into()));
    }
    let mut tables: HashMap<u32, (u32, u32)> = HashMap::new();
    for t in 0..num_tables {
        let at = 0x1C + t * 16;
        let ty = u32le(file, at).unwrap_or(u32::MAX);
        let first = u32le(file, at + 8).unwrap_or(0);
        let last = u32le(file, at + 12).unwrap_or(0);
        tables.insert(ty, (first, last));
    }
    let rows = |ty: PageType| {
        tables
            .get(&(ty as u32))
            .map(|(f, l)| table_rows(file, page_size, *f, *l))
            .unwrap_or_default()
    };

    let simple = |ty: PageType, id_at: usize, str_at: usize| -> HashMap<u32, String> {
        rows(ty)
            .into_iter()
            .filter_map(|r| name_row(file, r, id_at, str_at))
            .collect()
    };
    let genres = simple(PageType::Genres, 0, 4);
    let labels = simple(PageType::Labels, 0, 4);
    let keys = simple(PageType::Keys, 0, 8);
    let artists: HashMap<u32, String> = rows(PageType::Artists)
        .into_iter()
        .filter_map(|r| {
            let sub = u16le(file, r)?;
            let id = u32le(file, r + 4)?;
            let ofs = if sub == 0x64 {
                usize::from(u16le(file, r + 0x0A)?)
            } else {
                usize::from(*file.get(r + 9)?)
            };
            Some((id, device_string(file, r + ofs)?))
        })
        .collect();
    let albums: HashMap<u32, String> = rows(PageType::Albums)
        .into_iter()
        .filter_map(|r| {
            let sub = u16le(file, r)?;
            let id = u32le(file, r + 0x0C)?;
            let ofs = if sub == 0x84 {
                usize::from(u16le(file, r + 0x16)?)
            } else {
                usize::from(*file.get(r + 0x15)?)
            };
            Some((id, device_string(file, r + ofs)?))
        })
        .collect();

    let mut tracks = Vec::new();
    let mut path_by_id: HashMap<u32, String> = HashMap::new();
    for r in rows(PageType::Tracks) {
        let s = |i: usize| -> Option<String> {
            let off = usize::from(u16le(file, r + 0x5E + 2 * i)?);
            device_string(file, r + off).filter(|s| !s.is_empty())
        };
        let g32 = |at: usize| u32le(file, r + at).unwrap_or(0);
        let g16 = |at: usize| u16le(file, r + at).unwrap_or(0);
        let id = g32(0x48);
        let rel = s(20).unwrap_or_default();
        let full = crate::util::path_to_string(&normalize_lexically(
            &volume_root.join(rel.trim_start_matches('/')),
        ))
        .replace('\\', "/");
        let tempo = g32(0x38);
        let rec = TrackRecord {
            source_id: Some(id.to_string()),
            path: full.clone(),
            title: s(17),
            artist: artists.get(&g32(0x44)).cloned().filter(|s| !s.is_empty()),
            album: albums.get(&g32(0x40)).cloned().filter(|s| !s.is_empty()),
            genre: genres.get(&g32(0x3C)).cloned().filter(|s| !s.is_empty()),
            label: labels.get(&g32(0x28)).cloned().filter(|s| !s.is_empty()),
            key: keys.get(&g32(0x20)).and_then(|k| MusicalKey::parse(k)),
            sample_rate: Some(g32(0x08)).filter(|v| *v > 0),
            bitrate: Some(g32(0x30)).filter(|v| *v > 0),
            bpm: (tempo > 0).then(|| f64::from(tempo) / 100.0),
            year: Some(i32::from(g16(0x50))).filter(|y| *y > 0),
            duration_sec: Some(f64::from(g16(0x54))).filter(|d| *d > 0.0),
            play_count: u32::from(g16(0x4E)),
            colour: file.get(r + 0x58).and_then(|c| rekordbox_track_colour(*c)),
            rating: file
                .get(r + 0x59)
                .copied()
                .filter(|v| *v > 0)
                .map(|v| v.min(5)),
            comment: s(16),
            added_at: s(10).and_then(|d| parse_date(&d)),
            isrc: s(0),
            ..TrackRecord::default()
        };
        path_by_id.insert(id, full);
        tracks.push(rec);
    }

    // Playlist tree: (id → (parent, sort, is_folder, name)).
    let mut nodes: HashMap<u32, TreeNode> = HashMap::new();
    for r in rows(PageType::PlaylistTree) {
        let (Some(parent), Some(sort), Some(id), Some(folder)) = (
            u32le(file, r),
            u32le(file, r + 8),
            u32le(file, r + 12),
            u32le(file, r + 16),
        ) else {
            continue;
        };
        let name = device_string(file, r + 20).unwrap_or_default();
        nodes.insert(id, (parent, sort, folder != 0, name));
    }
    let mut entries: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    for r in rows(PageType::PlaylistEntries) {
        if let (Some(idx), Some(track), Some(list)) =
            (u32le(file, r), u32le(file, r + 4), u32le(file, r + 8))
        {
            entries.entry(list).or_default().push((idx, track));
        }
    }
    let mut lists: Vec<(&u32, &TreeNode)> = nodes.iter().filter(|(_, n)| !n.2).collect();
    lists.sort_by_key(|(id, n)| (n.0, n.1, **id));
    let mut playlists = Vec::new();
    for (id, (parent, _, _, name)) in lists {
        let mut folder = Vec::new();
        let mut p = *parent;
        let mut guard = 0;
        while p != 0 && guard < 64 {
            let Some((pp, _, _, n)) = nodes.get(&p) else {
                break;
            };
            folder.push(n.clone());
            p = *pp;
            guard += 1;
        }
        folder.reverse();
        let mut items = entries.remove(id).unwrap_or_default();
        items.sort_by_key(|(idx, _)| *idx);
        playlists.push(Playlist {
            name: name.clone(),
            folder,
            tracks: items
                .into_iter()
                .filter_map(|(_, t)| path_by_id.get(&t).cloned())
                .collect(),
        });
    }
    Ok(Collection { tracks, playlists })
}
