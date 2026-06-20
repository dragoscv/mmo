//! Composes `export.pdb` (classic Device Library) and `exportExt.pdb` (Device
//! Library Plus) from the manifest + audio placement.
//!
//! A pdb file = 28-byte file header + table-pointer array, then 4096-byte
//! pages. Table types (from crate-digger): 0=tracks, 1=genres, 2=artists,
//! 3=albums, 4=labels, 5=keys, 6=colors, 7=playlist_tree, 8=playlist_entries,
//! 9=unknown, 13=artwork, 16=columns, 17=history_playlists, 18=history_entries,
//! 19=history.
//!
//! This is the first writer pass: it lays out the file/table structure and the
//! string/row encoders. Exact per-row field order is refined against the
//! reference USB via the round-trip diff harness.

use crate::contents::PlacedTrack;
use crate::devicesql::{build_data_pages, push_u16, push_u32, push_u8, DeviceString, RowData, PAGE_SIZE};
use crate::manifest::ExportManifest;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

const FILE_HEADER_LEN: usize = 28;

#[derive(Clone, Copy)]
#[repr(u32)]
enum TableType {
    Tracks = 0,
    Genres = 1,
    Artists = 2,
    Albums = 3,
    Labels = 4,
    Keys = 5,
    Colors = 6,
    PlaylistTree = 7,
    PlaylistEntries = 8,
    Unknown9 = 9,
    Unknown10 = 10,
    Unknown11 = 11,
    Unknown12 = 12,
    Artwork = 13,
    Unknown14 = 14,
    Unknown15 = 15,
    Columns = 16,
    HistoryPlaylists = 17,
    HistoryEntries = 18,
    History = 19,
}

/// A pending table: its type and encoded rows.
struct Table {
    ttype: TableType,
    rows: Vec<RowData>,
}

/// Intern a set of names → sequential ids (1-based), preserving first-seen order.
struct Interner {
    map: BTreeMap<String, u32>,
    order: Vec<String>,
}
impl Interner {
    fn new() -> Self {
        Self {
            map: BTreeMap::new(),
            order: Vec::new(),
        }
    }
    fn intern(&mut self, name: &str) -> u32 {
        if name.is_empty() {
            return 0;
        }
        if let Some(id) = self.map.get(name) {
            return *id;
        }
        let id = self.order.len() as u32 + 1;
        self.map.insert(name.to_string(), id);
        self.order.push(name.to_string());
        id
    }
}

/// Encode a simple "id + name" row (artists/genres/albums/labels/colors).
fn named_row(id: u32, name: &str) -> RowData {
    let mut b = Vec::new();
    b.extend_from_slice(&id.to_le_bytes());
    b.extend_from_slice(&DeviceString::best(name).encode());
    RowData { bytes: b }
}

