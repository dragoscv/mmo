//! Musical keys and their three notations: Camelot (`8A`), Open Key (`1m`) and musical names (`A minor` / `Am`).
//! The tables mirror `server/src/media/harmonic.ts` so every MixAI surface names a key the same way.

use std::fmt;

/// Pitch-class names with sharps, C = 0.
pub const PITCH_NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/// Conventional spelling of major tonics (Db, Eb, Ab, Bb rather than sharps).
const MAJOR_NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/// Conventional spelling of minor tonics.
const MINOR_NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
/// Camelot number of a major key by tonic pitch class (C = 8B); a minor key uses its relative major's number.
const MAJOR_CAMELOT: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

/// How a key is shown to the user (D69: Camelot / Open Key / musical toggle).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Notation {
    #[default]
    Camelot,
    OpenKey,
    Musical,
}

/// A major or minor key. `tonic` is a pitch class, C = 0 … B = 11.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Key {
    pub tonic: u8,
    pub minor: bool,
}

impl Key {
    pub fn new(tonic: u8, minor: bool) -> Self {
        Self { tonic: tonic % 12, minor }
    }

    /// 0..24: majors 0..12 by tonic, then minors.
    pub fn index(self) -> usize {
        self.tonic as usize + if self.minor { 12 } else { 0 }
    }

    pub fn from_index(i: usize) -> Self {
        Self::new((i % 12) as u8, i % 24 >= 12)
    }

    pub fn camelot_number(self) -> u8 {
        let major_pc = if self.minor { (self.tonic + 3) % 12 } else { self.tonic };
        MAJOR_CAMELOT[major_pc as usize]
    }

    /// `8A` (minor) / `8B` (major).
    pub fn camelot(self) -> String {
        format!("{}{}", self.camelot_number(), if self.minor { 'A' } else { 'B' })
    }

    /// Open Key: `1d` = C major, `1m` = A minor.
    pub fn open_key(self) -> String {
        format!("{}{}", (self.camelot_number() + 4) % 12 + 1, if self.minor { 'm' } else { 'd' })
    }

    /// `A minor` / `C major`.
    pub fn name(self) -> String {
        if self.minor {
            format!("{} minor", MINOR_NAMES[self.tonic as usize])
        } else {
            format!("{} major", MAJOR_NAMES[self.tonic as usize])
        }
    }

    /// `Am` / `C`.
    pub fn short_name(self) -> String {
        if self.minor {
            format!("{}m", MINOR_NAMES[self.tonic as usize])
        } else {
            MAJOR_NAMES[self.tonic as usize].to_string()
        }
    }

    pub fn label(self, notation: Notation) -> String {
        match notation {
            Notation::Camelot => self.camelot(),
            Notation::OpenKey => self.open_key(),
            Notation::Musical => self.short_name(),
        }
    }

    /// Relative major/minor (same Camelot number, other letter).
    pub fn relative(self) -> Key {
        if self.minor { Key::new(self.tonic + 3, false) } else { Key::new(self.tonic + 9, true) }
    }

    /// Key from a Camelot position (1..=12, A = minor).
    pub fn from_camelot(number: u8, minor: bool) -> Option<Key> {
        let major_pc = MAJOR_CAMELOT.iter().position(|&n| n == number)? as u8;
        Some(if minor { Key::new(major_pc + 9, true) } else { Key::new(major_pc, false) })
    }

    /// Parses Camelot (`8A`), Open Key (`1m`, `1d`) and musical names (`Am`, `A minor`, `F#m`, `Gbmaj`, `C`,
    /// `Bb moll`). Same accepted forms as `toCamelot` on the server.
    pub fn parse(raw: &str) -> Option<Key> {
        let s: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.is_empty() {
            return None;
        }
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let n: u8 = digits.parse().ok()?;
            let rest = s[digits.len()..].trim().to_ascii_lowercase();
            if !(1..=12).contains(&n) {
                return None;
            }
            return match rest.as_str() {
                "a" => Key::from_camelot(n, true),
                "b" => Key::from_camelot(n, false),
                "m" => Key::from_camelot((n + 6) % 12 + 1, true),
                "d" => Key::from_camelot((n + 6) % 12 + 1, false),
                _ => None,
            };
        }
        let mut chars = s.chars();
        let letter = chars.next()?.to_ascii_lowercase();
        let mut pc: i32 = match letter {
            'c' => 0,
            'd' => 2,
            'e' => 4,
            'f' => 5,
            'g' => 7,
            'a' => 9,
            'b' => 11,
            _ => return None,
        };
        let mut rest: String = chars.collect();
        rest = rest.trim_start().to_string();
        if let Some(c) = rest.chars().next() {
            let delta = match c {
                '#' | '♯' => 1,
                'b' | '♭' => -1,
                _ => 0,
            };
            // "b" alone after a letter is a flat, but "bm"/"b minor" is the flat too ("Bbm"); never the quality.
            if delta != 0 {
                pc += delta;
                rest = rest[c.len_utf8()..].trim_start().to_string();
            }
        }
        let minor = match rest.to_ascii_lowercase().as_str() {
            "" | "maj" | "major" | "dur" => false,
            "m" | "min" | "minor" | "moll" => true,
            _ => return None,
        };
        Some(Key::new(pc.rem_euclid(12) as u8, minor))
    }
}

impl fmt::Display for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.camelot())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camelot_open_key_and_names_agree_with_the_server_tables() {
        let am = Key::new(9, true);
        assert_eq!(am.camelot(), "8A");
        assert_eq!(am.open_key(), "1m");
        assert_eq!(am.short_name(), "Am");
        assert_eq!(am.name(), "A minor");
        let c = Key::new(0, false);
        assert_eq!(c.camelot(), "8B");
        assert_eq!(c.open_key(), "1d");
        assert_eq!(Key::new(6, true).camelot(), "11A");
        assert_eq!(Key::new(2, true).camelot(), "7A");
        assert_eq!(Key::new(4, false).camelot(), "12B");
        assert_eq!(Key::new(10, false).short_name(), "Bb");
    }

    #[test]
    fn every_key_round_trips_through_every_notation() {
        for i in 0..24 {
            let k = Key::from_index(i);
            assert_eq!(k.index(), i);
            for n in [Notation::Camelot, Notation::OpenKey, Notation::Musical] {
                assert_eq!(Key::parse(&k.label(n)), Some(k), "{} via {:?}", k.name(), n);
            }
            assert_eq!(k.relative().relative(), k);
            assert_eq!(k.relative().camelot_number(), k.camelot_number());
        }
    }

    #[test]
    fn parses_the_same_tag_forms_as_to_camelot() {
        let cam = |s: &str| Key::parse(s).map(|k| k.camelot());
        assert_eq!(cam("8A").as_deref(), Some("8A"));
        assert_eq!(cam(" 12b ").as_deref(), Some("12B"));
        assert_eq!(cam("A minor").as_deref(), Some("8A"));
        assert_eq!(cam("F#m").as_deref(), Some("11A"));
        assert_eq!(cam("Gbmaj").as_deref(), Some("2B"));
        assert_eq!(cam("C").as_deref(), Some("8B"));
        assert_eq!(cam("Bb moll").as_deref(), Some("3A"));
        assert_eq!(cam("1m").as_deref(), Some("8A"));
        assert_eq!(cam("1d").as_deref(), Some("8B"));
        assert_eq!(cam("6m").as_deref(), Some("1A"));
        assert_eq!(cam("13A"), None);
        assert_eq!(cam("H"), None);
        assert_eq!(cam(""), None);
        assert_eq!(cam("Am7"), None);
    }
}
