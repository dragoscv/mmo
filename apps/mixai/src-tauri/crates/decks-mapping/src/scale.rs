//! Scale lock: snap incoming notes to the scale of the playing track.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Scale modes supported by the scale lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScaleMode {
    #[default]
    Major,
    /// Natural minor (Aeolian).
    Minor,
    HarmonicMinor,
    Dorian,
    Phrygian,
    Lydian,
    Mixolydian,
    MajorPentatonic,
    MinorPentatonic,
    Blues,
    Chromatic,
}

impl ScaleMode {
    /// Semitone offsets from the tonic.
    pub fn intervals(self) -> &'static [u8] {
        match self {
            ScaleMode::Major => &[0, 2, 4, 5, 7, 9, 11],
            ScaleMode::Minor => &[0, 2, 3, 5, 7, 8, 10],
            ScaleMode::HarmonicMinor => &[0, 2, 3, 5, 7, 8, 11],
            ScaleMode::Dorian => &[0, 2, 3, 5, 7, 9, 10],
            ScaleMode::Phrygian => &[0, 1, 3, 5, 7, 8, 10],
            ScaleMode::Lydian => &[0, 2, 4, 6, 7, 9, 11],
            ScaleMode::Mixolydian => &[0, 2, 4, 5, 7, 9, 10],
            ScaleMode::MajorPentatonic => &[0, 2, 4, 7, 9],
            ScaleMode::MinorPentatonic => &[0, 3, 5, 7, 10],
            ScaleMode::Blues => &[0, 3, 5, 6, 7, 10],
            ScaleMode::Chromatic => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        }
    }

    /// True if `pitch_class` (0..12) is in the scale rooted at `key_pitchclass`.
    pub fn contains(self, key_pitchclass: u8, pitch_class: u8) -> bool {
        let rel = (pitch_class + 12 - key_pitchclass % 12) % 12;
        self.intervals().contains(&rel)
    }
}

/// Snap `note` to the nearest note of the scale `key_pitchclass` (0 = C … 11 = B) / `mode`.
/// Ties go **down** (E in C minor → E♭, C♯ in C minor → C). The result stays in 0..=127.
pub fn scale_lock(note: u8, key_pitchclass: u8, mode: ScaleMode) -> u8 {
    let note = note.min(127);
    let key = key_pitchclass % 12;
    if mode.contains(key, note % 12) {
        return note;
    }
    for d in 1..=6u8 {
        if let Some(n) = note.checked_sub(d) {
            if mode.contains(key, n % 12) {
                return n;
            }
        }
        let up = note + d;
        if up <= 127 && mode.contains(key, up % 12) {
            return up;
        }
    }
    note
}

/// Map an Open Key / Camelot-style key name ("C", "Ebm", "F#", "8A") to (pitch class, mode).
pub fn parse_key(name: &str) -> Option<(u8, ScaleMode)> {
    let s = name.trim();
    if let Some(num) = s
        .strip_suffix(['A', 'a', 'B', 'b'])
        .and_then(|n| n.parse::<u8>().ok())
    {
        if !(1..=12).contains(&num) {
            return None;
        }
        // Camelot: 8B = C major, 8A = A minor; +1 = up a fifth.
        let minor = s.ends_with(['A', 'a']);
        let major_pc = ((num as i32 - 8) * 7).rem_euclid(12) as u8;
        return Some(if minor {
            ((major_pc + 9) % 12, ScaleMode::Minor)
        } else {
            (major_pc, ScaleMode::Major)
        });
    }
    let mut chars = s.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let base = match letter {
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
    let (acc, tail) = if let Some(t) = rest.strip_prefix('#') {
        (1i32, t)
    } else if let Some(t) = rest.strip_prefix('b') {
        (-1, t)
    } else {
        (0, rest.as_str())
    };
    let mode = match tail.to_ascii_lowercase().as_str() {
        "" | "maj" | "major" => ScaleMode::Major,
        "m" | "min" | "minor" => ScaleMode::Minor,
        _ => return None,
    };
    Some(((base + acc).rem_euclid(12) as u8, mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_minor_maps_e_to_eflat() {
        // E4 = 64 → Eb4 = 63; A4 = 69 → Ab4 = 68; B4 = 71 → Bb4 = 70; C stays.
        assert_eq!(scale_lock(64, 0, ScaleMode::Minor), 63);
        assert_eq!(scale_lock(69, 0, ScaleMode::Minor), 68);
        assert_eq!(scale_lock(71, 0, ScaleMode::Minor), 70);
        assert_eq!(scale_lock(60, 0, ScaleMode::Minor), 60);
        assert_eq!(scale_lock(63, 0, ScaleMode::Minor), 63);
        // C# → C (tie down).
        assert_eq!(scale_lock(61, 0, ScaleMode::Minor), 60);
    }

    #[test]
    fn transposed_key_and_edges() {
        // A minor: G# (68) → G (67); F# (66) → F (65).
        assert_eq!(scale_lock(68, 9, ScaleMode::Minor), 67);
        assert_eq!(scale_lock(66, 9, ScaleMode::Minor), 65);
        assert_eq!(scale_lock(0, 2, ScaleMode::Major), 1); // C → C# in D major (only up exists)
        assert_eq!(scale_lock(127, 0, ScaleMode::Chromatic), 127);
    }

    #[test]
    fn key_names() {
        assert_eq!(parse_key("Cm"), Some((0, ScaleMode::Minor)));
        assert_eq!(parse_key("Eb"), Some((3, ScaleMode::Major)));
        assert_eq!(parse_key("8B"), Some((0, ScaleMode::Major)));
        assert_eq!(parse_key("8A"), Some((9, ScaleMode::Minor)));
        assert_eq!(parse_key("5A"), Some((0, ScaleMode::Minor)));
        assert_eq!(parse_key("H"), None);
    }
}
