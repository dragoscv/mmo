//! Traktor NML (`NML VERSION="19"`, Traktor Pro 3/4 collection.nml and playlist exports).
//!
//! Covered: `COLLECTION/ENTRY` (`LOCATION` volume + `/:`-separated dir, `ALBUM`, `INFO`,
//! `TEMPO`, `MUSICAL_KEY` 0..23), `CUE_V2` (TYPE 0 cue, 1 fade-in, 2 fade-out, 3 load,
//! 4 grid, 5 loop; `HOTCUE` -1 = memory), and the `PLAYLISTS` folder tree with
//! `PRIMARYKEY TYPE="TRACK"` entries.
//!
//! Traktor has no per-cue colour; we write the exact colour in an extra `MIXAI_COLOR`
//! attribute (Traktor ignores unknown attributes) and fall back to Traktor's per-type colour.

use std::collections::HashMap;
use std::fmt::Write as _;

use crate::colour::{traktor_cue_type_colour, traktor_track_colour, traktor_track_index};
use crate::interop::xmltree::{self, Node};
use crate::keys::MusicalKey;
use crate::model::{BeatGrid, Collection, Cue, CueKind, GridAnchor, Playlist, Rgb, TrackRecord};
use crate::util::{format_date_slash, parse_date, path_key, xml_escape};
use crate::{Error, Result};

/// Traktor key string `VOLUME + DIR + FILE`, e.g. `C:/:Music/:a.mp3`.
pub fn primary_key(path: &str) -> String {
    let (volume, dir, file) = split_location(path);
    format!("{volume}{dir}{file}")
}

/// Splits a path into Traktor (`VOLUME`, `DIR`, `FILE`).
pub fn split_location(path: &str) -> (String, String, String) {
    let p = path.replace('\\', "/");
    let (volume, rest) = if p.len() >= 2 && p.as_bytes()[1] == b':' {
        (p[..2].to_owned(), p[2..].to_owned())
    } else {
        (String::new(), p)
    };
    let (dir, file) = match rest.rfind('/') {
        Some(i) => (&rest[..=i], &rest[i + 1..]),
        None => ("/", rest.as_str()),
    };
    let mut dir_t = String::new();
    for part in dir.split('/').filter(|s| !s.is_empty()) {
        dir_t.push_str("/:");
        dir_t.push_str(part);
    }
    dir_t.push_str("/:");
    (volume, dir_t, file.to_owned())
}

/// Reassembles a path from `LOCATION`. Drive-letter volumes (`C:`) are kept; named volumes
/// (`Macintosh HD`) map to POSIX root paths.
pub fn join_location(volume: &str, dir: &str, file: &str) -> String {
    let dir = dir.replace("/:", "/");
    let dir = if dir.is_empty() { "/".to_owned() } else { dir };
    let is_drive = volume.len() == 2 && volume.as_bytes()[1] == b':';
    let prefix = if is_drive { volume } else { "" };
    format!("{prefix}{dir}{file}")
}

fn key_to_path(key: &str) -> String {
    match key.find("/:") {
        Some(i) => {
            let volume = &key[..i];
            let rest = &key[i..];
            let (dir, file) = match rest.rfind("/:") {
                Some(j) => (&rest[..j + 2], &rest[j + 2..]),
                None => (rest, ""),
            };
            join_location(volume, dir, file)
        }
        None => key.to_owned(),
    }
}

