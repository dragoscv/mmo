//! Musical key notations: Camelot, Open Key, musical text (rekordbox), Traktor int, Engine int.

use serde::{Deserialize, Serialize};

const MAJOR_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
];
const MINOR_NAMES: [&str; 12] = [
    "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm",
];

/// A key as pitch class (C = 0 … B = 11) plus mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MusicalKey {
    pub pitch_class: u8,
    pub minor: bool,
}

impl MusicalKey {
    pub fn new(pitch_class: u8, minor: bool) -> Option<Self> {
        (pitch_class < 12).then_some(Self { pitch_class, minor })
    }

    fn relative_major_pc(self) -> u8 {
        if self.minor {
            (self.pitch_class + 3) % 12
        } else {
            self.pitch_class
        }
    }

    /// Camelot wheel number 1..12 (C major = 8B, A minor = 8A).
    pub fn camelot_number(self) -> u8 {
        (7 * self.relative_major_pc() + 7) % 12 + 1
    }

    /// `8A`, `11B`…
    pub fn camelot(self) -> String {
        format!(
            "{}{}",
            self.camelot_number(),
            if self.minor { 'A' } else { 'B' }
        )
    }

    /// Open Key number 1..12 (C major = 1d, A minor = 1m).
    pub fn open_key_number(self) -> u8 {
        (self.camelot_number() + 4) % 12 + 1
    }

    /// `1m`, `6d`…
    pub fn open_key(self) -> String {
        format!(
            "{}{}",
            self.open_key_number(),
            if self.minor { 'm' } else { 'd' }
        )
    }

    /// Musical text as written by rekordbox (`Am`, `F#m`, `Db`…).
    pub fn musical(self) -> &'static str {
        let i = usize::from(self.pitch_class);
        if self.minor {
            MINOR_NAMES[i]
        } else {
            MAJOR_NAMES[i]
        }
    }

    /// Traktor NML `MUSICAL_KEY VALUE`: 0..11 major from C, 12..23 minor from Cm.
    pub fn traktor_value(self) -> u8 {
        self.pitch_class + if self.minor { 12 } else { 0 }
    }

    pub fn from_traktor_value(v: i64) -> Option<Self> {
        if !(0..24).contains(&v) {
            return None;
        }
        Self::new((v % 12) as u8, v >= 12)
    }

    /// Engine DJ `Track.key`: walks the Camelot wheel from 8B, even = major, odd = minor
    /// (0 = C, 1 = Am, 2 = G, 3 = Em …). Assumption from public Engine Library exports.
    pub fn engine_value(self) -> u8 {
        (self.camelot_number() + 4) % 12 * 2 + u8::from(self.minor)
    }

    pub fn from_engine_value(v: i64) -> Option<Self> {
        if !(0..24).contains(&v) {
            return None;
        }
        let n = ((v / 2 + 7) % 12 + 1) as u8;
        Self::from_camelot_parts(n, v % 2 == 1)
    }

    pub fn from_camelot_parts(n: u8, minor: bool) -> Option<Self> {
        if !(1..=12).contains(&n) {
            return None;
        }
        let major_pc = (7 * (u32::from(n) + 4)) % 12;
        let pc = if minor { (major_pc + 9) % 12 } else { major_pc };
        Self::new(pc as u8, minor)
    }

    pub fn from_open_parts(n: u8, minor: bool) -> Option<Self> {
        if !(1..=12).contains(&n) {
            return None;
        }
        Self::from_camelot_parts((n + 6) % 12 + 1, minor)
    }

    /// Parses Camelot (`8A`), Open Key (`1m`) or musical text (`Am`, `F# minor`, `Db`).
    pub fn parse(s: &str) -> Option<Self> {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        let digits: String = t.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            let n: u8 = digits.parse().ok()?;
            let rest = t[digits.len()..].trim();
            return match rest {
                "A" | "a" => Self::from_camelot_parts(n, true),
                "B" | "b" => Self::from_camelot_parts(n, false),
                "m" | "M" => Self::from_open_parts(n, true),
                "d" | "D" => Self::from_open_parts(n, false),
                _ => None,
            };
        }
        Self::parse_musical(t)
    }

    fn parse_musical(t: &str) -> Option<Self> {
        let mut chars = t.chars();
        let base: i32 = match chars.next()?.to_ascii_uppercase() {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return None,
        };
        let rest: String = chars.collect();
        let (shift, rest) = if let Some(r) = rest.strip_prefix('#').or(rest.strip_prefix('♯')) {
            (1, r)
        } else if let Some(r) = rest.strip_prefix('b').or(rest.strip_prefix('♭')) {
            (-1, r)
        } else {
            (0, rest.as_str())
        };
        let minor = match rest.trim().to_ascii_lowercase().as_str() {
            "" | "maj" | "major" => false,
            "m" | "min" | "minor" => true,
            _ => return None,
        };
        Self::new((base + shift).rem_euclid(12) as u8, minor)
    }
}
