//! rekordbox XML (`DJ_PLAYLISTS`, as written by rekordbox 5–7 "Export Collection in xml").
//!
//! Covered: `COLLECTION/TRACK` metadata, `TEMPO` (first = grid, rest = anchors, `Battito` =
//! beat-in-bar), `POSITION_MARK` (Type 0 cue / 4 loop, `Num` -1 = memory, RGB colours),
//! track `Colour`, `Rating` (0/51/…/255), and the `PLAYLISTS/NODE` tree (KeyType 0 = TrackID,
//! 1 = Location).

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::interop::xmltree::{self, Node};
use crate::keys::MusicalKey;
use crate::model::{BeatGrid, Collection, Cue, CueKind, GridAnchor, Playlist, Rgb, TrackRecord};
use crate::util::{
    format_date_iso, parse_date, path_key, percent_decode, percent_encode_path, xml_escape,
};
use crate::{Error, Result};

/// `file://localhost/C:/Music/a.mp3` → `C:/Music/a.mp3`; `file://localhost/Users/x` → `/Users/x`.
pub fn location_to_path(loc: &str) -> String {
    let rest = loc
        .strip_prefix("file://localhost")
        .or_else(|| loc.strip_prefix("file://"))
        .unwrap_or(loc);
    let decoded = percent_decode(rest);
    let b = decoded.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        decoded[1..].to_owned()
    } else {
        decoded
    }
}

pub fn path_to_location(path: &str) -> String {
    let p = path.replace('\\', "/");
    let p = p.trim_start_matches('/');
    format!("file://localhost/{}", percent_encode_path(p))
}

fn rating_from_rb(v: i64) -> Option<u8> {
    (v > 0).then(|| ((v + 25) / 51).clamp(0, 5) as u8)
}

fn rating_to_rb(stars: u8) -> u32 {
    u32::from(stars.min(5)) * 51
}

fn parse_track(n: &Node) -> TrackRecord {
    let location = n.attr("Location").unwrap_or_default();
    let mut rec = TrackRecord {
        source_id: n.text("TrackID"),
        path: location_to_path(location),
        title: n.text("Name"),
        artist: n.text("Artist"),
        album: n.text("Album"),
        genre: n.text("Genre"),
        label: n.text("Label"),
        year: n.i64("Year").filter(|y| *y > 0).map(|y| y as i32),
        duration_sec: n.f64("TotalTime").filter(|d| *d > 0.0),
        bitrate: n.i64("BitRate").filter(|b| *b > 0).map(|b| b as u32),
        sample_rate: n.i64("SampleRate").filter(|s| *s > 0).map(|s| s as u32),
        bpm: n.f64("AverageBpm").filter(|b| *b > 0.0),
        key: n.attr("Tonality").and_then(MusicalKey::parse),
        rating: n.i64("Rating").and_then(rating_from_rb),
        colour: n.attr("Colour").and_then(Rgb::parse_hex),
        comment: n.text("Comments"),
        added_at: n.attr("DateAdded").and_then(parse_date),
        play_count: n.i64("PlayCount").unwrap_or(0).max(0) as u32,
        ..TrackRecord::default()
    };

    let tempos: Vec<&Node> = n.children_named("TEMPO").collect();
    if let Some(first) = tempos.first()
        && let (Some(start), Some(bpm)) = (first.f64("Inizio"), first.f64("Bpm"))
    {
        let beat = first.i64("Battito").unwrap_or(1).clamp(1, 16);
        rec.grid = Some(BeatGrid {
            bpm,
            first_beat_sec: start,
            downbeat_offset: (beat - 1) as u8,
            anchors: tempos[1..]
                .iter()
                .filter_map(|t| {
                    Some(GridAnchor {
                        sec: t.f64("Inizio")?,
                        bpm: t.f64("Bpm")?,
                    })
                })
                .collect(),
        });
    }

    for m in n.children_named("POSITION_MARK") {
        let Some(start) = m.f64("Start") else {
            continue;
        };
        let num = m.i64("Num").unwrap_or(-1);
        let ty = m.i64("Type").unwrap_or(0);
        let end = m.f64("End");
        let kind = match (ty, num) {
            (4, _) => CueKind::Loop,
            (_, n) if n >= 0 => CueKind::Hot,
            _ => CueKind::Memory,
        };
        let colour = match (m.i64("Red"), m.i64("Green"), m.i64("Blue")) {
            (Some(r), Some(g), Some(b)) => Some(Rgb::new(r as u8, g as u8, b as u8)),
            _ => None,
        };
        rec.cues.push(Cue {
            kind,
            index: (num >= 0).then_some(num.min(255) as u8),
            start_sec: start,
            end_sec: if kind == CueKind::Loop { end } else { None },
            colour,
            label: m.text("Name"),
        });
    }
    rec
}

