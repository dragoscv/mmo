//! Encoder-drift detection and correction on import (WP19-37).
//!
//! MP3 decoders disagree about where a file *starts*, so cues and beatgrids written by another
//! DJ application can land 20–30 ms off in ours. Two mechanisms, both visible in the first MPEG
//! frame:
//!
//! 1. **The Xing / Info header frame.** LAME-style encoders put a silent header frame in front of
//!    the audio. A decoder that recognises it skips it; one that does not decodes it as ~26 ms of
//!    silence / garbage (1152 samples at 44.1 kHz, 24 ms at 48 kHz). That frame is the classic
//!    "26 ms problem" between Traktor and rekordbox.
//! 2. **The LAME encoder delay / padding.** The tag records how many samples the encoder pushed
//!    in front of the music; a gapless decoder trims them.
//!
//! Whether an application recognises the tag depends on *four* cases of the published
//! classification (Estrela / dj-data-converter; sources in `docs/decks/beatgrid.md`):
//!
//! | case | first frame | typical producer |
//! |------|-------------|------------------|
//! | A | no Xing / Info tag at all | CBR rips, some hardware encoders |
//! | B | Xing / Info but no LAME tag, or a `Lavc` / `Lavf` reduced tag | ffmpeg |
//! | C | LAME tag with a zero or wrong CRC | older LAME, re-tagged files |
//! | D | LAME tag with a valid CRC | normal LAME output |
//!
//! **Our reference** is `decks-analysis::decode_file` (symphonia, gapless on): it parses the
//! Xing / Info tag in cases B, C and D, so the header frame is never decoded, and it trims the
//! encoder delay whenever it accepts the LAME extension.
//!
//! Only shifts that are documented and reproduced by several independent implementations are
//! applied; everything else stays 0 and says so (see [`SourceApp::drift_terms`]).
//!
//! **Status of the Traktor −1 frame (cases B and C): confirmed against rekordbox converters,
//! NOT measured against our decoder (symphonia).** The published −1 frame is the Traktor →
//! *rekordbox* offset (dj-data-converter, Rekord Cloud, Mixxx, Rekord Buddy agree), and the
//! only test checks this code against itself. Open question (review P1-10, undecided): this
//! module treats a `Lavc` / `Lavf` tag as case B and a zero CRC as case C, but symphonia
//! accepts both and trims the encoder delay (~25 ms) there, so in case B and in case C with a
//! zero CRC the real Traktor → our-decoder offset is probably −(1 frame + encoder delay). Only
//! case C with a wrong non-zero CRC matches −1 frame exactly. The logic below is deliberately
//! unchanged until a measurement with real files decides it (see `docs/decks/beatgrid.md`).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::model::TrackRecord;

/// Which application wrote the cue/grid times being imported (decoders disagree on MP3 priming).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceApp {
    Rekordbox,
    Serato,
    Traktor,
    EngineDj,
    MixAi,
    Unknown,
}

/// A correction applied to one imported track.
#[derive(Debug, Clone, PartialEq)]
pub struct DriftFix {
    pub path: String,
    /// Seconds added to every cue / grid time (negative = earlier).
    pub shift_sec: f64,
    pub reason: String,
}

/// Published classification of the first MPEG frame (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mp3Case {
    /// A: no Xing / Info tag — every decoder starts at the same sample.
    NoTag,
    /// B: Xing / Info tag without a usable LAME extension (empty, `Lavc`, `Lavf`).
    XingNoLame,
    /// C: LAME extension whose CRC is zero or does not match.
    LameBadCrc,
    /// D: LAME extension with a valid CRC.
    LameOk,
}

impl Mp3Case {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoTag => "A",
            Self::XingNoLame => "B",
            Self::LameBadCrc => "C",
            Self::LameOk => "D",
        }
    }

    /// True when a decoder that does not understand the tag decodes the header frame as audio.
    fn frame_is_ambiguous(self) -> bool {
        matches!(self, Self::XingNoLame | Self::LameBadCrc)
    }
}

/// What the first MPEG frame of an MP3 says about priming.
#[derive(Debug, Clone, PartialEq)]
pub struct Mp3Priming {
    pub case: Mp3Case,
    /// Encoder string of the LAME extension (empty when there is none).
    pub encoder: String,
    pub sample_rate: u32,
    /// PCM samples one frame decodes to (1152 for MPEG-1 Layer III, 576 for MPEG-2/2.5).
    pub frame_samples: u32,
    /// Encoder delay in samples (`528 + 1 + trim`, 0 without a LAME-style tag).
    pub enc_delay: u32,
    /// Encoder padding in samples.
    pub enc_padding: u32,
}

