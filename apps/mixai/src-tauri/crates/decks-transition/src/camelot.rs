//! Camelot wheel: harmonic compatibility and root pitch classes.

/// Wheel steps of one semitone: a semitone up is seven fifths up (C → C♯ is 8B → 3B), the
/// letter stays. `Camelot::shift_semitones` and the desktop `shiftCamelot` agree on it.
pub const WHEEL_STEPS_PER_SEMITONE: i32 = 7;
/// Below this key score a pair is a clash: `check_safety` warns, `plan_transition` echoes
/// out, and `propose_key_shift` looks for a shift. One line for all three.
pub const KEY_CLASH_BELOW: f64 = 0.45;
/// From this key score a pair fits as it is (same, relative, adjacent): the level a key shift
/// must reach to be proposed.
pub const KEY_FITS_FROM: f64 = 0.85;

/// A Camelot key: number 1..=12, `minor` = A, major = B.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Camelot {
    pub number: u8,
    pub minor: bool,
}

/// ASCII form of a full-width character (`８` → `8`, `Ａ` → `A`); anything else as it is.
fn ascii_form(c: char) -> char {
    match c {
        '\u{FF01}'..='\u{FF5E}' => char::from_u32(u32::from(c) - 0xFEE0).unwrap_or(c),
        _ => c,
    }
}

