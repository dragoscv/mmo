//! Camelot wheel: harmonic compatibility and root pitch classes.

/// A Camelot key: number 1..=12, `minor` = A, major = B.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Camelot {
    pub number: u8,
    pub minor: bool,
}

impl Camelot {
    /// Parse `8A`, `12b`, ` 3B `. Anything else is `None`.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        let (num, letter) = s.split_at(s.len().checked_sub(1)?);
        let number: u8 = num.parse().ok()?;
        if !(1..=12).contains(&number) {
            return None;
        }
        let minor = match letter {
            "A" | "a" => true,
            "B" | "b" => false,
            _ => return None,
        };
        Some(Self { number, minor })
    }

    /// Shift by `steps` around the wheel (one step = a fifth).
    pub fn shift(self, steps: i32) -> Self {
        let n = (i32::from(self.number) - 1 + steps).rem_euclid(12) + 1;
        Self {
            number: n as u8,
            minor: self.minor,
        }
    }

    pub fn label(self) -> String {
        format!("{}{}", self.number, if self.minor { 'A' } else { 'B' })
    }

    fn wheel_distance(a: u8, b: u8) -> u8 {
        let d = (i16::from(a) - i16::from(b)).unsigned_abs() as u8 % 12;
        d.min(12 - d)
    }
}

/// Harmonic score 0..1 and a reason tag.
///
/// * same key 1.0 · relative (same number, other letter) 0.9 · ±1 same letter 0.85
/// * "energy boost" +2 same letter (+2 semitones) 0.6 · diagonal (±1 other letter) 0.5
/// * anything else falls off with wheel distance; unknown key 0.5 (neutral).
pub fn key_score(from: Option<&str>, to: Option<&str>) -> (f64, &'static str) {
    let (Some(a), Some(b)) = (from.and_then(Camelot::parse), to.and_then(Camelot::parse)) else {
        return (0.5, "key_unknown");
    };
    let d = Camelot::wheel_distance(a.number, b.number);
    match (d, a.minor == b.minor) {
        (0, true) => (1.0, "key_same"),
        (0, false) => (0.9, "key_relative"),
        (1, true) => (0.85, "key_adjacent"),
        (2, true) => (0.6, "key_boost"),
        (1, false) => (0.5, "key_diagonal"),
        (d, _) => ((0.4 - 0.08 * f64::from(d)).max(0.0), "key_clash"),
    }
}

/// Root pitch class (0 = C) of a Camelot key. 8B = C major, 8A = A minor; each step adds a fifth.
pub fn root_pitch_class(k: Camelot) -> u8 {
    let base: i32 = if k.minor { 9 } else { 0 };
    ((base + (i32::from(k.number) - 8) * 7).rem_euclid(12)) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_rejects() {
        assert_eq!(
            Camelot::parse("8A"),
            Some(Camelot {
                number: 8,
                minor: true
            })
        );
        assert_eq!(
            Camelot::parse(" 12b "),
            Some(Camelot {
                number: 12,
                minor: false
            })
        );
        assert_eq!(Camelot::parse("13A"), None);
        assert_eq!(Camelot::parse("0B"), None);
        assert_eq!(Camelot::parse("8C"), None);
        assert_eq!(Camelot::parse(""), None);
        assert_eq!(Camelot::parse("A"), None);
    }

    #[test]
    fn wheel_wraps() {
        let k = Camelot::parse("12A").unwrap();
        assert_eq!(k.shift(1).label(), "1A");
        assert_eq!(Camelot::parse("1B").unwrap().shift(-1).label(), "12B");
        assert_eq!(key_score(Some("12A"), Some("1A")).1, "key_adjacent");
    }

    #[test]
    fn scores_follow_the_wheel() {
        assert_eq!(key_score(Some("8A"), Some("8A")), (1.0, "key_same"));
        assert_eq!(key_score(Some("8A"), Some("8B")).1, "key_relative");
        assert_eq!(key_score(Some("8A"), Some("9A")).1, "key_adjacent");
        assert_eq!(key_score(Some("8A"), Some("10A")).1, "key_boost");
        assert_eq!(key_score(Some("8A"), Some("9B")).1, "key_diagonal");
        let (clash, tag) = key_score(Some("8A"), Some("2A"));
        assert_eq!(tag, "key_clash");
        assert!(clash < 0.1);
        assert_eq!(key_score(None, Some("8A")).1, "key_unknown");
    }

    #[test]
    fn root_pitch_classes_match_music_theory() {
        let pc = |s: &str| root_pitch_class(Camelot::parse(s).unwrap());
        assert_eq!(pc("8B"), 0); // C major
        assert_eq!(pc("8A"), 9); // A minor
        assert_eq!(pc("9B"), 7); // G major
        assert_eq!(pc("7B"), 5); // F major
        assert_eq!(pc("5A"), 0); // C minor
        assert_eq!(pc("1B"), 11); // B major
    }
}