impl Mp3Priming {
    /// Duration of the Xing / Info header frame in seconds.
    pub fn frame_sec(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            f64::from(self.frame_samples) / f64::from(self.sample_rate)
        }
    }

    /// Encoder delay in seconds.
    pub fn delay_sec(&self) -> f64 {
        if self.sample_rate == 0 {
            0.0
        } else {
            f64::from(self.enc_delay) / f64::from(self.sample_rate)
        }
    }
}

/// One per-application assumption behind a shift.
#[derive(Debug, Clone, PartialEq)]
pub struct DriftTerm {
    /// Seconds this term adds to the imported times.
    pub shift_sec: f64,
    /// Why, in one line (ends up in [`DriftFix::reason`]).
    pub note: &'static str,
    /// False = heuristic we have not reproduced ourselves; such terms are never applied.
    pub confirmed: bool,
}

impl SourceApp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rekordbox => "rekordbox",
            Self::Serato => "serato",
            Self::Traktor => "traktor",
            Self::EngineDj => "engine dj",
            Self::MixAi => "mixai",
            Self::Unknown => "unknown",
        }
    }

    /// Terms that make up this application's offset against our decoder for `p`.
    ///
    /// Only **confirmed** terms are applied ([`drift_shift`] drops the rest), so an unverified
    /// assumption can be documented without moving anybody's cues.
    ///
    /// * **Traktor** does not recognise a `Lavc` / `Lavf` tag or a bad-CRC LAME tag (cases B and
    ///   C) and decodes the header frame as audio; we skip it, so its times are one frame late.
    ///   Reproduced by dj-data-converter, Rekord Cloud, Mixxx and Rekord Buddy — confirmed.
    /// * **rekordbox** skips the header frame in the same cases we do; since 1.5.4 it also
    ///   disables gapless playback for LAME MP3s, which *should* put its times one encoder delay
    ///   (~25 ms) away from ours. Not measured against symphonia here: listed, not applied.
    /// * **Serato** and **Engine DJ**: no published measurement against a gapless decoder.
    /// * **MixAI** exports come from this decoder, so there is nothing to correct.
    pub fn drift_terms(self, p: &Mp3Priming) -> Vec<DriftTerm> {
        let mut terms = Vec::new();
        match self {
            Self::Traktor => {
                if p.case.frame_is_ambiguous() {
                    terms.push(DriftTerm {
                        shift_sec: -p.frame_sec(),
                        note: "traktor decodes the Xing/Info frame as audio (case B/C)",
                        confirmed: true,
                    });
                }
                if p.enc_delay > 0 && p.case == Mp3Case::LameOk {
                    terms.push(DriftTerm {
                        shift_sec: -p.delay_sec(),
                        note: "traktor encoder-delay handling (unconfirmed, not applied)",
                        confirmed: false,
                    });
                }
            }
            Self::Rekordbox => {
                if p.enc_delay > 0 {
                    terms.push(DriftTerm {
                        shift_sec: -p.delay_sec(),
                        note: "rekordbox disables gapless for LAME mp3 (unconfirmed, not applied)",
                        confirmed: false,
                    });
                }
            }
            Self::Serato | Self::EngineDj => {
                if p.case.frame_is_ambiguous() || p.enc_delay > 0 {
                    terms.push(DriftTerm {
                        shift_sec: 0.0,
                        note: "no published measurement for this app (unconfirmed, not applied)",
                        confirmed: false,
                    });
                }
            }
            Self::MixAi | Self::Unknown => {}
        }
        terms
    }
}

/// Shift (seconds) to add to `path`'s imported times so they line up with our decoder, plus the
/// reason. `None` when the file is not an MP3 we can read.
pub fn drift_shift(path: &Path, source: SourceApp) -> Option<DriftFix> {
    let p = probe_mp3(path)?;
    Some(fix_from(&path.to_string_lossy(), source, &p))
}

fn fix_from(path: &str, source: SourceApp, p: &Mp3Priming) -> DriftFix {
    let terms = source.drift_terms(p);
    let shift_sec: f64 = terms
        .iter()
        .filter(|t| t.confirmed)
        .map(|t| t.shift_sec)
        .sum();
    let mut reason = format!("{} case {}", source.as_str(), p.case.as_str());
    for t in &terms {
        reason.push_str("; ");
        reason.push_str(t.note);
    }
    DriftFix {
        path: path.to_owned(),
        shift_sec,
        reason,
    }
}

