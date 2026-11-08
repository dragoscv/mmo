//! Harmonic mixing scorer, a port of `server/src/media/harmonic.ts` (WP17-44) so phone, watch, Decks and the
//! server rank transitions identically: Camelot key compatibility + BPM proximity (±6 %, half/double allowed).

use crate::notation::Key;

/// How two keys relate on the Camelot wheel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Relation {
    Same,
    Relative,
    Adjacent,
    EnergyBoost,
    Diagonal,
    WholeStep,
    Clash,
}

fn wheel_distance(a: u8, b: u8) -> u8 {
    let d = (a as i16 - b as i16).unsigned_abs() as u8 % 12;
    d.min(12 - d)
}

pub fn relation(from: Key, to: Key) -> Relation {
    let (a, b) = (from.camelot_number(), to.camelot_number());
    if a == b {
        return if from.minor == to.minor { Relation::Same } else { Relation::Relative };
    }
    let dist = wheel_distance(a, b);
    if from.minor == to.minor {
        match dist {
            1 => Relation::Adjacent,
            5 => Relation::EnergyBoost,
            2 => Relation::WholeStep,
            _ => Relation::Clash,
        }
    } else if dist == 1 {
        Relation::Diagonal
    } else {
        Relation::Clash
    }
}

/// 0..1: same 1, relative 0.92, adjacent 0.85, energy boost 0.6, diagonal 0.55, whole step 0.45, clash 0.
pub fn key_score(from: Key, to: Key) -> f64 {
    match relation(from, to) {
        Relation::Same => 1.0,
        Relation::Relative => 0.92,
        Relation::Adjacent => 0.85,
        Relation::EnergyBoost => 0.6,
        Relation::Diagonal => 0.55,
        Relation::WholeStep => 0.45,
        Relation::Clash => 0.0,
    }
}

/// 1 = same tempo, 0 = 6 % or more apart after half/double folding.
pub fn bpm_closeness(from: f64, to: f64) -> f64 {
    if !(from > 0.0 && to > 0.0) {
        return 0.0;
    }
    let mut r = to / from;
    while r < 1.0 {
        r *= 2.0;
    }
    while r >= 2.0 {
        r /= 2.0;
    }
    let dist = (r - 1.0).abs().min((r - 2.0).abs());
    (1.0 - dist / 0.06).max(0.0)
}

/// Key 70 % + BPM 30 %; BPM only when either key is unknown.
pub fn transition_score(from_key: Option<Key>, from_bpm: Option<f64>, to_key: Option<Key>, to_bpm: Option<f64>) -> f64 {
    let bpm = match (from_bpm, to_bpm) {
        (Some(a), Some(b)) => bpm_closeness(a, b),
        _ => 0.0,
    };
    match (from_key, to_key) {
        (Some(a), Some(b)) => key_score(a, b) * 0.7 + bpm * 0.3,
        _ => bpm,
    }
}

/// Every key that mixes from `key`, best first (for the Camelot wheel highlight).
pub fn compatible_keys(key: Key) -> Vec<(Key, Relation, f64)> {
    let mut out: Vec<(Key, Relation, f64)> = (0..24)
        .map(Key::from_index)
        .map(|k| (k, relation(key, k), key_score(key, k)))
        .filter(|(_, _, s)| *s > 0.0)
        .collect();
    out.sort_by(|a, b| b.2.total_cmp(&a.2));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> Key {
        Key::parse(s).unwrap()
    }

    #[test]
    fn key_scores_match_the_server_scorer() {
        assert_eq!(key_score(k("8A"), k("8A")), 1.0);
        assert_eq!(key_score(k("8A"), k("8B")), 0.92);
        assert_eq!(key_score(k("8A"), k("9A")), 0.85);
        assert_eq!(key_score(k("12A"), k("1A")), 0.85);
        assert_eq!(key_score(k("8A"), k("3A")), 0.6);
        assert_eq!(key_score(k("8A"), k("9B")), 0.55);
        assert_eq!(key_score(k("8A"), k("10A")), 0.45);
        assert_eq!(key_score(k("8A"), k("2B")), 0.0);
    }

    #[test]
    fn bpm_closeness_folds_half_and_double_tempo() {
        assert_eq!(bpm_closeness(128.0, 128.0), 1.0);
        assert!((bpm_closeness(128.0, 64.0) - 1.0).abs() < 1e-9);
        assert!((bpm_closeness(87.0, 174.0) - 1.0).abs() < 1e-9);
        assert!(bpm_closeness(120.0, 126.0) < 0.2);
        assert_eq!(bpm_closeness(120.0, 140.0), 0.0);
        assert_eq!(bpm_closeness(0.0, 120.0), 0.0);
    }

    #[test]
    fn transition_score_weights_key_and_tempo() {
        let s = transition_score(Some(k("8A")), Some(124.0), Some(k("9A")), Some(124.0));
        assert!((s - (0.85 * 0.7 + 0.3)).abs() < 1e-9);
        assert_eq!(transition_score(None, Some(124.0), Some(k("9A")), Some(124.0)), 1.0);
        assert_eq!(transition_score(Some(k("8A")), None, Some(k("8A")), None), 0.7);
    }

    #[test]
    fn compatible_keys_lists_the_six_wheel_neighbours_first() {
        let list = compatible_keys(k("8A"));
        assert_eq!(list[0].0, k("8A"));
        assert_eq!(list[1].0, k("8B"));
        let names: Vec<String> = list.iter().map(|(k, _, _)| k.camelot()).collect();
        for want in ["7A", "9A", "3A", "1A", "7B", "9B", "6A", "10A"] {
            assert!(names.contains(&want.to_string()), "{want} missing in {names:?}");
        }
        assert!(!names.contains(&"2B".to_string()));
    }
}