fn walk_playlists(
    node: &Node,
    folder: &mut Vec<String>,
    by_id: &HashMap<String, String>,
    out: &mut Vec<Playlist>,
) {
    for child in node.children_named("NODE") {
        let name = child.attr("Name").unwrap_or_default().to_owned();
        if child.attr("Type") == Some("0") {
            folder.push(name);
            walk_playlists(child, folder, by_id, out);
            folder.pop();
        } else {
            let by_location = child.attr("KeyType") == Some("1");
            let tracks = child
                .children_named("TRACK")
                .filter_map(|t| {
                    let key = t.attr("Key")?;
                    if by_location {
                        Some(location_to_path(key))
                    } else {
                        by_id.get(key).cloned()
                    }
                })
                .collect();
            out.push(Playlist {
                name,
                folder: folder.clone(),
                tracks,
            });
        }
    }
}

/// Parses a rekordbox XML document.
pub fn parse(xml: &str) -> Result<Collection> {
    let root = xmltree::parse(xml)?;
    if root.name != "DJ_PLAYLISTS" {
        return Err(Error::Format(format!(
            "expected DJ_PLAYLISTS, found {}",
            root.name
        )));
    }
    let tracks: Vec<TrackRecord> = root
        .child("COLLECTION")
        .map(|c| c.children_named("TRACK").map(parse_track).collect())
        .unwrap_or_default();
    let by_id: HashMap<String, String> = tracks
        .iter()
        .filter_map(|t| Some((t.source_id.clone()?, t.path.clone())))
        .collect();
    let mut playlists = Vec::new();
    if let Some(root_node) = root.child("PLAYLISTS").and_then(|p| p.child("NODE")) {
        walk_playlists(root_node, &mut Vec::new(), &by_id, &mut playlists);
    }
    Ok(Collection { tracks, playlists })
}

fn attr(out: &mut String, k: &str, v: impl std::fmt::Display) {
    let _ = write!(out, " {k}=\"{}\"", xml_escape(&v.to_string()));
}

fn opt_attr<T: std::fmt::Display>(out: &mut String, k: &str, v: Option<T>) {
    match v {
        Some(v) => attr(out, k, v),
        None => attr(out, k, ""),
    }
}

/// Serialises a collection as rekordbox XML. Track IDs are 1-based positions.
pub fn to_xml(col: &Collection) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<DJ_PLAYLISTS Version=\"1.0.0\">\n",
    );
    out.push_str("  <PRODUCT Name=\"MixAI Decks\" Version=\"1.0\" Company=\"MixAI\"/>\n");
    let _ = writeln!(out, "  <COLLECTION Entries=\"{}\">", col.tracks.len());
    let mut ids: HashMap<String, usize> = HashMap::new();
    for (i, t) in col.tracks.iter().enumerate() {
        let id = i + 1;
        ids.insert(path_key(&t.path), id);
        out.push_str("    <TRACK");
        attr(&mut out, "TrackID", id);
        opt_attr(&mut out, "Name", t.title.as_deref());
        opt_attr(&mut out, "Artist", t.artist.as_deref());
        opt_attr(&mut out, "Album", t.album.as_deref());
        opt_attr(&mut out, "Genre", t.genre.as_deref());
        attr(&mut out, "Kind", kind_for(&t.path));
        opt_attr(
            &mut out,
            "TotalTime",
            t.duration_sec.map(|d| d.round() as i64),
        );
        opt_attr(&mut out, "Year", t.year);
        opt_attr(&mut out, "AverageBpm", t.bpm.map(|b| format!("{b:.2}")));
        opt_attr(&mut out, "DateAdded", t.added_at.map(format_date_iso));
        opt_attr(&mut out, "BitRate", t.bitrate);
        opt_attr(&mut out, "SampleRate", t.sample_rate);
        opt_attr(&mut out, "Comments", t.comment.as_deref());
        attr(&mut out, "PlayCount", t.play_count);
        attr(&mut out, "Rating", rating_to_rb(t.rating.unwrap_or(0)));
        attr(&mut out, "Location", path_to_location(&t.path));
        opt_attr(&mut out, "Tonality", t.key.map(|k| k.musical()));
        opt_attr(&mut out, "Label", t.label.as_deref());
        if let Some(c) = t.colour {
            attr(&mut out, "Colour", format!("0x{:06X}", c.to_u32()));
        }
        out.push_str(">\n");
        if let Some(g) = &t.grid {
            let _ = writeln!(
                out,
                "      <TEMPO Inizio=\"{:.3}\" Bpm=\"{:.2}\" Metro=\"4/4\" Battito=\"{}\"/>",
                g.first_beat_sec,
                g.bpm,
                u32::from(g.downbeat_offset % 4) + 1
            );
            for a in &g.anchors {
                let _ = writeln!(
                    out,
                    "      <TEMPO Inizio=\"{:.3}\" Bpm=\"{:.2}\" Metro=\"4/4\" Battito=\"1\"/>",
                    a.sec, a.bpm
                );
            }
        }
        for c in &t.cues {
            out.push_str("      <POSITION_MARK");
            attr(&mut out, "Name", c.label.as_deref().unwrap_or(""));
            attr(
                &mut out,
                "Type",
                if c.kind == CueKind::Loop { 4 } else { 0 },
            );
            attr(&mut out, "Start", format!("{:.3}", c.start_sec));
            if c.kind == CueKind::Loop
                && let Some(e) = c.end_sec
            {
                attr(&mut out, "End", format!("{e:.3}"));
            }
            let num = match (c.kind, c.index) {
                (CueKind::Memory, _) | (_, None) => -1,
                (_, Some(i)) => i64::from(i),
            };
            attr(&mut out, "Num", num);
            if let Some(rgb) = c.colour {
                attr(&mut out, "Red", rgb.r);
                attr(&mut out, "Green", rgb.g);
                attr(&mut out, "Blue", rgb.b);
            }
            out.push_str("/>\n");
        }
        out.push_str("    </TRACK>\n");
    }
    out.push_str("  </COLLECTION>\n  <PLAYLISTS>\n");
    write_tree(&mut out, col, &ids);
    out.push_str("  </PLAYLISTS>\n</DJ_PLAYLISTS>\n");
    out
}

