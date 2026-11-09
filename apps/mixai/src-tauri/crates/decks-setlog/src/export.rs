//! Tracklist exports.

use crate::Entry;

fn stamp(sec: f64) -> String {
    let s = sec.max(0.0).floor() as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

fn label(e: &Entry) -> String {
    match (e.track.artist.trim(), e.track.title.trim()) {
        ("", "") => "ID – ID".into(),
        ("", t) => t.into(),
        (a, "") => format!("{a} – ID"),
        (a, t) => format!("{a} – {t}"),
    }
}

/// `01. [0:00] Artist – Title` lines (Mixcloud / YouTube / SoundCloud descriptions).
pub fn text(entries: &[Entry]) -> String {
    entries
        .iter()
        .enumerate()
        .map(|(i, e)| format!("{:02}. [{}] {}\n", i + 1, stamp(e.start_sec), label(e)))
        .collect()
}

fn cue_quote(s: &str) -> String {
    s.replace('"', "'").replace(['\r', '\n'], " ")
}

/// Valid ISRC: 2 letters, 3 alphanumerics, 7 digits (dashes / spaces ignored), upper-cased.
pub fn normalise_isrc(s: &str) -> Option<String> {
    let c: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase();
    let b = c.as_bytes();
    (b.len() == 12
        && b[..2].iter().all(u8::is_ascii_alphabetic)
        && b[2..5].iter().all(u8::is_ascii_alphanumeric)
        && b[5..].iter().all(u8::is_ascii_digit))
    .then_some(c)
}

/// CUE sheet for the recorded WAV: one TRACK per entry, `INDEX 01 mm:ss:ff` (75 frames/s), ISRC when valid.
pub fn cue_sheet(entries: &[Entry], wav_file: &str, set_title: &str, dj: &str) -> String {
    let mut out = format!(
        "PERFORMER \"{}\"\nTITLE \"{}\"\nFILE \"{}\" WAVE\n",
        cue_quote(dj),
        cue_quote(set_title),
        cue_quote(wav_file)
    );
    for (i, e) in entries.iter().enumerate() {
        let frames = (e.start_sec.max(0.0) * 75.0).round() as u64;
        let (m, s, f) = (frames / 75 / 60, frames / 75 % 60, frames % 75);
        out.push_str(&format!("  TRACK {:02} AUDIO\n", i + 1));
        out.push_str(&format!("    TITLE \"{}\"\n", cue_quote(&e.track.title)));
        out.push_str(&format!(
            "    PERFORMER \"{}\"\n",
            cue_quote(&e.track.artist)
        ));
        if let Some(isrc) = e.track.isrc.as_deref().and_then(normalise_isrc) {
            out.push_str(&format!("    ISRC {isrc}\n"));
        }
        out.push_str(&format!("    INDEX 01 {m:02}:{s:02}:{f:02}\n"));
    }
    out
}

fn csv(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r', ';']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Broadcast / public-performance report for ORDA and UCMR-ADA (Romanian collecting societies):
/// `Nr,Titlu,Artist,ISRC,Start,Durata difuzare (s)` — one row per entry, UTF-8 with header;
/// `Start` is the offset into the recording.
pub fn orda_ucmr_csv(entries: &[Entry]) -> String {
    let mut out = String::from("Nr,Titlu,Artist,ISRC,Start,Durata difuzare (s)\n");
    for (i, e) in entries.iter().enumerate() {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            i + 1,
            csv(&e.track.title),
            csv(&e.track.artist),
            e.track
                .isrc
                .as_deref()
                .and_then(normalise_isrc)
                .unwrap_or_default(),
            stamp(e.start_sec),
            e.played_sec.max(0.0).round() as u64
        ));
    }
    out
}

/// Mixcloud upload API form fields (`sections-N-song`, `-artist`, `-start_time`) as a JSON object.
pub fn mixcloud_sections(entries: &[Entry]) -> String {
    let mut m = serde_json::Map::new();
    for (i, e) in entries.iter().enumerate() {
        m.insert(format!("sections-{i}-song"), e.track.title.clone().into());
        m.insert(
            format!("sections-{i}-artist"),
            e.track.artist.clone().into(),
        );
        m.insert(
            format!("sections-{i}-start_time"),
            (e.start_sec.max(0.0).floor() as u64).into(),
        );
    }
    serde_json::Value::Object(m).to_string()
}

