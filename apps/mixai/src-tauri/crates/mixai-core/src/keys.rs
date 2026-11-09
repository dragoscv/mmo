//! Musical keys for harmonic mixing (WP19-05 key match).
//!
//! A key is an integer `0..24`: `key % 12` is the tonic pitch class (0 = C,
//! 1 = C#, … 11 = B) and `key / 12` is the mode (0 = major, 1 = minor). So
//! 0 = C major, 9 = A major, 21 = A minor. Camelot (`8A`, `8B`) and Open Key
//! (`1m`, `1d`) notations convert to and from this form.

/// Number of distinct keys (12 major + 12 minor).
pub const KEY_COUNT: u8 = 24;

#[inline]
pub fn is_minor(key: u8) -> bool {
    key >= 12
}

#[inline]
pub fn pitch_class(key: u8) -> u8 {
    key % 12
}

/// Tonic of the relative major (A minor → C major) so relative keys compare equal.
#[inline]
fn major_equivalent(key: u8) -> u8 {
    if is_minor(key) {
        (pitch_class(key) + 3) % 12
    } else {
        pitch_class(key)
    }
}

/// Split `"12A"` into (`"12"`, `'A'`) without panicking on non-ASCII input.
fn split_key(s: &str) -> Option<(i32, char)> {
    let s = s.trim();
    let letter = s.chars().last()?;
    let n: i32 = s[..s.len() - letter.len_utf8()].parse().ok()?;
    (1..=12).contains(&n).then_some((n, letter))
}

/// Parse Camelot notation (`1A`..`12A` minor, `1B`..`12B` major).
pub fn camelot_to_key(s: &str) -> Option<u8> {
    let (n, letter) = split_key(s)?;
    // 8B = C major; each step up the wheel is a fifth (+7 semitones).
    let major_pc = (7 * (n - 8)).rem_euclid(12) as u8;
    match letter {
        'B' | 'b' => Some(major_pc),
        'A' | 'a' => Some(12 + (major_pc + 9) % 12),
        _ => None,
    }
}

/// Camelot notation of a key.
pub fn key_to_camelot(key: u8) -> Option<String> {
    if key >= KEY_COUNT {
        return None;
    }
    let major_pc = major_equivalent(key) as i32;
    // Inverse of camelot_to_key: n = 8 + 7·pc (mod 12), since 7·7 ≡ 1 (mod 12).
    let n = (8 + 7 * major_pc - 1).rem_euclid(12) + 1;
    Some(format!("{n}{}", if is_minor(key) { 'A' } else { 'B' }))
}

/// Parse Open Key notation (`1d`..`12d` major, `1m`..`12m` minor). 1d = C major.
pub fn open_key_to_key(s: &str) -> Option<u8> {
    let (n, letter) = split_key(s)?;
    let camelot = (n - 1 + 7).rem_euclid(12) + 1;
    let l = match letter {
        'd' | 'D' => "B",
        'm' | 'M' => "A",
        _ => return None,
    };
    camelot_to_key(&format!("{camelot}{l}"))
}

/// Pitch offset in semitones caused by playing at `tempo` without key lock.
#[inline]
pub fn tempo_semitones(tempo: f64, key_lock: bool) -> f64 {
    if key_lock || tempo <= 0.0 {
        0.0
    } else {
        12.0 * tempo.log2()
    }
}

/// Key shift (semitones, in `-6..=6`) to apply to a deck so it sounds in the
/// master's key or its relative major/minor.
///
/// `deck_offset` = the deck's current pitch offset NOT counting its key shift
/// (i.e. the varispeed offset when key lock is off); `master_offset` = the
/// master's total pitch offset (its key shift plus varispeed offset).
pub fn key_match_shift(
    deck_key: u8,
    deck_offset: f64,
    master_key: u8,
    master_offset: f64,
) -> Option<f64> {
    if deck_key >= KEY_COUNT || master_key >= KEY_COUNT {
        return None;
    }
    let deck = major_equivalent(deck_key) as f64 + deck_offset;
    let master = major_equivalent(master_key) as f64 + master_offset;
    let d = master - deck;
    Some(d - 12.0 * (d / 12.0).round())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camelot_round_trips() {
        assert_eq!(camelot_to_key("8B"), Some(0)); // C major
        assert_eq!(camelot_to_key("8A"), Some(21)); // A minor
        assert_eq!(camelot_to_key("9B"), Some(7)); // G major
        assert_eq!(camelot_to_key("5A"), Some(12)); // C minor
        for k in 0..KEY_COUNT {
            let c = key_to_camelot(k).unwrap();
            assert_eq!(camelot_to_key(&c), Some(k), "{c}");
        }
        assert_eq!(open_key_to_key("1d"), Some(0));
        assert_eq!(open_key_to_key("1m"), Some(21));
    }

    #[test]
    fn key_match_picks_shortest_shift() {
        // A minor → E minor master: relative majors C → G = +7 ≡ -5.
        let s = key_match_shift(21, 0.0, 16, 0.0).unwrap();
        assert!((s + 5.0).abs() < 1e-9, "{s}");
        // Relative keys need no shift.
        assert!(key_match_shift(21, 0.0, 0, 0.0).unwrap().abs() < 1e-9);
        // Compensates a varispeed offset of +1 semitone on the deck.
        let s = key_match_shift(0, 1.0, 0, 0.0).unwrap();
        assert!((s + 1.0).abs() < 1e-9);
    }
}