/// Build all classic tables from the manifest.
fn build_tables(m: &ExportManifest, placed: &[PlacedTrack]) -> Vec<Table> {
    let mut artists = Interner::new();
    let mut genres = Interner::new();
    let mut albums = Interner::new();
    let mut labels = Interner::new();
    let mut keys = Interner::new();

    let placed_by_id: BTreeMap<u32, &PlacedTrack> = placed.iter().map(|p| (p.id, p)).collect();

    let mut track_rows = Vec::new();
    for t in &m.tracks {
        let Some(pt) = placed_by_id.get(&t.id) else {
            continue;
        };
        let artist_id = artists.intern(t.artist.as_deref().unwrap_or(""));
        let genre_id = genres.intern(t.genre.as_deref().unwrap_or(""));
        let album_id = albums.intern(t.album.as_deref().unwrap_or(""));
        let label_id = labels.intern(t.label.as_deref().unwrap_or(""));
        let key_id = keys.intern(t.key.as_deref().unwrap_or(""));

        track_rows.push(encode_track_row(t, pt, artist_id, album_id, genre_id, key_id, label_id));
    }

    let mut tables = Vec::new();
    tables.push(Table {
        ttype: TableType::Tracks,
        rows: track_rows,
    });
    tables.push(Table {
        ttype: TableType::Genres,
        rows: genres.order.iter().enumerate().map(|(i, n)| named_row(i as u32 + 1, n)).collect(),
    });
    tables.push(Table {
        ttype: TableType::Artists,
        rows: artists.order.iter().enumerate().map(|(i, n)| named_row(i as u32 + 1, n)).collect(),
    });
    tables.push(Table {
        ttype: TableType::Albums,
        rows: albums.order.iter().enumerate().map(|(i, n)| named_row(i as u32 + 1, n)).collect(),
    });
    tables.push(Table {
        ttype: TableType::Labels,
        rows: labels.order.iter().enumerate().map(|(i, n)| named_row(i as u32 + 1, n)).collect(),
    });
    tables.push(Table {
        ttype: TableType::Keys,
        rows: keys.order.iter().enumerate().map(|(i, n)| named_row(i as u32 + 1, n)).collect(),
    });
    tables.push(Table {
        ttype: TableType::Colors,
        rows: Vec::new(),
    });
    // Playlist tree + entries.
    let (tree, entries) = build_playlists(m);
    tables.push(Table {
        ttype: TableType::PlaylistTree,
        rows: tree,
    });
    tables.push(Table {
        ttype: TableType::PlaylistEntries,
        rows: entries,
    });
    // Empty placeholder tables (types 9-12) — present in every export.
    for tt in [
        TableType::Unknown9,
        TableType::Unknown10,
        TableType::Unknown11,
        TableType::Unknown12,
    ] {
        tables.push(Table { ttype: tt, rows: Vec::new() });
    }
    tables.push(Table {
        ttype: TableType::Artwork,
        rows: Vec::new(),
    });
    tables.push(Table { ttype: TableType::Unknown14, rows: Vec::new() });
    tables.push(Table { ttype: TableType::Unknown15, rows: Vec::new() });
    tables.push(Table {
        ttype: TableType::Columns,
        rows: Vec::new(),
    });
    tables.push(Table { ttype: TableType::HistoryPlaylists, rows: Vec::new() });
    tables.push(Table { ttype: TableType::HistoryEntries, rows: Vec::new() });
    tables.push(Table { ttype: TableType::History, rows: Vec::new() });
    tables
}

fn build_playlists(m: &ExportManifest) -> (Vec<RowData>, Vec<RowData>) {
    let mut tree = Vec::new();
    let mut entries = Vec::new();
    for (sort, pl) in m.playlists.iter().enumerate() {
        let mut b = Vec::new();
        b.extend_from_slice(&pl.parent.to_le_bytes());
        b.extend_from_slice(&(sort as u32).to_le_bytes());
        b.extend_from_slice(&pl.id.to_le_bytes());
        b.extend_from_slice(&(if pl.is_folder { 1u32 } else { 0u32 }).to_le_bytes());
        b.extend_from_slice(&DeviceString::best(&pl.name).encode());
        tree.push(RowData { bytes: b });

        if !pl.is_folder {
            for (i, tid) in pl.track_ids.iter().enumerate() {
                let mut e = Vec::new();
                e.extend_from_slice(&(i as u32 + 1).to_le_bytes()); // entry index
                e.extend_from_slice(&tid.to_le_bytes());
                e.extend_from_slice(&pl.id.to_le_bytes());
                entries.push(RowData { bytes: e });
            }
        }
    }
    (tree, entries)
}