/// Folder tree built from `Playlist::folder`, preserving first-seen order.
#[derive(Default)]
struct Folder<'a> {
    name: String,
    children: Vec<FolderItem<'a>>,
}

enum FolderItem<'a> {
    Folder(Folder<'a>),
    List(&'a Playlist),
}

fn build_tree(col: &Collection) -> Folder<'_> {
    let mut root = Folder {
        name: "ROOT".into(),
        children: Vec::new(),
    };
    for pl in &col.playlists {
        let mut cur = &mut root;
        for part in &pl.folder {
            let pos = cur
                .children
                .iter()
                .position(|c| matches!(c, FolderItem::Folder(f) if &f.name == part));
            let idx = match pos {
                Some(i) => i,
                None => {
                    cur.children.push(FolderItem::Folder(Folder {
                        name: part.clone(),
                        children: Vec::new(),
                    }));
                    cur.children.len() - 1
                }
            };
            cur = match &mut cur.children[idx] {
                FolderItem::Folder(f) => f,
                FolderItem::List(_) => unreachable!("index points at a folder"),
            };
        }
        cur.children.push(FolderItem::List(pl));
    }
    root
}

fn write_tree(out: &mut String, col: &Collection, ids: &HashMap<String, usize>) {
    fn rec(out: &mut String, f: &Folder<'_>, depth: usize, ids: &HashMap<String, usize>) {
        let pad = "  ".repeat(depth + 2);
        let _ = writeln!(
            out,
            "{pad}<NODE Type=\"0\" Name=\"{}\" Count=\"{}\">",
            xml_escape(&f.name),
            f.children.len()
        );
        for c in &f.children {
            match c {
                FolderItem::Folder(sub) => rec(out, sub, depth + 1, ids),
                FolderItem::List(pl) => {
                    let keys: Vec<usize> = pl
                        .tracks
                        .iter()
                        .filter_map(|p| ids.get(&path_key(p)).copied())
                        .collect();
                    let _ = writeln!(
                        out,
                        "{pad}  <NODE Name=\"{}\" Type=\"1\" KeyType=\"0\" Entries=\"{}\">",
                        xml_escape(&pl.name),
                        keys.len()
                    );
                    for k in keys {
                        let _ = writeln!(out, "{pad}    <TRACK Key=\"{k}\"/>");
                    }
                    let _ = writeln!(out, "{pad}  </NODE>");
                }
            }
        }
        let _ = writeln!(out, "{pad}</NODE>");
    }
    rec(out, &build_tree(col), 0, ids);
}

fn kind_for(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => "MP3 File",
        "wav" => "WAV File",
        "aif" | "aiff" => "AIFF File",
        "flac" => "FLAC File",
        "m4a" | "mp4" | "aac" | "alac" => "M4A File",
        _ => "Audio File",
    }
}