/// M3U8 in set order; entries without a file path keep a comment line.
pub fn m3u8(entries: &[Entry]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for e in entries {
        out.push_str(&format!(
            "#EXTINF:{},{}\n",
            e.played_sec.max(0.0).round() as i64,
            label(e).replace('\n', " ")
        ));
        out.push_str(e.track.path.as_deref().unwrap_or("# not in library"));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TrackRef;

    fn e(title: &str, artist: &str, isrc: Option<&str>, start: f64, played: f64) -> Entry {
        Entry {
            track: TrackRef {
                id: title.into(),
                title: title.into(),
                artist: artist.into(),
                isrc: isrc.map(Into::into),
                path: None,
            },
            deck: 0,
            start_sec: start,
            played_sec: played,
        }
    }

    fn set() -> Vec<Entry> {
        vec![
            e("Strobe", "deadmau5", Some("us-um7-09-12345"), 0.0, 312.4),
            e("Levels, \"Radio\"", "Avicii", Some("bad"), 312.4, 3400.0),
            e("", "", None, 3712.4, 90.0),
        ]
    }

    #[test]
    fn text_tracklist() {
        assert_eq!(
            text(&set()),
            "01. [0:00] deadmau5 – Strobe\n02. [5:12] Avicii – Levels, \"Radio\"\n03. [1:01:52] ID – ID\n"
        );
    }

    #[test]
    fn isrc_normalisation() {
        assert_eq!(
            normalise_isrc("us-um7-09-12345").as_deref(),
            Some("USUM70912345")
        );
        assert_eq!(normalise_isrc("RO A1B 26 0000001"), None, "13 chars");
        assert_eq!(
            normalise_isrc("ROA1B2600001").as_deref(),
            Some("ROA1B2600001")
        );
        assert_eq!(normalise_isrc("bad"), None);
        assert_eq!(normalise_isrc("12ABC2600001"), None);
    }

    #[test]
    fn cue_sheet_frames_and_isrc() {
        let c = cue_sheet(&set(), "set.wav", "Friday \"live\"", "DJ X");
        assert!(
            c.starts_with("PERFORMER \"DJ X\"\nTITLE \"Friday 'live'\"\nFILE \"set.wav\" WAVE\n")
        );
        assert!(c.contains("  TRACK 01 AUDIO\n    TITLE \"Strobe\"\n    PERFORMER \"deadmau5\"\n    ISRC USUM70912345\n    INDEX 01 00:00:00\n"));
        // 312.4 s = 5:12 + 0.4 s = 30 frames.
        assert!(c.contains("  TRACK 02 AUDIO\n"));
        assert!(c.contains("INDEX 01 05:12:30"));
        assert_eq!(c.matches("ISRC").count(), 1, "invalid ISRC omitted");
        // CUE minutes go past 59 (no hours field).
        assert!(c.contains("INDEX 01 61:52:30"));
    }

    #[test]
    fn orda_report_escapes_and_rounds() {
        let r = orda_ucmr_csv(&set());
        let lines: Vec<_> = r.lines().collect();
        assert_eq!(lines[0], "Nr,Titlu,Artist,ISRC,Start,Durata difuzare (s)");
        assert_eq!(lines[1], "1,Strobe,deadmau5,USUM70912345,0:00,312");
        assert_eq!(lines[2], "2,\"Levels, \"\"Radio\"\"\",Avicii,,5:12,3400");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn mixcloud_and_m3u8() {
        let v: serde_json::Value = serde_json::from_str(&mixcloud_sections(&set())).unwrap();
        assert_eq!(v["sections-0-song"], "Strobe");
        assert_eq!(v["sections-1-start_time"], 312);
        assert_eq!(v["sections-2-artist"], "");
        let m = m3u8(&set());
        assert!(m.starts_with("#EXTM3U\n#EXTINF:312,deadmau5 – Strobe\n# not in library\n"));
    }
}