/// Encode a track row. Field set follows the crate-digger track row; offsets
/// VERIFIED against the reference USB (tools/decode-track-row.mjs). Layout:
///   fixed numeric header (0x00..0x5E), then a 21-entry u16 string-offset
///   table (offsets relative to row start), then the packed DeviceSQL strings.
fn encode_track_row(
    t: &crate::manifest::Track,
    pt: &PlacedTrack,
    artist_id: u32,
    album_id: u32,
    genre_id: u32,
    key_id: u32,
    label_id: u32,
) -> RowData {
    // ── Fixed header (0x00..0x5E = 94 bytes) ───────────────────────────
    let mut b = Vec::with_capacity(160);
    let bpm100 = (t.bpm.unwrap_or(0.0) * 100.0) as u32;
    let sr = t.sample_rate.unwrap_or(44100);
    let analyze_path = anlz_device_path(t.id);

    push_u16(&mut b, 0x24); // 0x00 u1 (row magic seen in ref)
    push_u16(&mut b, 0x20); // 0x02 index_shift (filled per-row by index; 0x20 typical)
    push_u32(&mut b, 0x000C0700); // 0x04 bitmask (ref value; refined later)
    push_u32(&mut b, sr); // 0x08 sample_rate
    push_u32(&mut b, 0); // 0x0c composer_id
    push_u32(&mut b, 0); // 0x10 file_size (filled below if known)
    push_u32(&mut b, 0); // 0x14 u2
    push_u16(&mut b, 0); // 0x18 u3
    push_u16(&mut b, 0); // 0x1a u4
    push_u32(&mut b, 0); // 0x1c artwork_id
    push_u32(&mut b, key_id); // 0x20 key_id
    push_u32(&mut b, 0); // 0x24 orig_artist_id
    push_u32(&mut b, label_id); // 0x28 label_id
    push_u32(&mut b, 0); // 0x2c remixer_id
    push_u32(&mut b, t.bitrate.unwrap_or(0)); // 0x30 bitrate
    push_u32(&mut b, t.track_number.unwrap_or(0)); // 0x34 track_number
    push_u32(&mut b, bpm100); // 0x38 tempo (bpm*100)
    push_u32(&mut b, genre_id); // 0x3c genre_id
    push_u32(&mut b, album_id); // 0x40 album_id
    push_u32(&mut b, artist_id); // 0x44 artist_id
    push_u32(&mut b, t.id); // 0x48 id
    push_u16(&mut b, 0); // 0x4c disc
    push_u16(&mut b, 0); // 0x4e play_count
    push_u16(&mut b, t.year.unwrap_or(0) as u16); // 0x50 year
    push_u16(&mut b, 16); // 0x52 sample_depth
    push_u16(&mut b, t.duration_sec.unwrap_or(0.0) as u16); // 0x54 duration (s)
    push_u16(&mut b, 41); // 0x56 u5 (ref had 41)
    push_u8(&mut b, t.color.unwrap_or(0) as u8); // 0x58 color_id
    push_u8(&mut b, t.rating.unwrap_or(0) as u8); // 0x59 rating
    push_u16(&mut b, 1); // 0x5a u6
    push_u16(&mut b, 3); // 0x5c u7
    debug_assert_eq!(b.len(), 0x5E);

    // ── 21 string-offset table (u16 each) + packed strings ─────────────
    // The 21 logical slots (verified order from the reference). We populate
    // the ones we know; the rest are empty strings.
    let empty = "";
    let mut slots: [String; 21] = Default::default();
    slots[2] = "0".into(); // unk numeric-as-string seen in ref
    slots[6] = "ON".into(); // message
    slots[7] = "ON".into(); // kuvo autoload flag
    slots[14] = analyze_path; // analyze .DAT path
    slots[17] = t.title.clone().unwrap_or_default(); // title
    slots[19] = file_basename(&pt.device_path); // filename
    slots[20] = pt.device_path.clone(); // full device path
    for s in [0,1,3,4,5,8,9,10,11,12,13,15,16,18] {
        slots[s] = empty.into();
    }

    let table_start = b.len();
    let strings_start = table_start + 21 * 2;
    // First encode strings to compute offsets.
    let mut encoded: Vec<Vec<u8>> = Vec::with_capacity(21);
    let mut offs: Vec<u16> = Vec::with_capacity(21);
    let mut cursor = strings_start;
    for s in &slots {
        let enc = DeviceString::best(s).encode();
        offs.push(cursor as u16);
        cursor += enc.len();
        encoded.push(enc);
    }
    for o in &offs {
        push_u16(&mut b, *o);
    }
    for enc in &encoded {
        b.extend_from_slice(enc);
    }
    RowData { bytes: b }
}

fn anlz_device_path(track_id: u32) -> String {
    // Mirror anlz::anlz_dir naming. seq isn't known here; use id-based bucket.
    format!("/PIONEER/USBANLZ/P{:03}/{:08X}/ANLZ0000.DAT", track_id % 1000, track_id)
}

fn file_basename(device_path: &str) -> String {
    device_path
        .rsplit('/')
        .next()
        .unwrap_or(device_path)
        .to_string()
}