/// Detects the decoder offset of `rec.path` for `source` and shifts cues + grid in place.
/// Returns the applied fix, or `None` when nothing was changed.
pub fn correct_record(rec: &mut TrackRecord, source: SourceApp) -> Option<DriftFix> {
    let fix = drift_shift(Path::new(&rec.path), source)?;
    if fix.shift_sec == 0.0 || !fix.shift_sec.is_finite() {
        return None;
    }
    shift_record(rec, fix.shift_sec);
    Some(fix)
}

/// Move every cue and grid time of `rec` by `shift` seconds (clamped at 0).
pub fn shift_record(rec: &mut TrackRecord, shift: f64) {
    let at = |t: f64| (t + shift).max(0.0);
    for c in &mut rec.cues {
        c.start_sec = at(c.start_sec);
        c.end_sec = c.end_sec.map(at);
    }
    if let Some(g) = &mut rec.grid {
        g.first_beat_sec = at(g.first_beat_sec);
        for a in &mut g.anchors {
            a.sec = at(a.sec);
        }
    }
}

// ---- MP3 header parsing -----------------------------------------------------------------

const MPEG_HEADER_LEN: usize = 4;
/// Bytes of the file we read: enough for the biggest first frame.
const HEAD_BYTES: usize = 4096;

/// Read the first MPEG frame of `path` and classify its priming. `None` for non-MP3 files,
/// unreadable files and files without a parsable first frame.
pub fn probe_mp3(path: &Path) -> Option<Mp3Priming> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "mp3" {
        return None;
    }
    let mut f = File::open(path).ok()?;
    let mut id3 = [0u8; 10];
    let n = read_up_to(&mut f, &mut id3).ok()?;
    let mut skip = 0u64;
    if n == 10 && &id3[..3] == b"ID3" {
        let size = id3[6..10]
            .iter()
            .fold(0u32, |acc, &b| (acc << 7) | u32::from(b & 0x7F));
        skip = 10 + u64::from(size) + if id3[5] & 0x10 != 0 { 10 } else { 0 };
    }
    f.seek(SeekFrom::Start(skip)).ok()?;
    let mut buf = vec![0u8; HEAD_BYTES];
    let n = read_up_to(&mut f, &mut buf).ok()?;
    buf.truncate(n);
    probe_mp3_bytes(&buf)
}

fn read_up_to(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Same as [`probe_mp3`] on a buffer that starts at (or just before) the first MPEG frame.
/// `None` when no frame header is found.
pub fn probe_mp3_bytes(buf: &[u8]) -> Option<Mp3Priming> {
    let start = find_frame(buf)?;
    let h = FrameHeader::parse(&buf[start..])?;
    let frame = &buf[start..(start + h.frame_len).min(buf.len())];
    let mut p = Mp3Priming {
        case: Mp3Case::NoTag,
        encoder: String::new(),
        sample_rate: h.sample_rate,
        frame_samples: h.frame_samples,
        enc_delay: 0,
        enc_padding: 0,
    };
    if let Some(tag) = XingTag::parse(frame, &h) {
        p.case = tag.case;
        p.encoder = tag.encoder;
        p.enc_delay = tag.enc_delay;
        p.enc_padding = tag.enc_padding;
    }
    Some(p)
}

/// First frame sync (`0xFF Ex/Fx`) whose header parses; scans at most the read buffer.
fn find_frame(buf: &[u8]) -> Option<usize> {
    let limit = buf.len().checked_sub(MPEG_HEADER_LEN)?;
    (0..=limit).find(|&i| {
        buf[i] == 0xFF && buf[i + 1] & 0xE0 == 0xE0 && FrameHeader::parse(&buf[i..]).is_some()
    })
}

const BITRATES_V1_L3: [u32; 15] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const BITRATES_V2_L3: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: [u32; 3] = [44_100, 48_000, 32_000];

struct FrameHeader {
    sample_rate: u32,
    frame_samples: u32,
    frame_len: usize,
    side_info_len: usize,
}

impl FrameHeader {
    /// Layer III only (the only layer that carries a Xing / LAME tag).
    fn parse(b: &[u8]) -> Option<Self> {
        if b.len() < MPEG_HEADER_LEN || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
            return None;
        }
        let version = (b[1] >> 3) & 0x03; // 0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1
        let layer = (b[1] >> 1) & 0x03; // 1 = Layer III
        if version == 1 || layer != 1 {
            return None;
        }
        let bitrate_idx = (b[2] >> 4) as usize;
        let rate_idx = ((b[2] >> 2) & 0x03) as usize;
        let padding = usize::from((b[2] >> 1) & 0x01);
        let mono = (b[3] >> 6) & 0x03 == 3;
        if bitrate_idx == 0 || bitrate_idx == 15 || rate_idx > 2 {
            return None;
        }
        let mpeg1 = version == 3;
        let kbps = if mpeg1 {
            BITRATES_V1_L3[bitrate_idx]
        } else {
            BITRATES_V2_L3[bitrate_idx]
        };
        let sample_rate = SAMPLE_RATES[rate_idx]
            / match version {
                3 => 1,
                2 => 2,
                _ => 4,
            };
        let frame_samples: u32 = if mpeg1 { 1152 } else { 576 };
        let frame_len = (frame_samples / 8 * kbps * 1000 / sample_rate) as usize + padding;
        Some(Self {
            sample_rate,
            frame_samples,
            frame_len,
            side_info_len: match (mpeg1, mono) {
                (true, true) => 17,
                (true, false) => 32,
                (false, true) => 9,
                (false, false) => 17,
            },
        })
    }
}

