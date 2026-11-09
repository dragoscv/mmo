//! Colour palettes of the major DJ applications and nearest-colour mapping.
//!
//! rekordbox and Serato store exact RGB for cues; Traktor uses an indexed track colour and
//! fixed per-type cue colours. Palette values come from public exports of each application;
//! treat them as close approximations of what the applications display.

use crate::model::Rgb;

/// rekordbox track colours (`Colour` attribute / PDB colour index 1..8).
pub const REKORDBOX_TRACK: [(&str, Rgb); 8] = [
    ("Pink", Rgb::new(0xFF, 0x00, 0x7F)),
    ("Red", Rgb::new(0xFF, 0x00, 0x00)),
    ("Orange", Rgb::new(0xFF, 0xA5, 0x00)),
    ("Yellow", Rgb::new(0xFF, 0xFF, 0x00)),
    ("Green", Rgb::new(0x00, 0xFF, 0x00)),
    ("Aqua", Rgb::new(0x25, 0xFD, 0xE9)),
    ("Blue", Rgb::new(0x00, 0x00, 0xFF)),
    ("Purple", Rgb::new(0x66, 0x00, 0x99)),
];

/// rekordbox 6/7 hot cue palette (16 colours, CDJ-3000 order).
pub const REKORDBOX_CUE: [Rgb; 16] = [
    Rgb::new(0xDE, 0x44, 0xCF),
    Rgb::new(0xB4, 0x32, 0xFF),
    Rgb::new(0xAA, 0x72, 0xFF),
    Rgb::new(0x64, 0x73, 0xFF),
    Rgb::new(0x30, 0x5A, 0xFF),
    Rgb::new(0x50, 0xB4, 0xFF),
    Rgb::new(0x00, 0xE0, 0xFF),
    Rgb::new(0x1F, 0xA3, 0x92),
    Rgb::new(0x10, 0xB1, 0x76),
    Rgb::new(0x28, 0xE2, 0x14),
    Rgb::new(0xA5, 0xE1, 0x16),
    Rgb::new(0xB4, 0xBE, 0x04),
    Rgb::new(0xC3, 0xAF, 0x04),
    Rgb::new(0xE0, 0x64, 0x1B),
    Rgb::new(0xE6, 0x28, 0x28),
    Rgb::new(0xFF, 0x12, 0x7B),
];

/// Serato DJ cue colours as stored in `Serato Markers2`.
pub const SERATO_CUE: [Rgb; 18] = [
    Rgb::new(0xCC, 0x00, 0x00),
    Rgb::new(0xCC, 0x44, 0x00),
    Rgb::new(0xCC, 0x88, 0x00),
    Rgb::new(0xCC, 0xCC, 0x00),
    Rgb::new(0x88, 0xCC, 0x00),
    Rgb::new(0x44, 0xCC, 0x00),
    Rgb::new(0x00, 0xCC, 0x00),
    Rgb::new(0x00, 0xCC, 0x44),
    Rgb::new(0x00, 0xCC, 0x88),
    Rgb::new(0x00, 0xCC, 0xCC),
    Rgb::new(0x00, 0x88, 0xCC),
    Rgb::new(0x00, 0x44, 0xCC),
    Rgb::new(0x00, 0x00, 0xCC),
    Rgb::new(0x44, 0x00, 0xCC),
    Rgb::new(0x88, 0x00, 0xCC),
    Rgb::new(0xCC, 0x00, 0xCC),
    Rgb::new(0xCC, 0x00, 0x88),
    Rgb::new(0xCC, 0x00, 0x44),
];

/// Traktor track colours, NML `INFO COLOR` 1..7.
pub const TRAKTOR_TRACK: [(&str, Rgb); 7] = [
    ("Red", Rgb::new(0xFF, 0x00, 0x00)),
    ("Orange", Rgb::new(0xFF, 0x8C, 0x00)),
    ("Yellow", Rgb::new(0xFF, 0xFF, 0x00)),
    ("Green", Rgb::new(0x00, 0xFF, 0x00)),
    ("Blue", Rgb::new(0x00, 0x00, 0xFF)),
    ("Violet", Rgb::new(0x8A, 0x2B, 0xE2)),
    ("Magenta", Rgb::new(0xFF, 0x00, 0xFF)),
];

/// Traktor's fixed colour for a `CUE_V2 TYPE` (0 cue, 1 fade-in, 2 fade-out, 3 load, 5 loop).
pub fn traktor_cue_type_colour(cue_type: u8) -> Rgb {
    match cue_type {
        1 | 2 => Rgb::new(0xFF, 0x8C, 0x00),
        3 => Rgb::new(0xFF, 0xD7, 0x00),
        5 => Rgb::new(0x00, 0xC8, 0x00),
        _ => Rgb::new(0x00, 0x7F, 0xFF),
    }
}

/// Perceptual ("redmean") squared distance.
pub fn distance(a: Rgb, b: Rgb) -> u32 {
    let rm = (u32::from(a.r) + u32::from(b.r)) / 2;
    let dr = i32::from(a.r) - i32::from(b.r);
    let dg = i32::from(a.g) - i32::from(b.g);
    let db = i32::from(a.b) - i32::from(b.b);
    let (dr2, dg2, db2) = ((dr * dr) as u32, (dg * dg) as u32, (db * db) as u32);
    (((512 + rm) * dr2) >> 8) + 4 * dg2 + (((767 - rm) * db2) >> 8)
}

/// Index and value of the palette entry nearest to `c`. `palette` must not be empty.
pub fn nearest(palette: &[Rgb], c: Rgb) -> (usize, Rgb) {
    palette
        .iter()
        .copied()
        .enumerate()
        .min_by_key(|(_, p)| distance(*p, c))
        .unwrap_or((0, c))
}

fn names_to_rgb<const N: usize>(p: &[(&str, Rgb); N]) -> [Rgb; N] {
    (*p).map(|(_, c)| c)
}

/// Target application for colour mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Rekordbox,
    Serato,
    Traktor,
}

/// Nearest cue colour the target can display.
pub fn map_cue_colour(c: Rgb, to: Platform) -> Rgb {
    match to {
        Platform::Rekordbox => nearest(&REKORDBOX_CUE, c).1,
        Platform::Serato => nearest(&SERATO_CUE, c).1,
        Platform::Traktor => nearest(&names_to_rgb(&TRAKTOR_TRACK), c).1,
    }
}

/// Nearest track colour the target can display.
pub fn map_track_colour(c: Rgb, to: Platform) -> Rgb {
    match to {
        Platform::Rekordbox => nearest(&names_to_rgb(&REKORDBOX_TRACK), c).1,
        Platform::Serato => c,
        Platform::Traktor => nearest(&names_to_rgb(&TRAKTOR_TRACK), c).1,
    }
}

/// Traktor `INFO COLOR` index (1..7) for a colour.
pub fn traktor_track_index(c: Rgb) -> u8 {
    nearest(&names_to_rgb(&TRAKTOR_TRACK), c).0 as u8 + 1
}

/// Colour for a Traktor `INFO COLOR` index.
pub fn traktor_track_colour(index: i64) -> Option<Rgb> {
    usize::try_from(index - 1)
        .ok()
        .and_then(|i| TRAKTOR_TRACK.get(i))
        .map(|(_, c)| *c)
}

/// Colour for a rekordbox PDB colour index (1..8).
pub fn rekordbox_track_colour(index: u8) -> Option<Rgb> {
    usize::from(index)
        .checked_sub(1)
        .and_then(|i| REKORDBOX_TRACK.get(i))
        .map(|(_, c)| *c)
}