/// Assemble tables into a full pdb byte image and write to `path`.
///
/// Layout mirrors rekordbox: page 0 = file header. Each table emits a "first"
/// page (flags 0x64) chained to its data page(s) (flags 0x24). The table
/// pointer records first = the 0x64 page, last = the final data page. A small
/// pool of empty pages follows so `next_unused_page` has room (the reference
/// keeps the last data page's `next` pointing into this pool).
fn assemble(tables: &[Table]) -> Vec<u8> {
    let mut all_pages: Vec<[u8; PAGE_SIZE]> = Vec::new();
    let mut table_ptrs: Vec<(u32, u32, u32, u32)> = Vec::new(); // (type, empty, first, last)

    let mut next_global = 1u32; // page 0 is the header
    for t in tables {
        // First (0x64) page.
        let first_page_global = next_global;
        let data_first_global = next_global + 1;
        // Build data pages starting after the first page.
        let built = build_data_pages(t.ttype as u32, &t.rows, data_first_global);
        let last = built.last_page_global;

        let first_page = crate::devicesql::build_first_page(
            t.ttype as u32,
            first_page_global,
            data_first_global,
        );
        all_pages.push(first_page);
        for p in built.pages {
            all_pages.push(p);
        }
        table_ptrs.push((t.ttype as u32, 0, first_page_global, last));
        next_global = last + 1;
    }

    // Free page pool: a few empty pages so next_unused_page has headroom and
    // the last data pages can chain into them (matches reference behavior).
    let free_pool = 4u32;
    let first_free = next_global;
    for i in 0..free_pool {
        let mut p = [0u8; PAGE_SIZE];
        let g = first_free + i;
        p[0x04..0x08].copy_from_slice(&g.to_le_bytes());
        all_pages.push(p);
    }
    next_global += free_pool;

    let num_tables = tables.len() as u32;
    let total_pages = next_global; // includes page 0

    // Build header page (page 0).
    let mut header = [0u8; PAGE_SIZE];
    // 0x00 u32 = 0
    header[0x04..0x08].copy_from_slice(&(PAGE_SIZE as u32).to_le_bytes()); // len_page
    header[0x08..0x0C].copy_from_slice(&num_tables.to_le_bytes());
    header[0x0C..0x10].copy_from_slice(&first_free.to_le_bytes()); // next_unused_page
    header[0x10..0x14].copy_from_slice(&0u32.to_le_bytes()); // unknown
    header[0x14..0x18].copy_from_slice(&(total_pages - 1).to_le_bytes()); // sequence
    header[0x18..0x1C].copy_from_slice(&0u32.to_le_bytes()); // gap
    // Table pointer array starts at 0x1C: each entry = type, empty_candidate,
    // first_page, last_page (4 × u32 = 16 bytes).
    let mut off = FILE_HEADER_LEN;
    for (ttype, empty, first, last) in &table_ptrs {
        if off + 16 > PAGE_SIZE {
            break;
        }
        header[off..off + 4].copy_from_slice(&ttype.to_le_bytes());
        header[off + 4..off + 8].copy_from_slice(&empty.to_le_bytes());
        header[off + 8..off + 12].copy_from_slice(&first.to_le_bytes());
        header[off + 12..off + 16].copy_from_slice(&last.to_le_bytes());
        off += 16;
    }

    let mut out = Vec::with_capacity(total_pages as usize * PAGE_SIZE);
    out.extend_from_slice(&header);
    for p in &all_pages {
        out.extend_from_slice(p);
    }
    out
}

pub fn write_export_pdb(
    path: &Path,
    m: &ExportManifest,
    placed: &[PlacedTrack],
) -> std::io::Result<()> {
    let tables = build_tables(m, placed);
    let bytes = assemble(&tables);
    let mut f = std::fs::File::create(path)?;
    f.write_all(&bytes)?;
    Ok(())
}

pub fn write_export_ext_pdb(
    path: &Path,
    m: &ExportManifest,
    placed: &[PlacedTrack],
) -> std::io::Result<()> {
    // Device Library Plus. The reference exportExt.pdb carries exactly the
    // first 9 table types (0=tracks .. 8=playlist_entries) — the same row
    // encoders as export.pdb, minus the empty placeholder/history tables.
    // VERIFIED against the reference USB (tools/decode-pdb.mjs).
    let tables: Vec<Table> = build_tables(m, placed)
        .into_iter()
        .filter(|t| (t.ttype as u32) <= 8)
        .collect();
    let bytes = assemble(&tables);
    let mut f = std::fs::File::create(path)?;
    f.write_all(&bytes)?;
    Ok(())
}