struct XingTag {
    case: Mp3Case,
    encoder: String,
    enc_delay: u32,
    enc_padding: u32,
}

impl XingTag {
    /// Parse the Xing / Info tag of `frame` the way our decoder (symphonia) does: the tag starts
    /// at `4 + side_info_len` from the frame start (the CRC is not part of that offset).
    fn parse(frame: &[u8], h: &FrameHeader) -> Option<Self> {
        let off = MPEG_HEADER_LEN + h.side_info_len;
        let id = frame.get(off..off + 8)?;
        if &id[..4] != b"Xing" && &id[..4] != b"Info" {
            return None;
        }
        let flags = be32(&id[4..8]);
        let mut pos = off + 8;
        for (bit, len) in [(0u32, 4usize), (1, 4), (2, 100), (3, 4)] {
            if flags & (1 << bit) != 0 {
                pos += len;
            }
        }
        // LAME extension: 9-byte encoder string, then 15 bytes up to and including the 3-byte trim.
        let Some(ext) = frame.get(pos..pos + 24) else {
            return Some(Self::no_lame(String::new()));
        };
        let encoder: String = String::from_utf8_lossy(&ext[..9])
            .trim_end_matches('\0')
            .trim_end()
            .to_owned();
        if !is_lame_tag(&encoder) {
            return Some(Self::no_lame(encoder));
        }
        let trim = (u32::from(ext[21]) << 16) | (u32::from(ext[22]) << 8) | u32::from(ext[23]);
        let enc_delay = 528 + 1 + (trim >> 12);
        let enc_padding = (trim & 0xFFF).saturating_sub(528 + 1);
        // 10 more bytes (misc, mp3 gain, surround info, music length, music CRC), then the tag CRC.
        let crc_at = pos + 24 + 10;
        let case = match frame.get(crc_at..crc_at + 2).map(be16) {
            // LAME always writes the CRC; without it the tag is truncated and unverifiable.
            // A zero CRC is the classic "case C" (symphonia also treats 0 as ignore-me).
            None | Some(0) => Mp3Case::LameBadCrc,
            Some(crc) if crc == crc16_ansi(&frame[..crc_at]) => Mp3Case::LameOk,
            Some(_) => Mp3Case::LameBadCrc,
        };
        Some(Self {
            case,
            encoder,
            enc_delay,
            enc_padding,
        })
    }

    fn no_lame(encoder: String) -> Self {
        Self {
            case: Mp3Case::XingNoLame,
            encoder,
            enc_delay: 0,
            enc_padding: 0,
        }
    }
}

/// `LAME…` or the short `L3.99` form; `Lavc` / `Lavf` and empty strings are **not** LAME tags
/// (mp3guessenc and eyeD3 agree, and that is exactly what case B means).
fn is_lame_tag(encoder: &str) -> bool {
    let b = encoder.as_bytes();
    encoder.starts_with("LAME")
        || (b.len() >= 5
            && b[0] == b'L'
            && b[1].is_ascii_digit()
            && b[2] == b'.'
            && b[3].is_ascii_digit()
            && b[4].is_ascii_digit())
}