fn parse_entry(n: &Node) -> Option<TrackRecord> {
    let loc = n.child("LOCATION")?;
    let path = join_location(
        loc.attr("VOLUME").unwrap_or_default(),
        loc.attr("DIR").unwrap_or("/:"),
        loc.attr("FILE").unwrap_or_default(),
    );
    let info = n.child("INFO");
    let get = |k: &str| info.and_then(|i| i.text(k));
    let geti = |k: &str| info.and_then(|i| i.i64(k));
    let mut rec = TrackRecord {
        path,
        title: n.text("TITLE"),
        artist: n.text("ARTIST"),
        album: n.child("ALBUM").and_then(|a| a.text("TITLE")),
        genre: get("GENRE"),
        label: get("LABEL"),
        comment: get("COMMENT"),
        year: get("RELEASE_DATE")
            .and_then(|d| d.split('/').next().and_then(|y| y.parse().ok()))
            .filter(|y: &i32| *y > 0),
        duration_sec: info
            .and_then(|i| i.f64("PLAYTIME_FLOAT").or_else(|| i.f64("PLAYTIME")))
            .filter(|d| *d > 0.0),
        bitrate: geti("BITRATE").filter(|b| *b > 0).map(|b| {
            if b >= 1000 {
                (b / 1000) as u32
            } else {
                b as u32
            }
        }),
        rating: geti("RANKING")
            .filter(|r| *r > 0)
            .map(|r| ((r + 25) / 51).clamp(0, 5) as u8),
        colour: geti("COLOR").and_then(traktor_track_colour),
        play_count: geti("PLAYCOUNT").unwrap_or(0).max(0) as u32,
        added_at: get("IMPORT_DATE").and_then(|d| parse_date(&d)),
        last_played: get("LAST_PLAYED").and_then(|d| parse_date(&d)),
        bpm: n
            .child("TEMPO")
            .and_then(|t| t.f64("BPM"))
            .filter(|b| *b > 0.0),
        key: n
            .child("MUSICAL_KEY")
            .and_then(|k| k.i64("VALUE"))
            .and_then(MusicalKey::from_traktor_value)
            .or_else(|| get("KEY").and_then(|k| MusicalKey::parse(&k))),
        ..TrackRecord::default()
    };

    let mut grid_markers: Vec<(f64, Option<f64>)> = Vec::new();
    for c in n.children_named("CUE_V2") {
        let ty = c.i64("TYPE").unwrap_or(0);
        let start = c.f64("START").unwrap_or(0.0) / 1000.0;
        let hot = c.i64("HOTCUE").unwrap_or(-1);
        if ty == 4 {
            grid_markers.push((start, c.child("GRID").and_then(|g| g.f64("BPM"))));
            continue;
        }
        let len = c.f64("LEN").unwrap_or(0.0) / 1000.0;
        let kind = match (ty, hot) {
            (5, _) => CueKind::Loop,
            (_, h) if h >= 0 => CueKind::Hot,
            _ => CueKind::Memory,
        };
        let colour = c
            .attr("MIXAI_COLOR")
            .and_then(Rgb::parse_hex)
            .or_else(|| Some(traktor_cue_type_colour(ty.clamp(0, 5) as u8)));
        rec.cues.push(Cue {
            kind,
            index: (hot >= 0).then_some(hot.min(255) as u8),
            start_sec: start,
            end_sec: (kind == CueKind::Loop && len > 0.0).then_some(start + len),
            colour,
            label: c.text("NAME").filter(|s| s != "n.n."),
        });
    }
    if let (Some((first, first_bpm)), Some(bpm)) = (grid_markers.first().copied(), rec.bpm) {
        rec.grid = Some(BeatGrid {
            bpm: first_bpm.unwrap_or(bpm),
            first_beat_sec: first,
            downbeat_offset: 0,
            anchors: grid_markers[1..]
                .iter()
                .map(|(s, b)| GridAnchor {
                    sec: *s,
                    bpm: b.unwrap_or(bpm),
                })
                .collect(),
        });
    }
    Some(rec)
}

fn walk(node: &Node, folder: &mut Vec<String>, out: &mut Vec<Playlist>) {
    let Some(sub) = node.child("SUBNODES") else {
        return;
    };
    for child in sub.children_named("NODE") {
        let name = child.attr("NAME").unwrap_or_default().to_owned();
        match child.attr("TYPE") {
            Some("FOLDER") => {
                folder.push(name);
                walk(child, folder, out);
                folder.pop();
            }
            Some("PLAYLIST") => {
                let tracks = child
                    .child("PLAYLIST")
                    .map(|p| {
                        p.children_named("ENTRY")
                            .filter_map(|e| e.child("PRIMARYKEY"))
                            .filter(|k| k.attr("TYPE") == Some("TRACK"))
                            .filter_map(|k| k.attr("KEY").map(key_to_path))
                            .collect()
                    })
                    .unwrap_or_default();
                out.push(Playlist {
                    name,
                    folder: folder.clone(),
                    tracks,
                });
            }
            _ => {}
        }
    }
}

/// Parses an NML document.
pub fn parse(xml: &str) -> Result<Collection> {
    let root = xmltree::parse(xml)?;
    if root.name != "NML" {
        return Err(Error::Format(format!("expected NML, found {}", root.name)));
    }
    let tracks = root
        .child("COLLECTION")
        .map(|c| c.children_named("ENTRY").filter_map(parse_entry).collect())
        .unwrap_or_default();
    let mut playlists = Vec::new();
    if let Some(r) = root.child("PLAYLISTS").and_then(|p| p.child("NODE")) {
        walk(r, &mut Vec::new(), &mut playlists);
    }
    Ok(Collection { tracks, playlists })
}

