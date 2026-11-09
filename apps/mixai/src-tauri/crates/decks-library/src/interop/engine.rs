//! Engine DJ (Denon / Numark / Rane) `Engine Library/Database2/m.db`, read only.
//!
//! Schema assumptions (Engine DJ 2.x–4.x "Database2", `Information.schemaVersionMajor` 2/3):
//! * `Track(id, path, filename, title, artist, album, genre, comment, label, year, length,
//!   bpm, bpmAnalyzed, rating, key, bitrate, dateAdded, timeLastPlayed, isPlayed, playOrder)`
//!   — columns are probed with `PRAGMA table_info`, missing ones read as NULL.
//!   `path` is relative to the `Engine Library` folder (parent of `Database2`).
//!   `rating` is 0..100 (20 per star); `key` uses the Engine numbering
//!   (see [`MusicalKey::from_engine_value`]).
//! * `PerformanceData(trackId, trackData, beatData, quickCues, loops)` — Qt `qCompress`
//!   blobs (u32 BE uncompressed size + zlib stream), big-endian content:
//!   - trackData: f64 sampleRate, i64 sampleCount, f64 loudness, i32 key
//!   - beatData: f64 sampleRate, f64 sampleCount, u8 isSet, default grid, adjusted grid;
//!     grid = i64 n + n × (f64 sampleOffset, i64 beatNumber, i32 beatsToNext, i32 unknown)
//!   - quickCues: i64 n + n × (u8 len, label, f64 sampleOffset (-1 = unset), u8 a,r,g,b)
//!   - loops: i64 n + n × (u8 len, label, f64 start, f64 end, u8 startSet, u8 endSet, u8 a,r,g,b)
//! * `Playlist(id, title, parentListId, nextListId)` and
//!   `PlaylistEntity(id, listId, trackId, nextEntityId)` — sibling order follows the
//!   `next*` linked lists (0 = end), falling back to id order.
//!
//! Engine 1.x (`m.db` + `p.db` with `MetaData` tables) is not supported.

use std::collections::{HashMap, HashSet};
use std::io::Read as _;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::keys::MusicalKey;
use crate::model::{BeatGrid, Collection, Cue, CueKind, Playlist, Rgb, TrackRecord};
use crate::util::normalize_lexically;
use crate::{Error, Result};

/// Decompresses a Qt `qCompress` blob.
pub fn q_uncompress(blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 4 {
        return Ok(Vec::new());
    }
    let expected = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    let mut out = Vec::with_capacity(expected.min(16 << 20));
    flate2::read::ZlibDecoder::new(&blob[4..])
        .read_to_end(&mut out)
        .map_err(|e| Error::Format(format!("qUncompress: {e}")))?;
    Ok(out)
}

/// Compresses like Qt `qCompress` (used by tests and future writers).
pub fn q_compress(data: &[u8]) -> Vec<u8> {
    use std::io::Write as _;
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = enc.write_all(data);
    out.extend(enc.finish().unwrap_or_default());
    out
}

struct Cursor<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, i: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.i..self.i + n)?;
        self.i += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn i32(&mut self) -> Option<i32> {
        self.take(4)
            .map(|s| i32::from_be_bytes(s.try_into().unwrap_or([0; 4])))
    }
    fn i64(&mut self) -> Option<i64> {
        self.take(8)
            .map(|s| i64::from_be_bytes(s.try_into().unwrap_or([0; 8])))
    }
    fn f64(&mut self) -> Option<f64> {
        self.take(8)
            .map(|s| f64::from_be_bytes(s.try_into().unwrap_or([0; 8])))
    }
    fn label(&mut self) -> Option<String> {
        let n = usize::from(self.u8()?);
        self.take(n)
            .map(|s| String::from_utf8_lossy(s).into_owned())
    }
}

/// `(sampleOffset, beatNumber)` markers of one grid.
fn read_grid(c: &mut Cursor<'_>) -> Option<Vec<(f64, i64)>> {
    let n = c.i64()?.clamp(0, 100_000) as usize;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let off = c.f64()?;
        let beat = c.i64()?;
        c.i32()?;
        c.i32()?;
        out.push((off, beat));
    }
    Some(out)
}