fn be16(b: &[u8]) -> u16 {
    (u16::from(b[0]) << 8) | u16::from(b[1])
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// CRC-16/ARC (polynomial 0x8005 reflected, init 0) — the checksum LAME writes at the tag's end.
pub fn crc16_ansi(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in data {
        crc ^= u16::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xA001
            } else {
                crc >> 1
            };
        }
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{BeatGrid, Cue, CueKind, GridAnchor};

    /// What the fixture builder writes after the Xing flags.
    #[derive(Clone, Copy)]
    enum Ext {
        /// Case A: no Xing / Info tag at all.
        None,
        /// Case B: a Xing tag whose encoder string is not a LAME tag.
        Encoder(&'static str),
        /// Case C / D: a LAME tag with `delay` samples of priming; `crc_ok` picks the case.
        Lame { delay: u32, crc_ok: bool },
    }

    /// One MPEG-1 Layer III frame (44.1 kHz, 128 kbps, stereo, 417 bytes) with the requested tag.
    fn mp3_frame(ext: Ext) -> Vec<u8> {
        let mut f = vec![0u8; 417];
        f[0] = 0xFF;
        f[1] = 0xFB; // MPEG-1, Layer III, no CRC
        f[2] = 0x90; // 128 kbps, 44.1 kHz, no padding
        f[3] = 0x00; // stereo
        let off = 36; // 4 header + 32 side-info bytes
        match ext {
            Ext::None => {
                f[off] = 0x55; // anything but a tag id
                return f;
            }
            _ => f[off..off + 4].copy_from_slice(b"Info"),
        }
        f[off + 4..off + 8].copy_from_slice(&0x0000_000Fu32.to_be_bytes()); // frames+bytes+toc+quality
        let pos = off + 8 + 4 + 4 + 100 + 4; // = 156
        match ext {
            Ext::None => unreachable!(),
            Ext::Encoder(s) => {
                let b = s.as_bytes();
                f[pos..pos + b.len()].copy_from_slice(b);
            }
            Ext::Lame { delay, crc_ok } => {
                f[pos..pos + 9].copy_from_slice(b"LAME3.100");
                let trim = ((delay - 529) << 12) | 1017; // padding 1017 − 529 = 488
                f[pos + 21] = (trim >> 16) as u8;
                f[pos + 22] = (trim >> 8) as u8;
                f[pos + 23] = trim as u8;
                let crc_at = pos + 24 + 10; // 190
                let crc = if crc_ok {
                    crc16_ansi(&f[..crc_at])
                } else {
                    0xBEEF
                };
                f[crc_at] = (crc >> 8) as u8;
                f[crc_at + 1] = crc as u8;
            }
        }
        f
    }

    fn probe(ext: Ext) -> Mp3Priming {
        probe_mp3_bytes(&mp3_frame(ext)).expect("frame")
    }

    const LAME_OK: Ext = Ext::Lame {
        delay: 1105,
        crc_ok: true,
    };
    const LAME_BAD: Ext = Ext::Lame {
        delay: 1105,
        crc_ok: false,
    };

    #[test]
    fn frame_header_gives_rate_and_frame_length() {
        let p = probe(Ext::None);
        assert_eq!((p.sample_rate, p.frame_samples), (44_100, 1152));
        assert!(
            (p.frame_sec() - 0.026_122).abs() < 1e-5,
            "{}",
            p.frame_sec()
        );
    }

    #[test]
    fn the_four_cases_are_classified() {
        assert_eq!(probe(Ext::None).case, Mp3Case::NoTag);
        assert_eq!(probe(Ext::Encoder("Lavc58.54")).case, Mp3Case::XingNoLame);
        assert_eq!(probe(Ext::Encoder("Lavf")).case, Mp3Case::XingNoLame);
        assert_eq!(probe(Ext::Encoder("")).case, Mp3Case::XingNoLame);
        assert_eq!(probe(LAME_BAD).case, Mp3Case::LameBadCrc);
        let ok = probe(LAME_OK);
        assert_eq!(ok.case, Mp3Case::LameOk);
        assert_eq!(ok.encoder, "LAME3.100");
        assert_eq!((ok.enc_delay, ok.enc_padding), (1105, 488));
        assert!(
            (ok.delay_sec() - 0.025_057).abs() < 1e-5,
            "{}",
            ok.delay_sec()
        );
    }

    #[test]
    fn traktor_loses_the_header_frame_only_in_cases_b_and_c() {
        let frame = probe(Ext::None).frame_sec();
        let shift = |ext| fix_from("x.mp3", SourceApp::Traktor, &probe(ext)).shift_sec;
        assert_eq!(shift(Ext::None), 0.0);
        assert!((shift(Ext::Encoder("Lavc58.54")) + frame).abs() < 1e-12);
        assert!((shift(LAME_BAD) + frame).abs() < 1e-12);
        assert_eq!(shift(LAME_OK), 0.0);
    }

    #[test]
    fn unconfirmed_apps_never_move_anything() {
        for app in [
            SourceApp::Rekordbox,
            SourceApp::Serato,
            SourceApp::EngineDj,
            SourceApp::MixAi,
            SourceApp::Unknown,
        ] {
            for ext in [Ext::None, Ext::Encoder("Lavc58.54"), LAME_OK] {
                let f = fix_from("x.mp3", app, &probe(ext));
                assert_eq!(f.shift_sec, 0.0, "{app:?}: {f:?}");
            }
        }
        // rekordbox's gapless term is documented but not applied.
        let terms = SourceApp::Rekordbox.drift_terms(&probe(LAME_OK));
        assert_eq!(terms.len(), 1);
        assert!(!terms[0].confirmed && terms[0].shift_sec < -0.02);
    }

    #[test]
    fn correcting_a_record_moves_cues_and_grid() {
        let mut rec = TrackRecord {
            path: "x.mp3".into(),
            cues: vec![Cue {
                kind: CueKind::Hot,
                index: Some(0),
                start_sec: 1.0,
                end_sec: Some(2.0),
                colour: None,
                label: None,
            }],
            grid: Some(BeatGrid {
                bpm: 128.0,
                first_beat_sec: 0.5,
                downbeat_offset: 0,
                anchors: vec![GridAnchor {
                    sec: 30.0,
                    bpm: 130.0,
                }],
                fixed: false,
            }),
            ..TrackRecord::default()
        };
        shift_record(&mut rec, -0.026);
        assert!((rec.cues[0].start_sec - 0.974).abs() < 1e-9);
        assert!((rec.cues[0].end_sec.unwrap() - 1.974).abs() < 1e-9);
        let g = rec.grid.as_ref().unwrap();
        assert!((g.first_beat_sec - 0.474).abs() < 1e-9);
        assert!((g.anchors[0].sec - 29.974).abs() < 1e-9);
        // Never negative.
        shift_record(&mut rec, -10.0);
        assert_eq!(rec.cues[0].start_sec, 0.0);
    }

    #[test]
    fn non_mp3_and_unreadable_files_are_skipped() {
        assert!(probe_mp3(Path::new("x.flac")).is_none());
        assert!(probe_mp3(Path::new("does-not-exist.mp3")).is_none());
        let mut rec = TrackRecord {
            path: "does-not-exist.mp3".into(),
            ..TrackRecord::default()
        };
        assert!(correct_record(&mut rec, SourceApp::Traktor).is_none());
    }

    #[test]
    fn a_real_file_round_trips_through_correct_record() {
        let dir = tempfile::tempdir().expect("tmp");
        let path = dir.path().join("lavc.mp3");
        let mut bytes = b"ID3\x04\x00\x00\x00\x00\x00\x0a".to_vec(); // 10-byte ID3v2 body
        bytes.extend_from_slice(&[0u8; 10]);
        bytes.extend_from_slice(&mp3_frame(Ext::Encoder("Lavc58.54")));
        std::fs::write(&path, &bytes).expect("write");
        assert_eq!(probe_mp3(&path).expect("probe").case, Mp3Case::XingNoLame);
        let mut rec = TrackRecord {
            path: path.to_string_lossy().into_owned(),
            cues: vec![Cue {
                kind: CueKind::Memory,
                index: None,
                start_sec: 10.0,
                end_sec: None,
                colour: None,
                label: None,
            }],
            ..TrackRecord::default()
        };
        let fix = correct_record(&mut rec, SourceApp::Traktor).expect("fix");
        assert!((fix.shift_sec + 0.026_122).abs() < 1e-5, "{fix:?}");
        assert!((rec.cues[0].start_sec - 9.973_878).abs() < 1e-5);
        assert!(fix.reason.contains("case B"), "{}", fix.reason);
        // The same file imported from rekordbox: nothing moves.
        let mut rec2 = rec.clone();
        assert!(correct_record(&mut rec2, SourceApp::Rekordbox).is_none());
    }
}