fn a(out: &mut String, k: &str, v: impl std::fmt::Display) {
    let _ = write!(out, " {k}=\"{}\"", xml_escape(&v.to_string()));
}

fn grid_marker_start(g: &BeatGrid) -> f64 {
    // Traktor's grid marker sits on a downbeat: move to the nearest bar start.
    let beat = 60.0 / g.bpm;
    let off = f64::from(g.downbeat_offset % 4);
    if off == 0.0 {
        g.first_beat_sec
    } else if g.first_beat_sec - off * beat >= 0.0 {
        g.first_beat_sec - off * beat
    } else {
        g.first_beat_sec + (4.0 - off) * beat
    }
}

fn write_cue(out: &mut String, c: &Cue) {
    let (ty, len) = match c.kind {
        CueKind::Loop => (5, c.end_sec.map_or(0.0, |e| (e - c.start_sec).max(0.0))),
        _ => (0, 0.0),
    };
    let hot = match (c.kind, c.index) {
        (CueKind::Memory, _) | (_, None) => -1,
        (_, Some(i)) => i64::from(i),
    };
    out.push_str("      <CUE_V2");
    a(out, "NAME", c.label.as_deref().unwrap_or("n.n."));
    a(out, "DISPL_ORDER", 0);
    a(out, "TYPE", ty);
    a(out, "START", format!("{:.6}", c.start_sec * 1000.0));
    a(out, "LEN", format!("{:.6}", len * 1000.0));
    a(out, "REPEATS", -1);
    a(out, "HOTCUE", hot);
    if let Some(col) = c.colour {
        a(out, "MIXAI_COLOR", col.to_hex());
    }
    out.push_str("/>\n");
}

/// Serialises a collection as NML.
pub fn to_nml(col: &Collection) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\" ?>\n<NML VERSION=\"19\">\
         <HEAD COMPANY=\"www.native-instruments.com\" PROGRAM=\"Traktor\"/>\n<MUSICFOLDERS/>\n",
    );
    let _ = writeln!(out, "<COLLECTION ENTRIES=\"{}\">", col.tracks.len());
    for t in &col.tracks {
        let (volume, dir, file) = split_location(&t.path);
        out.push_str("  <ENTRY");
        if let Some(v) = &t.title {
            a(&mut out, "TITLE", v);
        }
        if let Some(v) = &t.artist {
            a(&mut out, "ARTIST", v);
        }
        out.push_str(">\n    <LOCATION");
        a(&mut out, "DIR", &dir);
        a(&mut out, "FILE", &file);
        a(&mut out, "VOLUME", &volume);
        a(&mut out, "VOLUMEID", &volume);
        out.push_str("/>\n");
        if let Some(v) = &t.album {
            out.push_str("    <ALBUM");
            a(&mut out, "TITLE", v);
            out.push_str("/>\n");
        }
        out.push_str("    <INFO");
        if let Some(b) = t.bitrate {
            a(&mut out, "BITRATE", u64::from(b) * 1000);
        }
        for (k, v) in [
            ("GENRE", &t.genre),
            ("LABEL", &t.label),
            ("COMMENT", &t.comment),
        ] {
            if let Some(v) = v {
                a(&mut out, k, v);
            }
        }
        if let Some(k) = t.key {
            a(&mut out, "KEY", k.open_key());
        }
        a(&mut out, "PLAYCOUNT", t.play_count);
        if let Some(d) = t.duration_sec {
            a(&mut out, "PLAYTIME", d.round() as i64);
            a(&mut out, "PLAYTIME_FLOAT", format!("{d:.6}"));
        }
        if let Some(r) = t.rating {
            a(&mut out, "RANKING", u32::from(r.min(5)) * 51);
        }
        if let Some(d) = t.added_at {
            a(&mut out, "IMPORT_DATE", format_date_slash(d));
        }
        if let Some(d) = t.last_played {
            a(&mut out, "LAST_PLAYED", format_date_slash(d));
        }
        if let Some(y) = t.year {
            a(&mut out, "RELEASE_DATE", format!("{y}/1/1"));
        }
        if let Some(c) = t.colour {
            a(&mut out, "COLOR", traktor_track_index(c));
        }
        out.push_str("/>\n");
        if let Some(bpm) = t.bpm.or(t.grid.as_ref().map(|g| g.bpm)) {
            let _ = writeln!(
                out,
                "    <TEMPO BPM=\"{bpm:.6}\" BPM_QUALITY=\"100.000000\"/>"
            );
        }
        if let Some(k) = t.key {
            let _ = writeln!(out, "    <MUSICAL_KEY VALUE=\"{}\"/>", k.traktor_value());
        }
        if let Some(g) = &t.grid {
            let mut markers = vec![(grid_marker_start(g), g.bpm)];
            markers.extend(g.anchors.iter().map(|x| (x.sec, x.bpm)));
            for (m, bpm) in markers {
                let _ = writeln!(
                    out,
                    "      <CUE_V2 NAME=\"AutoGrid\" DISPL_ORDER=\"0\" TYPE=\"4\" START=\"{:.6}\" LEN=\"0.000000\" REPEATS=\"-1\" HOTCUE=\"-1\"><GRID BPM=\"{:.6}\"/></CUE_V2>",
                    m * 1000.0,
                    bpm
                );
            }
        }
        for c in &t.cues {
            write_cue(&mut out, c);
        }
        out.push_str("  </ENTRY>\n");
    }
    out.push_str("</COLLECTION>\n<SETS ENTRIES=\"0\"></SETS>\n<PLAYLISTS>\n");
    write_tree(&mut out, col);
    out.push_str("</PLAYLISTS>\n</NML>\n");
    out
}