impl Camelot {
    /// Parse `8A`, `12b`, ` 3B `, full-width `８Ａ`. Anything else is `None`, whatever the text
    /// holds: this never panics. Musical names (`A♭`, `F#m`) are not Camelot and are not parsed
    /// here (`8♭` is not read as `8B`).
    pub fn parse(s: &str) -> Option<Self> {
        // Character by character, never by byte offset: a tag may end in a multibyte character
        // and a byte split inside one panics.
        let mut chars = s.trim().chars().map(ascii_form);
        let minor = match chars.next_back()? {
            'A' | 'a' => true,
            'B' | 'b' => false,
            _ => return None,
        };
        let mut number: u8 = 0;
        let mut digits = false;
        for c in chars {
            let digit = c.to_digit(10)? as u8;
            number = number.checked_mul(10)?.checked_add(digit)?;
            digits = true;
        }
        if !digits || !(1..=12).contains(&number) {
            return None;
        }
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

    /// The key `semitones` higher (negative = lower): [`WHEEL_STEPS_PER_SEMITONE`] wheel steps
    /// per semitone, letter kept (8A + 1 = 3A, 8A − 1 = 1A, 12B + 2 = 2B).
    pub fn shift_semitones(self, semitones: i32) -> Self {
        self.shift(semitones.rem_euclid(12) * WHEEL_STEPS_PER_SEMITONE)
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

/// A key shift of the candidate that makes a clashing pair fit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyShift {
    /// Semitones to shift the candidate by: +1, −1, +2 or −2.
    pub semitones: i8,
    /// The candidate's key after the shift.
    pub key: Camelot,
    /// Relation of the pair after the shift: `key_same`, `key_relative` or `key_adjacent`.
    pub relation: &'static str,
}

/// Key score of `(from, to shifted by s)` when it reaches [`KEY_FITS_FROM`].
fn fits(from: Camelot, to: Camelot, s: i8) -> Option<(f64, KeyShift)> {
    let key = to.shift_semitones(i32::from(s));
    let (score, relation) = key_score(Some(&from.label()), Some(&key.label()));
    (score >= KEY_FITS_FROM).then_some((
        score,
        KeyShift {
            semitones: s,
            key,
            relation,
        },
    ))
}

/// The smallest key shift of `to` (in {+1, −1, +2, −2} semitones) that turns a clashing pair
/// into one that fits (same, relative or adjacent key). `None` when a key is unknown, when
/// the pair is not a clash ([`KEY_CLASH_BELOW`]: a boost or diagonal pair is left alone), or
/// when no such shift exists (8A against 2B: nothing within two semitones).
///
/// Tie rule: the smaller absolute shift first; for the same size the better resulting
/// relation (same 1.0 > relative 0.9 > adjacent 0.85), then the upward one (8A against 2A:
/// +1 → 9A and −1 → 7A are both adjacent, +1 is proposed). With these levels no pair has
/// both a one- and a two-semitone fix (tested exhaustively), so the size rule never has to
/// choose; it is stated so a wider acceptance keeps a defined answer.
pub fn propose_key_shift(from: Option<&str>, to: Option<&str>) -> Option<KeyShift> {
    let (a, b) = (from.and_then(Camelot::parse)?, to.and_then(Camelot::parse)?);
    let (plain, _) = key_score(Some(&a.label()), Some(&b.label()));
    if plain >= KEY_CLASH_BELOW {
        return None;
    }
    for size in [1i8, 2] {
        let up = fits(a, b, size);
        let down = fits(a, b, -size);
        let pick = match (up, down) {
            (Some((su, u)), Some((sd, d))) => Some(if sd > su { d } else { u }),
            (Some((_, u)), None) => Some(u),
            (None, Some((_, d))) => Some(d),
            (None, None) => None,
        };
        if pick.is_some() {
            return pick;
        }
    }
    None
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
    fn hostile_keys_are_rejected_without_panicking() {
        let long = "é".repeat(200);
        let digits = "9".repeat(200) + "A";
        // What tags and other tools really hold: musical names with ♭ / ♯, full-width text, a
        // multibyte last character, nothing at all, or far too much.
        for bad in [
            "",
            " ",
            "\t\n",
            "\u{3000}",
            "A",
            "8",
            "♭",
            "A♭",
            "Am♭",
            "8♭",
            "8♯",
            "F♯m",
            "8é",
            "é",
            "🎧",
            "8A🎧",
            "８",
            "Ａ",
            "８Ｃ",
            "１３Ａ",
            "8 A",
            "-8A",
            "8.5A",
            "\u{feff}8A",
            "8A\u{200b}",
            long.as_str(),
            digits.as_str(),
        ] {
            assert_eq!(Camelot::parse(bad), None, "{bad:?}");
        }
        // Full-width digits and letters are the same key.
        let k = |number, minor| Some(Camelot { number, minor });
        assert_eq!(Camelot::parse("８Ａ"), k(8, true));
        assert_eq!(Camelot::parse("8Ａ"), k(8, true));
        assert_eq!(Camelot::parse("\u{3000}１２ｂ "), k(12, false));
        assert_eq!(Camelot::parse("08A"), k(8, true));
        // The callers of the parser stay calm too.
        assert_eq!(key_score(Some("A♭"), Some("8A")), (0.5, "key_unknown"));
        assert_eq!(key_score(Some("8A"), Some("Am♭")), (0.5, "key_unknown"));
        assert_eq!(key_score(Some("８Ａ"), Some("8A")), (1.0, "key_same"));
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

    fn all_keys() -> Vec<Camelot> {
        (1..=12u8)
            .flat_map(|number| [true, false].map(|minor| Camelot { number, minor }))
            .collect()
    }

    /// The wheel as printed on every Camelot chart, written out by rising semitone: the minor
    /// keys from A minor (8A, B♭m 3A, Bm 10A, Cm 5A, …), the major keys from C major (8B, D♭
    /// 3B, D 10B, E♭ 5B, …). A table, not a formula: nothing here multiplies by seven.
    const CHROMATIC_MINOR: [&str; 12] = [
        "8A", "3A", "10A", "5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A",
    ];
    const CHROMATIC_MAJOR: [&str; 12] = [
        "8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B",
    ];

    #[test]
    fn semitone_shifts_follow_the_printed_wheel_for_all_24_keys() {
        let mut checked = 0;
        for table in [CHROMATIC_MINOR, CHROMATIC_MAJOR] {
            // The table itself holds each of the twelve numbers once.
            let mut numbers: Vec<u8> = table
                .iter()
                .map(|k| Camelot::parse(k).unwrap().number)
                .collect();
            numbers.sort_unstable();
            assert_eq!(numbers, (1..=12).collect::<Vec<u8>>());
            for (i, from) in table.iter().enumerate() {
                for s in [1i32, -1, 2, -2] {
                    let want = table[(i as i32 + s).rem_euclid(12) as usize];
                    let got = Camelot::parse(from).unwrap().shift_semitones(s).label();
                    assert_eq!(got, want, "{from} by {s}");
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 24 * 4);
    }

    #[test]
    fn a_semitone_is_seven_wheel_steps_for_every_key() {
        // Independent of the formula: the root pitch class (8B = C, fifths around the wheel)
        // must move by exactly the semitones asked, and the letter must stay.
        for k in all_keys() {
            for s in [-2i32, -1, 1, 2, 12, -12, 13] {
                let moved = k.shift_semitones(s);
                let want = (i32::from(root_pitch_class(k)) + s).rem_euclid(12) as u8;
                assert_eq!(root_pitch_class(moved), want, "{} by {s}", k.label());
                assert_eq!(moved.minor, k.minor, "{} by {s}: letter", k.label());
                assert!((1..=12).contains(&moved.number));
            }
            assert_eq!(k.shift_semitones(0), k);
        }
        // Spot values a DJ knows (the desktop `shiftCamelot` test has the same ones).
        let k = |s: &str| Camelot::parse(s).unwrap();
        assert_eq!(k("8A").shift_semitones(1).label(), "3A");
        assert_eq!(k("8A").shift_semitones(-1).label(), "1A");
        assert_eq!(k("12B").shift_semitones(2).label(), "2B");
        assert_eq!(k("8A").shift_semitones(12).label(), "8A");
        assert_eq!(
            k("8B").shift_semitones(1).label(),
            "3B",
            "C major up a semitone is C sharp major"
        );
    }

    #[test]
    fn proposes_the_shift_that_makes_a_clash_fit() {
        let p = |a: &str, b: &str| {
            propose_key_shift(Some(a), Some(b)).map(|s| (s.semitones, s.key.label(), s.relation))
        };
        let some = |n: i8, key: &str, rel: &'static str| Some((n, key.to_string(), rel));
        // Same letter, every clashing offset: 3..=9 around the wheel.
        assert_eq!(p("8A", "11A"), some(-2, "9A", "key_adjacent"));
        assert_eq!(p("8A", "12A"), some(1, "7A", "key_adjacent"));
        assert_eq!(p("8A", "1A"), some(1, "8A", "key_same"));
        assert_eq!(
            p("8A", "2A"),
            some(1, "9A", "key_adjacent"),
            "tie: +1 (9A) over -1 (7A)"
        );
        assert_eq!(p("8A", "3A"), some(-1, "8A", "key_same"));
        assert_eq!(p("8A", "4A"), some(-1, "9A", "key_adjacent"));
        assert_eq!(p("8A", "5A"), some(2, "7A", "key_adjacent"));
        // Other letter: only the relative key is reachable.
        assert_eq!(p("8A", "1B"), some(1, "8B", "key_relative"));
        assert_eq!(p("8A", "3B"), some(-1, "8B", "key_relative"));
        assert_eq!(p("8A", "6B"), some(2, "8B", "key_relative"));
        assert_eq!(p("8A", "10B"), some(-2, "8B", "key_relative"));
        // Hopeless clashes: nothing within two semitones.
        for hopeless in ["2B", "11B", "12B", "4B", "5B"] {
            assert_eq!(p("8A", hopeless), None, "8A vs {hopeless}");
        }
        // Not a clash: nothing is proposed, whatever a shift could do.
        for fine in ["8A", "8B", "9A", "7A", "10A", "6A", "9B", "7B"] {
            assert_eq!(p("8A", fine), None, "8A vs {fine}");
        }
        assert_eq!(p("A♭", "8A"), None);
        assert_eq!(propose_key_shift(None, Some("8A")), None);
        assert_eq!(propose_key_shift(Some("8A"), None), None);
        // Major reference, the same rules.
        assert_eq!(p("8B", "2B"), some(1, "9B", "key_adjacent"));
        assert_eq!(p("8B", "1A"), some(1, "8A", "key_relative"));
    }

    #[test]
    fn a_proposal_always_turns_a_clash_into_a_fit_and_never_the_reverse() {
        let keys = all_keys();
        let mut proposals = 0;
        for a in &keys {
            for b in &keys {
                let (plain, _) = key_score(Some(&a.label()), Some(&b.label()));
                let got = propose_key_shift(Some(&a.label()), Some(&b.label()));
                if plain >= KEY_CLASH_BELOW {
                    assert_eq!(got, None, "{} vs {}: not a clash", a.label(), b.label());
                    continue;
                }
                // Which sizes have a fix at all: never both one and two semitones.
                let has = |size: i8| fits(*a, *b, size).is_some() || fits(*a, *b, -size).is_some();
                assert!(
                    !(has(1) && has(2)),
                    "{} vs {}: both sizes fit",
                    a.label(),
                    b.label()
                );
                if let Some(s) = got {
                    proposals += 1;
                    assert!([1, -1, 2, -2].contains(&s.semitones));
                    assert_eq!(s.key, b.shift_semitones(i32::from(s.semitones)));
                    let (after, rel) = key_score(Some(&a.label()), Some(&s.key.label()));
                    assert!(
                        after >= KEY_FITS_FROM,
                        "{} vs {}: {after}",
                        a.label(),
                        b.label()
                    );
                    assert_eq!(rel, s.relation);
                    // Upward wins a tie of equal relations.
                    if s.semitones < 0 {
                        let mirror = fits(*a, *b, -s.semitones);
                        assert!(
                            mirror.is_none_or(|(sc, _)| sc < after),
                            "{} vs {}: -{} chosen over +",
                            a.label(),
                            b.label(),
                            -s.semitones
                        );
                    }
                } else {
                    assert!(
                        !has(1) && !has(2),
                        "{} vs {}: a fix exists",
                        a.label(),
                        b.label()
                    );
                }
            }
        }
        // 7 same-letter + 4 other-letter offsets, for each of the 24 reference keys.
        assert_eq!(proposals, 24 * 11);
    }

    /// The table the desktop's TypeScript port of this rule is checked against as well
    /// (`apps/mixai/src/copilot/key-shift.test.ts`): one line per pair of keys.
    const SHARED_TABLE: &str = include_str!("../fixtures/key-shift-proposals.txt");

    #[test]
    fn the_rule_gives_the_shared_table_the_desktop_port_is_checked_against() {
        let mut pairs = 0;
        let mut proposals = 0;
        for line in SHARED_TABLE.lines().map(str::trim) {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            let (from, to) = (parts[0], parts[1]);
            let want = match parts[2..] {
                ["-"] => None,
                [shift, key, relation] => {
                    let n: i8 = shift.trim_start_matches('+').parse().expect(line);
                    Some((n, key.to_string(), format!("key_{relation}")))
                }
                _ => panic!("unreadable line: {line}"),
            };
            let got = propose_key_shift(Some(from), Some(to))
                .map(|s| (s.semitones, s.key.label(), s.relation.to_string()));
            assert_eq!(got, want, "{line}");
            pairs += 1;
            proposals += usize::from(got.is_some());
        }
        // Every pair of the 24 keys once, in the order of `all_keys`.
        assert_eq!(pairs, 24 * 24);
        assert_eq!(proposals, 24 * 11);
        let first: Vec<String> = SHARED_TABLE
            .lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .take(24)
            .map(|l| l.split_whitespace().nth(1).unwrap().to_string())
            .collect();
        let keys: Vec<String> = all_keys().iter().map(|k| k.label()).collect();
        assert_eq!(first, keys);
    }
}