fn grid_from_markers(markers: &[(f64, i64)], sr: f64) -> Option<BeatGrid> {
    let (a, b) = (markers.first()?, markers.get(1)?);
    let beats = (b.1 - a.1) as f64;
    if beats <= 0.0 || sr <= 0.0 || b.0 <= a.0 {
        return None;
    }
    let beat_len = (b.0 - a.0) / sr / beats;
    let bpm = 60.0 / beat_len;
    // Time of beat 0 (a downbeat), then the first non-negative beat.
    let beat0 = a.0 / sr - a.1 as f64 * beat_len;
    let k = if beat0 < 0.0 {
        (-beat0 / beat_len).ceil() as i64
    } else {
        0
    };
    let first = beat0 + k as f64 * beat_len;
    Some(BeatGrid {
        bpm,
        first_beat_sec: first.max(0.0),
        downbeat_offset: (k.rem_euclid(4)) as u8,
        anchors: Vec::new(),
    })
}

fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    Ok(cols)
}

fn col(cols: &HashSet<String>, name: &str) -> String {
    if cols.contains(name) {
        format!("\"{name}\"")
    } else {
        "NULL".to_owned()
    }
}

fn library_root(db: &Path) -> PathBuf {
    let parent = db.parent().unwrap_or(Path::new("."));
    if parent
        .file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Database2"))
    {
        parent.parent().unwrap_or(parent).to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

/// Reads an Engine DJ database into a [`Collection`].
pub fn read(db: &Path) -> Result<Collection> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let root = library_root(db);
    let tc = columns(&conn, "Track")?;
    if tc.is_empty() {
        return Err(Error::Format(
            "no Track table: not an Engine DJ 2.x+ database".into(),
        ));
    }
    let sql = format!(
        "SELECT id, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {} FROM Track ORDER BY id",
        col(&tc, "path"),
        col(&tc, "title"),
        col(&tc, "artist"),
        col(&tc, "album"),
        col(&tc, "genre"),
        col(&tc, "comment"),
        col(&tc, "label"),
        col(&tc, "year"),
        col(&tc, "length"),
        col(&tc, "bpmAnalyzed"),
        col(&tc, "bpm"),
        col(&tc, "rating"),
        col(&tc, "key"),
        col(&tc, "bitrate"),
        col(&tc, "dateAdded"),
        col(&tc, "timeLastPlayed"),
        col(&tc, "filename"),
        col(&tc, "isrc"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut tracks: Vec<TrackRecord> = stmt
        .query_map([], |r| {
            let id: i64 = r.get(0)?;
            let rel: Option<String> = r.get(1)?;
            let bpm: Option<f64> = r
                .get::<_, Option<f64>>(10)?
                .or(r.get::<_, Option<f64>>(11)?);
            let rating: Option<i64> = r.get(12)?;
            Ok(TrackRecord {
                source_id: Some(id.to_string()),
                path: rel.unwrap_or_default(),
                title: r.get(2)?,
                artist: r.get(3)?,
                album: r.get(4)?,
                genre: r.get(5)?,
                comment: r.get(6)?,
                label: r.get(7)?,
                year: r.get::<_, Option<i32>>(8)?.filter(|y| *y > 0),
                duration_sec: r.get::<_, Option<f64>>(9)?.filter(|d| *d > 0.0),
                bpm: bpm.filter(|b| *b > 0.0),
                rating: rating
                    .filter(|x| *x > 0)
                    .map(|x| ((x + 10) / 20).clamp(0, 5) as u8),
                key: r
                    .get::<_, Option<i64>>(13)?
                    .and_then(MusicalKey::from_engine_value),
                bitrate: r
                    .get::<_, Option<i64>>(14)?
                    .filter(|b| *b > 0)
                    .map(|b| b as u32),
                added_at: r.get::<_, Option<i64>>(15)?.filter(|d| *d > 0),
                last_played: r.get::<_, Option<i64>>(16)?.filter(|d| *d > 0),
                isrc: r.get(18)?,
                ..TrackRecord::default()
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    for t in &mut tracks {
        if !t.path.is_empty() {
            t.path = crate::util::path_to_string(&normalize_lexically(&root.join(&t.path)))
                .replace('\\', "/");
        }
    }

    let pc = columns(&conn, "PerformanceData")?;
    if !pc.is_empty() {
        let sql = format!(
            "SELECT {}, {}, {}, {} FROM PerformanceData WHERE trackId = ?1",
            col(&pc, "trackData"),
            col(&pc, "beatData"),
            col(&pc, "quickCues"),
            col(&pc, "loops"),
        );
        let mut stmt = conn.prepare(&sql)?;
        for t in &mut tracks {
            let id: i64 = t
                .source_id
                .as_deref()
                .and_then(|s| s.parse().ok())
                .unwrap_or(-1);
            let row = stmt
                .query_row([id], |r| {
                    Ok((
                        r.get::<_, Option<Vec<u8>>>(0)?,
                        r.get::<_, Option<Vec<u8>>>(1)?,
                        r.get::<_, Option<Vec<u8>>>(2)?,
                        r.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                })
                .optional()?;
            if let Some((td, bd, qc, lp)) = row {
                apply_performance(t, td, bd, qc, lp)?;
            }
        }
    }

    let playlists = read_playlists(&conn, &tracks)?;
    Ok(Collection { tracks, playlists })
}

fn apply_performance(
    t: &mut TrackRecord,
    td: Option<Vec<u8>>,
    bd: Option<Vec<u8>>,
    qc: Option<Vec<u8>>,
    lp: Option<Vec<u8>>,
) -> Result<()> {
    let mut sr = 0.0;
    if let Some(b) = td.filter(|b| !b.is_empty()) {
        let d = q_uncompress(&b)?;
        let mut c = Cursor::new(&d);
        sr = c.f64().unwrap_or(0.0);
        let samples = c.i64().unwrap_or(0);
        if sr > 0.0 {
            t.sample_rate.get_or_insert(sr as u32);
            if t.duration_sec.is_none() && samples > 0 {
                t.duration_sec = Some(samples as f64 / sr);
            }
        }
    }
    if let Some(b) = bd.filter(|b| !b.is_empty()) {
        let d = q_uncompress(&b)?;
        let mut c = Cursor::new(&d);
        let gsr = c.f64().unwrap_or(sr);
        c.f64();
        c.u8();
        let default = read_grid(&mut c).unwrap_or_default();
        let adjusted = read_grid(&mut c).unwrap_or_default();
        let markers = if adjusted.len() >= 2 {
            adjusted
        } else {
            default
        };
        t.grid = grid_from_markers(&markers, if gsr > 0.0 { gsr } else { sr });
        if sr <= 0.0 {
            sr = gsr;
        }
    }
    if sr <= 0.0 {
        return Ok(()); // cue positions are in samples; without a rate they are meaningless
    }
    if let Some(b) = qc.filter(|b| !b.is_empty()) {
        let d = q_uncompress(&b)?;
        let mut c = Cursor::new(&d);
        let n = c.i64().unwrap_or(0).clamp(0, 64);
        for i in 0..n {
            let (Some(label), Some(off), Some(_a), Some(r), Some(g), Some(bl)) =
                (c.label(), c.f64(), c.u8(), c.u8(), c.u8(), c.u8())
            else {
                break;
            };
            if off >= 0.0 {
                t.cues.push(Cue {
                    kind: CueKind::Hot,
                    index: Some(i as u8),
                    start_sec: off / sr,
                    end_sec: None,
                    colour: Some(Rgb::new(r, g, bl)),
                    label: Some(label).filter(|s| !s.is_empty()),
                });
            }
        }
    }
    if let Some(b) = lp.filter(|b| !b.is_empty()) {
        let d = q_uncompress(&b)?;
        let mut c = Cursor::new(&d);
        let n = c.i64().unwrap_or(0).clamp(0, 64);
        for i in 0..n {
            let (
                Some(label),
                Some(s),
                Some(e),
                Some(ss),
                Some(es),
                Some(_a),
                Some(r),
                Some(g),
                Some(bl),
            ) = (
                c.label(),
                c.f64(),
                c.f64(),
                c.u8(),
                c.u8(),
                c.u8(),
                c.u8(),
                c.u8(),
                c.u8(),
            )
            else {
                break;
            };
            if ss != 0 && es != 0 && s >= 0.0 && e > s {
                t.cues.push(Cue {
                    kind: CueKind::Loop,
                    index: Some(i as u8),
                    start_sec: s / sr,
                    end_sec: Some(e / sr),
                    colour: Some(Rgb::new(r, g, bl)),
                    label: Some(label).filter(|s| !s.is_empty()),
                });
            }
        }
    }
    Ok(())
}

/// Orders items by a `next` linked list (0 = end); unreachable items follow in id order.
fn linked_order(items: &[(i64, i64)]) -> Vec<i64> {
    let next: HashMap<i64, i64> = items.iter().copied().collect();
    let targets: HashSet<i64> = items.iter().map(|(_, n)| *n).collect();
    let mut heads: Vec<i64> = items
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| !targets.contains(id))
        .collect();
    heads.sort_unstable();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for h in heads {
        let mut cur = h;
        while cur != 0 && seen.insert(cur) && next.contains_key(&cur) {
            out.push(cur);
            cur = next[&cur];
        }
    }
    let mut rest: Vec<i64> = items
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| !seen.contains(id))
        .collect();
    rest.sort_unstable();
    out.extend(rest);
    out
}

fn read_playlists(conn: &Connection, tracks: &[TrackRecord]) -> Result<Vec<Playlist>> {
    let plc = columns(conn, "Playlist")?;
    let pec = columns(conn, "PlaylistEntity")?;
    if plc.is_empty() || pec.is_empty() {
        return Ok(Vec::new());
    }
    let path_by_id: HashMap<String, String> = tracks
        .iter()
        .filter_map(|t| Some((t.source_id.clone()?, t.path.clone())))
        .collect();
    let sql = format!(
        "SELECT id, {}, COALESCE({}, 0), COALESCE({}, 0) FROM Playlist",
        col(&plc, "title"),
        col(&plc, "parentListId"),
        col(&plc, "nextListId"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let lists: Vec<(i64, String, i64, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get(2)?,
                r.get(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let by_id: HashMap<i64, &(i64, String, i64, i64)> = lists.iter().map(|l| (l.0, l)).collect();
    // Depth-first: siblings follow their nextListId chain, children come right after a folder.
    let mut kids: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    for l in &lists {
        kids.entry(l.2).or_default().push((l.0, l.3));
    }
    let mut order = Vec::new();
    let mut stack: Vec<i64> = linked_order(kids.get(&0).map_or(&[][..], Vec::as_slice));
    stack.reverse();
    let mut visited = HashSet::new();
    while let Some(id) = stack.pop() {
        if !visited.insert(id) {
            continue;
        }
        order.push(id);
        if let Some(children) = kids.get(&id) {
            let mut c = linked_order(children);
            c.reverse();
            stack.extend(c);
        }
    }

    let sql = format!(
        "SELECT id, trackId, COALESCE({}, 0) FROM PlaylistEntity WHERE listId = ?1",
        col(&pec, "nextEntityId")
    );
    let mut ent = conn.prepare(&sql)?;
    // Containers (lists with child lists and no tracks) are folders, not playlists.
    let parents: HashSet<i64> = lists.iter().map(|l| l.2).collect();
    let mut out = Vec::new();
    for id in order {
        let Some((_, title, parent, _)) = by_id.get(&id).copied() else {
            continue;
        };
        let rows: Vec<(i64, i64, i64)> = ent
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let track_of: HashMap<i64, i64> = rows.iter().map(|(e, t, _)| (*e, *t)).collect();
        let ordered = linked_order(&rows.iter().map(|(e, _, n)| (*e, *n)).collect::<Vec<_>>());
        let tracks: Vec<String> = ordered
            .iter()
            .filter_map(|e| path_by_id.get(&track_of[e].to_string()).cloned())
            .collect();
        if parents.contains(&id) && tracks.is_empty() {
            continue;
        }
        let mut folder = Vec::new();
        let mut p = *parent;
        let mut guard = 0;
        while p != 0 && guard < 64 {
            match by_id.get(&p) {
                Some((_, name, pp, _)) => {
                    folder.push(name.clone());
                    p = *pp;
                }
                None => break,
            }
            guard += 1;
        }
        folder.reverse();
        out.push(Playlist {
            name: title.clone(),
            folder,
            tracks,
        });
    }
    Ok(out)
}