fn write_tree(out: &mut String, col: &Collection) {
    // Group playlists by folder path, keeping first-seen order.
    #[derive(Default)]
    struct F<'a> {
        name: String,
        folders: Vec<F<'a>>,
        lists: Vec<&'a Playlist>,
        order: Vec<(bool, usize)>,
    }
    let mut root = F {
        name: "$ROOT".into(),
        ..F::default()
    };
    for pl in &col.playlists {
        let mut cur = &mut root;
        for part in &pl.folder {
            let idx = match cur.folders.iter().position(|f| &f.name == part) {
                Some(i) => i,
                None => {
                    cur.folders.push(F {
                        name: part.clone(),
                        ..F::default()
                    });
                    cur.order.push((true, cur.folders.len() - 1));
                    cur.folders.len() - 1
                }
            };
            cur = &mut cur.folders[idx];
        }
        cur.lists.push(pl);
        cur.order.push((false, cur.lists.len() - 1));
    }
    let known: HashMap<String, &TrackRecord> =
        col.tracks.iter().map(|t| (path_key(&t.path), t)).collect();
    fn rec(out: &mut String, f: &F<'_>, depth: usize, known: &HashMap<String, &TrackRecord>) {
        let pad = " ".repeat(depth * 2);
        let _ = writeln!(
            out,
            "{pad}<NODE TYPE=\"FOLDER\" NAME=\"{}\">",
            xml_escape(&f.name)
        );
        let _ = writeln!(out, "{pad}  <SUBNODES COUNT=\"{}\">", f.order.len());
        for (is_folder, i) in &f.order {
            if *is_folder {
                rec(out, &f.folders[*i], depth + 2, known);
            } else {
                let pl = f.lists[*i];
                let keys: Vec<String> = pl
                    .tracks
                    .iter()
                    .filter(|p| known.contains_key(&path_key(p)))
                    .map(|p| primary_key(p))
                    .collect();
                let _ = writeln!(
                    out,
                    "{pad}    <NODE TYPE=\"PLAYLIST\" NAME=\"{}\">",
                    xml_escape(&pl.name)
                );
                let _ = writeln!(
                    out,
                    "{pad}      <PLAYLIST ENTRIES=\"{}\" TYPE=\"LIST\" UUID=\"\">",
                    keys.len()
                );
                for k in keys {
                    let _ = writeln!(
                        out,
                        "{pad}        <ENTRY><PRIMARYKEY TYPE=\"TRACK\" KEY=\"{}\"/></ENTRY>",
                        xml_escape(&k)
                    );
                }
                let _ = writeln!(out, "{pad}      </PLAYLIST>");
                let _ = writeln!(out, "{pad}    </NODE>");
            }
        }
        let _ = writeln!(out, "{pad}  </SUBNODES>");
        let _ = writeln!(out, "{pad}</NODE>");
    }
    rec(out, &root, 0, &known);
}
