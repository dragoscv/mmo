//! Next-track ranking.

use serde::{Deserialize, Serialize};

use crate::TrackFeatures;
use crate::camelot::{KEY_FITS_FROM, key_score, propose_key_shift};

/// Key term of a clashing candidate that ONE semitone of key shift makes fit.
///
/// Where it sits, on purpose: below every pair that fits as it is (same 1.0, relative 0.9,
/// adjacent 0.85), because the DJ has to do something first and the deck then plays through
/// the pitch shifter; above the "energy boost" pair (0.6), the diagonal pair and an unknown
/// key (0.5), because after one semitone the mix is a real harmonic fit and one semitone of
/// shift is hard to hear; far above what the pair scored as a clash (0.24 at most).
///
/// The key term alone does not keep a proposal below a fit: tempo and energy can lift it over
/// an adjacent-key track that is a few BPM off. The owner's rule is absolute, so
/// [`rank_next_with`] also caps a proposal row's SCORE below the lowest-scoring fit row
/// (`cap_proposals_below_fits`).
pub const KEY_SHIFT_ONE: f64 = 0.7;
/// Key term of a clashing candidate that needs TWO semitones of key shift to fit.
///
/// Below [`KEY_SHIFT_ONE`] and below the "energy boost" pair (0.6): two semitones are heard
/// on voices and on bass, so a pair that works without touching anything comes first. Above
/// the diagonal pair and an unknown key (0.5): once shifted it fits for certain, which those
/// two do not promise. Still below every pair that fits as it is, still above a clash (0.24).
pub const KEY_SHIFT_TWO: f64 = 0.55;
/// Reason tag of a candidate with a key-shift proposal. It takes the place of `key_clash`
/// (loaded without the shift, the pair still clashes) and is the first reason.
pub const KEY_SHIFTABLE: &str = "key_shiftable";

/// Extras of the ranking that only some callers ask for. The default is plain [`rank_next`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RankExtras {
    /// Propose a key shift for a clashing candidate that one or two semitones make fit
    /// ([`propose_key_shift`]) and rank it by [`KEY_SHIFT_ONE`] / [`KEY_SHIFT_TWO`] instead of
    /// its clash value. Desktop only: the native apps rank through [`rank_next`].
    pub key_shift: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnergyDirection {
    /// Keep the energy level.
    #[default]
    Hold,
    /// Build up (+1..+2).
    Up,
    /// Cool down.
    Down,
}

/// A library track that could come next.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub track: TrackFeatures,
    /// Minutes since it was last played in this set (`None` = not played).
    pub played_minutes_ago: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RankOptions {
    pub energy: EnergyDirection,
    /// Largest acceptable tempo change in percent (default 6 %).
    pub max_tempo_change_pct: f64,
    /// Allow half / double time matches (e.g. 87 → 174).
    pub allow_half_double: bool,
    /// Same artist back to back is penalised.
    pub avoid_same_artist: bool,
    pub limit: usize,
}

impl Default for RankOptions {
    fn default() -> Self {
        Self {
            energy: EnergyDirection::Hold,
            max_tempo_change_pct: 6.0,
            allow_half_double: true,
            avoid_same_artist: true,
            limit: 10,
        }
    }
}

/// A ranked suggestion with its score parts and reason tags (localised by the UI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ranked {
    pub id: String,
    pub score: f64,
    pub key: f64,
    pub tempo: f64,
    pub energy: f64,
    pub reasons: Vec<String>,
    /// Tempo ratio the incoming deck needs to match the playing one (1.0 = none).
    pub tempo_ratio: Option<f64>,
    /// Proposed key shift of this track in semitones (+1, −1, +2, −2) that makes a clashing
    /// pair fit. Only [`rank_next_with`] with [`RankExtras::key_shift`] sets it; the shift is
    /// a proposal, nothing is applied. Left out of the JSON when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_shift: Option<i8>,
    /// The track's key after [`Ranked::key_shift`] (Camelot). Set together with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_after: Option<String>,
}

/// Tempo score 0..1 and the ratio needed (considering half / double time).
pub fn tempo_score(
    from: Option<f64>,
    to: Option<f64>,
    max_pct: f64,
    half_double: bool,
) -> (f64, Option<f64>) {
    let (Some(a), Some(b)) = (from.filter(|v| *v > 0.0), to.filter(|v| *v > 0.0)) else {
        return (0.4, None);
    };
    let mut best: Option<(f64, f64)> = None;
    let factors: &[f64] = if half_double {
        &[1.0, 2.0, 0.5]
    } else {
        &[1.0]
    };
    for &f in factors {
        let target = b * f;
        let pct = ((a / target) - 1.0).abs() * 100.0;
        let ratio = a / b;
        if best.is_none_or(|(p, _)| pct < p) {
            best = Some((pct, ratio));
        }
    }
    let (pct, ratio) = best.unwrap_or((100.0, 1.0));
    let max = max_pct.max(0.1);
    let s = if pct <= max {
        1.0 - 0.5 * (pct / max)
    } else {
        (0.5 - (pct - max) / (2.0 * max)).max(0.0)
    };
    (s, Some(ratio))
}

fn energy_score(from: Option<u8>, to: Option<u8>, dir: EnergyDirection) -> (f64, &'static str) {
    let (Some(a), Some(b)) = (from, to) else {
        return (0.5, "energy_unknown");
    };
    let d = i16::from(b) - i16::from(a);
    match dir {
        EnergyDirection::Hold => match d.abs() {
            0 => (1.0, "energy_hold"),
            1 => (0.8, "energy_hold"),
            2 => (0.5, "energy_shift"),
            _ => (0.2, "energy_jump"),
        },
        EnergyDirection::Up => match d {
            1 | 2 => (1.0, "energy_up"),
            0 => (0.6, "energy_hold"),
            3 => (0.6, "energy_jump"),
            _ => (0.2, "energy_against"),
        },
        EnergyDirection::Down => match d {
            -2 | -1 => (1.0, "energy_down"),
            0 => (0.6, "energy_hold"),
            -3 => (0.6, "energy_jump"),
            _ => (0.2, "energy_against"),
        },
    }
}

/// Rank `candidates` as the next track after `playing`. Weights: key 0.4, tempo 0.35, energy 0.25,
/// minus repetition (played in the last 60 min: up to −0.5) and same-artist (−0.15) penalties.
pub fn rank_next(
    playing: &TrackFeatures,
    candidates: &[Candidate],
    opts: &RankOptions,
) -> Vec<Ranked> {
    rank_next_with(playing, candidates, opts, RankExtras::default())
}

/// [`rank_next`] with [`RankExtras`]. With every extra off the result is that of `rank_next`.
///
/// With `key_shift` on, a candidate whose key clashes with `playing.key` and that
/// [`propose_key_shift`] can fix gets the key term [`KEY_SHIFT_ONE`] or [`KEY_SHIFT_TWO`] (by
/// the size of the shift) instead of its clash value, [`KEY_SHIFTABLE`] instead of `key_clash`
/// as its first reason, and the proposal in [`Ranked::key_shift`] / [`Ranked::key_after`].
/// `playing.key` is the reference as the caller gives it: a caller that wants the key the room
/// hears (a deck with a key shift on) passes that key. Every other candidate is scored as before.
///
/// **A proposal row never ranks above a track that fits as it is** (the owner's rule): after
/// scoring, and before the list is cut to `opts.limit`, every proposal row that would score at
/// or above the lowest-scoring fit row (key term at or above [`KEY_FITS_FROM`]: same key,
/// relative, adjacent) is capped to just below that row's score; its reported `score` is the
/// capped one (the score a row reports is the score it is sorted by). Capped rows keep the
/// order they had among themselves (one float step apart, so a one-semitone proposal still
/// stands above a two-semitone one at the same tempo and energy); rows that tied before still
/// tie-break by id. Rows without a proposal are never moved: their relative order is exactly
/// the plain one. With no fit row in the list nothing is capped, so a proposal can still rank
/// above a natural "boost" (0.6), a diagonal and an unknown key (0.5), on purpose.
pub fn rank_next_with(
    playing: &TrackFeatures,
    candidates: &[Candidate],
    opts: &RankOptions,
    extras: RankExtras,
) -> Vec<Ranked> {
    let mut out: Vec<Ranked> = candidates
        .iter()
        .filter(|c| c.track.id != playing.id)
        .map(|c| {
            let t = &c.track;
            let (mut k, mut ktag) = key_score(playing.key.as_deref(), t.key.as_deref());
            let shift = if extras.key_shift {
                propose_key_shift(playing.key.as_deref(), t.key.as_deref())
            } else {
                None
            };
            if let Some(s) = shift {
                k = if s.semitones.abs() == 1 {
                    KEY_SHIFT_ONE
                } else {
                    KEY_SHIFT_TWO
                };
                ktag = KEY_SHIFTABLE;
            }
            let (tp, ratio) = tempo_score(
                playing.bpm,
                t.bpm,
                opts.max_tempo_change_pct,
                opts.allow_half_double,
            );
            let (e, etag) = energy_score(playing.energy, t.energy, opts.energy);
            let mut score = 0.4 * k + 0.35 * tp + 0.25 * e;
            let mut reasons = vec![ktag.to_string(), etag.to_string()];
            if tp >= 0.75 {
                reasons.push("tempo_close".into());
            } else if tp < 0.4 {
                reasons.push("tempo_far".into());
            }
            if let Some(m) = c.played_minutes_ago {
                let p = (0.5 * (1.0 - m / 60.0)).clamp(0.0, 0.5);
                if p > 0.0 {
                    score -= p;
                    reasons.push("recently_played".into());
                }
            }
            if opts.avoid_same_artist
                && !t.artist.is_empty()
                && t.artist.eq_ignore_ascii_case(&playing.artist)
            {
                score -= 0.15;
                reasons.push("same_artist".into());
            }
            if t.has_stems {
                reasons.push("stems_ready".into());
            }
            Ranked {
                id: t.id.clone(),
                score,
                key: k,
                tempo: tp,
                energy: e,
                reasons,
                tempo_ratio: ratio,
                key_shift: shift.map(|s| s.semitones),
                key_after: shift.map(|s| s.key.label()),
            }
        })
        .collect();
    if extras.key_shift {
        cap_proposals_below_fits(&mut out);
    }
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    out.truncate(opts.limit);
    out
}

/// The owner's rule (WP19-61): a row with a key-shift proposal never ranks above a row that
/// fits as it is. The LOWEST-scoring row whose key term is at the fit level ([`KEY_FITS_FROM`])
/// sets the cap on every proposal row that scores at or above it: the best of them gets the
/// score one float step below that row's, the next one a step below that, and so on, so the
/// proposal rows keep the order they have among themselves (score, then id), also against a
/// proposal row that scored a hair under the cap by itself. Rows without a proposal are not
/// touched. No fit row: nothing is capped.
fn cap_proposals_below_fits(rows: &mut [Ranked]) {
    let lowest_fit = rows
        .iter()
        .filter(|r| r.key_shift.is_none() && r.key >= KEY_FITS_FROM)
        .map(|r| r.score)
        .reduce(f64::min);
    let Some(low) = lowest_fit else {
        return;
    };
    // Every proposal row, best first (the order the final sort would give them).
    let mut proposals: Vec<usize> = (0..rows.len())
        .filter(|&i| rows[i].key_shift.is_some())
        .collect();
    proposals.sort_by(|&a, &b| {
        rows[b]
            .score
            .total_cmp(&rows[a].score)
            .then_with(|| rows[a].id.cmp(&rows[b].id))
    });
    // `ceiling` = the score the next proposal row must stay below.
    let mut ceiling = low;
    for i in proposals {
        if rows[i].score < ceiling {
            // This one and every later one (they score lower still) are below already.
            break;
        }
        ceiling = ceiling.next_down();
        rows[i].score = ceiling;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str, bpm: f64, key: &str, energy: u8) -> TrackFeatures {
        TrackFeatures {
            id: id.into(),
            title: id.into(),
            artist: format!("artist-{id}"),
            bpm: Some(bpm),
            key: Some(key.into()),
            energy: Some(energy),
            duration_sec: 300.0,
            ..Default::default()
        }
    }

    fn c(track: TrackFeatures) -> Candidate {
        Candidate {
            track,
            played_minutes_ago: None,
        }
    }

    #[test]
    fn tempo_score_handles_half_double_and_unknown() {
        let (s, r) = tempo_score(Some(128.0), Some(128.0), 6.0, true);
        assert_eq!(s, 1.0);
        assert_eq!(r, Some(1.0));
        let (s, _) = tempo_score(Some(174.0), Some(87.0), 6.0, true);
        assert_eq!(s, 1.0, "double time");
        let (s, _) = tempo_score(Some(174.0), Some(87.0), 6.0, false);
        assert!(s < 0.1);
        let (s, r) = tempo_score(None, Some(120.0), 6.0, true);
        assert_eq!((s, r), (0.4, None));
        let (near, _) = tempo_score(Some(124.0), Some(126.0), 6.0, true);
        let (far, _) = tempo_score(Some(124.0), Some(132.0), 6.0, true);
        assert!(near > far);
    }

    #[test]
    fn harmonic_tempo_matched_energy_matched_wins() {
        let playing = t("now", 124.0, "8A", 6);
        let list = vec![
            c(t("clash", 124.0, "2B", 6)),
            c(t("perfect", 124.0, "9A", 6)),
            c(t("fast", 140.0, "8A", 6)),
            c(t("relative", 125.0, "8B", 7)),
        ];
        let r = rank_next(&playing, &list, &RankOptions::default());
        assert_eq!(r[0].id, "perfect");
        assert_eq!(r.last().unwrap().id, "clash");
        assert!(r[0].reasons.contains(&"key_adjacent".to_string()));
        assert!(
            r.iter()
                .find(|x| x.id == "fast")
                .unwrap()
                .reasons
                .contains(&"tempo_far".to_string())
        );
    }

    #[test]
    fn energy_direction_changes_the_order() {
        let playing = t("now", 124.0, "8A", 5);
        let list = vec![c(t("up", 124.0, "8A", 7)), c(t("down", 124.0, "8A", 3))];
        let up = rank_next(
            &playing,
            &list,
            &RankOptions {
                energy: EnergyDirection::Up,
                ..Default::default()
            },
        );
        assert_eq!(up[0].id, "up");
        let down = rank_next(
            &playing,
            &list,
            &RankOptions {
                energy: EnergyDirection::Down,
                ..Default::default()
            },
        );
        assert_eq!(down[0].id, "down");
    }

    #[test]
    fn a_key_that_is_not_camelot_ranks_as_unknown_without_panicking() {
        // What ID3 TKEY and other tools write: this crate is also called without the desktop
        // shell's filter (decks-ffi hands the key over as it came).
        let long = "♭".repeat(200);
        let hostile = ["A♭", "8Ａ", "Am♭", "♭", "8♭", "", "   ", "é", long.as_str()];
        let list: Vec<Candidate> = hostile
            .iter()
            .enumerate()
            .map(|(i, k)| c(t(&format!("h{i}"), 124.0, k, 6)))
            .collect();
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let r = rank_next(&t("now", 124.0, "8A", 6), &list, &opts);
        assert_eq!(r.len(), hostile.len());
        let tag = |id: &str| r.iter().find(|x| x.id == id).unwrap().reasons[0].clone();
        assert_eq!(tag("h0"), "key_unknown");
        assert_eq!(tag("h1"), "key_same", "full-width 8A");
        assert_eq!(tag("h3"), "key_unknown");
        for k in hostile {
            let r = rank_next(&t("now", 124.0, k, 6), &list, &opts);
            assert_eq!(r.len(), hostile.len(), "{k:?}");
        }
    }

    #[test]
    fn penalties_and_self_exclusion() {
        let playing = t("now", 124.0, "8A", 6);
        let mut same_artist = t("sa", 124.0, "8A", 6);
        same_artist.artist = "ARTIST-NOW".into();
        let list = vec![
            c(playing.clone()),
            Candidate {
                track: t("recent", 124.0, "8A", 6),
                played_minutes_ago: Some(5.0),
            },
            c(same_artist),
            c(t("fresh", 124.0, "8A", 6)),
        ];
        let r = rank_next(&playing, &list, &RankOptions::default());
        assert_eq!(r.len(), 3, "the playing track is not suggested");
        assert_eq!(r[0].id, "fresh");
        assert!(
            r.iter()
                .find(|x| x.id == "recent")
                .unwrap()
                .reasons
                .contains(&"recently_played".to_string())
        );
        assert!(
            r.iter()
                .find(|x| x.id == "sa")
                .unwrap()
                .reasons
                .contains(&"same_artist".to_string())
        );
    }

    #[test]
    fn ranking_is_deterministic_on_ties() {
        let playing = t("now", 124.0, "8A", 6);
        let list = vec![c(t("b", 124.0, "8A", 6)), c(t("a", 124.0, "8A", 6))];
        let r = rank_next(&playing, &list, &RankOptions::default());
        assert_eq!(r[0].id, "a");
    }

    /// Every key relation, shiftable and hopeless clashes, unknown keys, penalties, tempo
    /// far and close, a played track, the playing track itself.
    fn mixed() -> (TrackFeatures, Vec<Candidate>) {
        let playing = t("now", 124.0, "8A", 6);
        let mut same_artist = t("sa", 124.0, "2A", 6);
        same_artist.artist = playing.artist.clone();
        let mut no_key = t("nokey", 126.0, "8A", 5);
        no_key.key = None;
        let mut stems = t("stems", 124.0, "1B", 6);
        stems.has_stems = true;
        let list = vec![
            c(playing.clone()),
            c(t("same", 124.0, "8A", 6)),
            c(t("relative", 125.0, "8B", 7)),
            c(t("adjacent", 124.0, "9A", 6)),
            c(t("boost", 124.0, "10A", 6)),
            c(t("diagonal", 124.0, "9B", 6)),
            c(t("one-up", 124.0, "1A", 6)),
            c(t("one-down", 124.0, "3A", 6)),
            c(t("two-up", 124.0, "5A", 6)),
            c(t("two-down", 124.0, "11A", 6)),
            c(t("hopeless", 124.0, "2B", 6)),
            c(t("hopeless-far", 140.0, "12B", 3)),
            c(t("not-camelot", 124.0, "A♭", 6)),
            c(no_key),
            c(same_artist),
            c(stems),
            Candidate {
                track: t("recent", 124.0, "4A", 6),
                played_minutes_ago: Some(12.0),
            },
        ];
        (playing, list)
    }

    const ON: RankExtras = RankExtras { key_shift: true };

    #[test]
    fn with_every_extra_off_the_ranking_is_the_plain_one() {
        let (playing, list) = mixed();
        assert_eq!(RankExtras::default(), RankExtras { key_shift: false });
        for energy in [
            EnergyDirection::Hold,
            EnergyDirection::Up,
            EnergyDirection::Down,
        ] {
            for limit in [1, 3, 8, 50] {
                let opts = RankOptions {
                    energy,
                    limit,
                    ..Default::default()
                };
                let plain = rank_next(&playing, &list, &opts);
                let off = rank_next_with(&playing, &list, &opts, RankExtras::default());
                assert_eq!(plain, off, "{energy:?} limit {limit}");
                // The plain ranking never proposes anything and keeps its tags.
                assert!(plain.iter().all(|r| r.key_shift.is_none()));
                assert!(plain.iter().all(|r| r.key_after.is_none()));
                assert!(
                    plain
                        .iter()
                        .all(|r| !r.reasons.iter().any(|x| x == KEY_SHIFTABLE))
                );
                // And its JSON has no new field: what a caller of `rank_next` serialises is
                // what it serialised before the proposal existed.
                let json = serde_json::to_string(&plain).unwrap();
                assert!(!json.contains("key_shift") && !json.contains("key_after"));
            }
        }
        // The fixture can tell the two apart: with the extra on the answer differs.
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        assert_ne!(
            rank_next(&playing, &list, &opts),
            rank_next_with(&playing, &list, &opts, ON)
        );
    }

    #[test]
    fn a_clash_that_a_key_shift_fixes_is_proposed_and_ranked_between_clash_and_adjacent() {
        let (playing, list) = mixed();
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let plain = rank_next(&playing, &list, &opts);
        let on = rank_next_with(&playing, &list, &opts, ON);
        assert_eq!(plain.len(), on.len());
        let of = |list: &[Ranked], id: &str| list.iter().find(|x| x.id == id).unwrap().clone();
        // (id, shift, key after, key term)
        for (id, shift, after, term) in [
            ("one-up", 1i8, "8A", KEY_SHIFT_ONE),
            ("one-down", -1, "8A", KEY_SHIFT_ONE),
            ("two-up", 2, "7A", KEY_SHIFT_TWO),
            ("two-down", -2, "9A", KEY_SHIFT_TWO),
            ("sa", 1, "9A", KEY_SHIFT_ONE),
            ("stems", 1, "8B", KEY_SHIFT_ONE),
            ("recent", -1, "9A", KEY_SHIFT_ONE),
        ] {
            let (was, now) = (of(&plain, id), of(&on, id));
            assert_eq!(was.reasons[0], "key_clash", "{id}");
            assert_eq!(now.key_shift, Some(shift), "{id}");
            assert_eq!(now.key_after.as_deref(), Some(after), "{id}");
            assert_eq!(now.key, term, "{id}");
            assert_eq!(now.reasons[0], KEY_SHIFTABLE, "{id}: the first reason");
            assert!(!now.reasons.iter().any(|x| x == "key_clash"), "{id}");
            // Strictly between what it scored as a clash and an adjacent key.
            assert!(
                was.key < now.key && now.key < 0.85,
                "{id}: {} -> {}",
                was.key,
                now.key
            );
            // Only the key term moved: 0.4 of the difference, the rest of the row as it was.
            assert!(
                (now.score - was.score - 0.4 * (now.key - was.key)).abs() < 1e-12,
                "{id}"
            );
            assert_eq!(now.reasons[1..], was.reasons[1..], "{id}");
            assert_eq!(
                (now.tempo, now.energy, now.tempo_ratio),
                (was.tempo, was.energy, was.tempo_ratio)
            );
        }
        // Everything else is exactly the plain row: fits, boost, diagonal, unknown keys and
        // the clashes no shift within two semitones fixes.
        for id in [
            "same",
            "relative",
            "adjacent",
            "boost",
            "diagonal",
            "hopeless",
            "hopeless-far",
            "not-camelot",
            "nokey",
        ] {
            assert_eq!(of(&plain, id), of(&on, id), "{id}");
            assert_eq!(of(&on, id).key_shift, None, "{id}");
        }
        assert_eq!(of(&on, "hopeless").reasons[0], "key_clash");
        // The tag is one the UI contract test finds: one lower-case word after `key_`.
        assert!(
            KEY_SHIFTABLE
                .strip_prefix("key_")
                .is_some_and(|w| w.bytes().all(|b| b.is_ascii_lowercase()))
        );
    }

    #[test]
    fn the_two_shift_values_sit_where_the_comment_says() {
        let natural = |to: &str| key_score(Some("8A"), Some(to));
        let (adjacent, boost, diagonal) = (natural("9A").0, natural("10A").0, natural("9B").0);
        let unknown = key_score(None, Some("9A")).0;
        // The worst clash a proposal can come from is still below both values.
        let worst_clash = [
            "11A", "12A", "1A", "2A", "3A", "4A", "5A", "1B", "3B", "6B", "10B",
        ]
        .iter()
        .map(|k| natural(k).0)
        .fold(0.0, f64::max);
        assert_eq!(natural("9A").1, "key_adjacent");
        assert_eq!(natural("10A").1, "key_boost");
        assert_eq!(natural("9B").1, "key_diagonal");
        assert!(
            adjacent > KEY_SHIFT_ONE,
            "a pair that fits by itself comes first"
        );
        assert!(KEY_SHIFT_ONE > boost, "one semitone above the energy boost");
        assert!(
            boost > KEY_SHIFT_TWO,
            "two semitones below the energy boost"
        );
        assert!(KEY_SHIFT_TWO > diagonal && KEY_SHIFT_TWO > unknown);
        assert!(diagonal > worst_clash && worst_clash < crate::camelot::KEY_CLASH_BELOW);

        // In a ranking, everything else equal: adjacent, one semitone, boost, two semitones,
        // diagonal, hopeless (so the smaller shift ranks above the larger one).
        let playing = t("now", 124.0, "8A", 6);
        let list: Vec<Candidate> = [
            ("hopeless", "2B"),
            ("two", "5A"),
            ("diagonal", "9B"),
            ("one", "1A"),
            ("boost", "10A"),
            ("adjacent", "9A"),
        ]
        .iter()
        .map(|(id, key)| c(t(id, 124.0, key, 6)))
        .collect();
        let order = |extras| -> Vec<String> {
            rank_next_with(&playing, &list, &RankOptions::default(), extras)
                .into_iter()
                .map(|r| r.id)
                .collect()
        };
        assert_eq!(
            order(ON),
            ["adjacent", "one", "boost", "two", "diagonal", "hopeless"]
        );
        // Without the proposal the two shiftable tracks are plain clashes at the bottom.
        assert_eq!(
            order(RankExtras::default())[..3],
            ["adjacent", "boost", "diagonal"]
        );
    }

    fn ids(list: &[Ranked]) -> Vec<&str> {
        list.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn a_proposal_never_ranks_above_a_track_that_fits_as_it_is() {
        // The reviewer's counter-example: nine adjacent-key tracks 3 BPM off (key 0.85, tempo
        // 0.803: score 0.871) and one clash dead on tempo that one semitone fixes (key 0.7,
        // tempo 1.0: score 0.88 by the terms alone). The proposal comes after all nine.
        let playing = t("now", 124.0, "8A", 6);
        let mut list: Vec<Candidate> = (0..9)
            .map(|i| c(t(&format!("fit{i}"), 127.0, "9A", 6)))
            .collect();
        list.push(c(t("shift", 124.0, "1A", 6)));
        let all = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let on = rank_next_with(&playing, &list, &all, ON);
        assert_eq!(on.len(), 10);
        assert_eq!(on[9].id, "shift", "{:?}", ids(&on));
        assert_eq!(on[9].key_shift, Some(1));
        let lowest_fit = on[8].score;
        assert!(
            on[9].score < lowest_fit,
            "the reported score is the capped one"
        );
        assert!(
            lowest_fit - on[9].score < 1e-12,
            "capped to just under the lowest fit"
        );
        // Not by the terms: 0.4 * 0.7 + 0.35 + 0.25 would be 0.88, above the fits.
        assert!(0.4 * KEY_SHIFT_ONE + 0.35 + 0.25 > lowest_fit);
        // The cap is applied before the cut: with limit 8 the proposal is not in the list.
        let eight = RankOptions {
            limit: 8,
            ..Default::default()
        };
        let top8 = rank_next_with(&playing, &list, &eight, ON);
        assert_eq!(top8.len(), 8);
        assert!(top8.iter().all(|r| r.id != "shift"), "{:?}", ids(&top8));
        // Eight fits and limit 9: it is last.
        let mut eight_fits = list.clone();
        eight_fits.remove(8);
        let nine = RankOptions {
            limit: 9,
            ..Default::default()
        };
        let r = rank_next_with(&playing, &eight_fits, &nine, ON);
        assert_eq!(r.len(), 9);
        assert_eq!(r[8].id, "shift", "{:?}", ids(&r));
        // The cap is the LOWEST fit, not the highest: with one fit dead on tempo (0.94) among
        // them the proposal still comes after the eight at 127 BPM.
        let mut mixed_fits = list.clone();
        mixed_fits[0] = c(t("fit0", 124.0, "9A", 6));
        let r = rank_next_with(&playing, &mixed_fits, &all, ON);
        assert_eq!(r[0].id, "fit0");
        assert_eq!(r[9].id, "shift", "{:?}", ids(&r));
        // Without the option the clash is a plain clash at the bottom, as before.
        let plain = rank_next(&playing, &list, &all);
        assert_eq!(plain[9].id, "shift");
        assert_eq!(plain[9].reasons[0], "key_clash");
        assert!(
            (plain[9].score - 0.6).abs() < 1e-12,
            "0.4 * 0 + 0.35 + 0.25"
        );
    }

    /// Fits with different tempos, a boost, a diagonal, an unknown key, two proposals that
    /// would pass the far fit by their terms, a proposal that would not, a hopeless clash.
    fn capping_fixture() -> (TrackFeatures, Vec<Candidate>) {
        let playing = t("now", 124.0, "8A", 6);
        let mut no_key = t("nokey", 126.0, "8A", 6);
        no_key.key = None;
        let list = vec![
            c(t("fit-close", 124.0, "9A", 6)),
            c(t("fit-far", 131.0, "9A", 6)),
            c(t("boost", 124.0, "10A", 6)),
            c(t("diagonal", 124.0, "9B", 6)),
            c(no_key),
            c(t("one-up", 124.0, "1A", 6)),
            c(t("two-up", 124.0, "5A", 6)),
            c(t("one-far", 140.0, "1A", 6)),
            c(t("hopeless", 124.0, "2B", 6)),
        ];
        (playing, list)
    }

    #[test]
    fn the_cap_moves_proposal_rows_only_and_keeps_every_other_row_in_its_plain_order() {
        let (playing, list) = capping_fixture();
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let plain = rank_next(&playing, &list, &opts);
        let on = rank_next_with(&playing, &list, &opts, ON);
        let of = |list: &[Ranked], id: &str| list.iter().find(|x| x.id == id).unwrap().clone();
        // The far fit (0.784) is the lowest fit: it caps the two proposals that would score
        // above it (0.88, 0.82); the capped rows keep their own order, one float step apart.
        assert_eq!(
            ids(&on),
            [
                "fit-close",
                "boost",
                "diagonal",
                "fit-far",
                "one-up",
                "two-up",
                "nokey",
                "hopeless",
                "one-far",
            ]
        );
        let low = of(&on, "fit-far").score;
        let (one, two) = (of(&on, "one-up").score, of(&on, "two-up").score);
        assert!(two < one && one < low, "{two} < {one} < {low}");
        assert!(low - two < 1e-12, "both sit just under the lowest fit");
        // The score a row reports is the score it was sorted by.
        assert!(on.windows(2).all(|w| w[0].score >= w[1].score));
        // A proposal already below the lowest fit keeps its own score (only the key term moved).
        let far = of(&on, "one-far");
        assert_eq!(far.key_shift, Some(1));
        assert!(
            (far.score - of(&plain, "one-far").score - 0.4 * (far.key - of(&plain, "one-far").key))
                .abs()
                < 1e-12
        );
        // Rows without a proposal: the same rows, the same scores, in the plain order.
        let natural_ids: Vec<String> = on
            .iter()
            .filter(|r| r.key_shift.is_none())
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(natural_ids.len(), 6);
        let rows = |list: &[Ranked]| -> Vec<(String, f64)> {
            list.iter()
                .filter(|r| natural_ids.contains(&r.id))
                .map(|r| (r.id.clone(), r.score))
                .collect()
        };
        assert_eq!(rows(&plain), rows(&on));
        // Everything else of a capped row is as scored: key term, tempo, energy, reasons.
        let one = of(&on, "one-up");
        assert_eq!((one.key, one.tempo, one.energy), (KEY_SHIFT_ONE, 1.0, 1.0));
        assert_eq!(one.reasons[0], KEY_SHIFTABLE);
    }

    #[test]
    fn without_a_fit_row_nothing_is_capped_and_a_proposal_may_pass_a_boost_or_a_diagonal() {
        let (playing, list) = capping_fixture();
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        // No fit row in the list: the terms decide; one semitone (0.88) stands above the boost
        // (0.84), the diagonal (0.80) and the unknown key, two semitones (0.82) above the
        // diagonal: on purpose (see KEY_SHIFT_ONE / KEY_SHIFT_TWO).
        let no_fits: Vec<Candidate> = list
            .iter()
            .filter(|c| !c.track.id.starts_with("fit"))
            .cloned()
            .collect();
        let on = rank_next_with(&playing, &no_fits, &opts, ON);
        assert_eq!(
            ids(&on),
            [
                "one-up", "boost", "two-up", "diagonal", "nokey", "hopeless", "one-far",
            ]
        );
        let of = |id: &str| on.iter().find(|x| x.id == id).unwrap().clone();
        assert!((of("one-up").score - 0.88).abs() < 1e-12, "uncapped");
        assert!((of("two-up").score - 0.82).abs() < 1e-12, "uncapped");
        // A fit that scores above every proposal (0.94) caps nothing either: the proposals
        // keep their scores and still stand above the boost and the diagonal.
        let with_close: Vec<Candidate> = list
            .iter()
            .filter(|c| c.track.id != "fit-far")
            .cloned()
            .collect();
        let on = rank_next_with(&playing, &with_close, &opts, ON);
        assert_eq!(
            ids(&on),
            [
                "fit-close",
                "one-up",
                "boost",
                "two-up",
                "diagonal",
                "nokey",
                "hopeless",
                "one-far",
            ]
        );
        assert!(
            (on[1].score - 0.88).abs() < 1e-12,
            "0.88 is below 0.94: not capped"
        );
    }

    #[test]
    fn capped_proposals_keep_their_own_order_and_ties_break_by_id() {
        let playing = t("now", 124.0, "8A", 6);
        // One fit far off in tempo (0.784) and four proposals that all score above it:
        // two equal one-semitone rows (0.88), one two-semitone row (0.82), one one-semitone
        // row a little off in tempo (0.834).
        let list = vec![
            c(t("fit", 131.0, "9A", 6)),
            c(t("b-one", 124.0, "1A", 6)),
            c(t("a-one", 124.0, "3A", 6)),
            c(t("two", 124.0, "5A", 6)),
            c(t("one-off", 126.0, "1A", 6)),
        ];
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let on = rank_next_with(&playing, &list, &opts, ON);
        // After the fit: by their own scores (0.88, 0.88, 0.834, 0.82), the tie by id.
        assert_eq!(ids(&on), ["fit", "a-one", "b-one", "one-off", "two"]);
        assert!(on.windows(2).all(|w| w[0].score > w[1].score));
        assert!(on[0].score - on[4].score < 1e-12);
        // The same four without a fit row: the same order among them, uncapped scores.
        let on = rank_next_with(&playing, &list[1..], &opts, ON);
        assert_eq!(ids(&on), ["a-one", "b-one", "one-off", "two"]);
        assert_eq!(on[0].score, on[1].score);
        assert!((on[0].score - 0.88).abs() < 1e-12);
    }

    #[test]
    fn a_proposal_that_scores_exactly_like_the_lowest_fit_is_capped_too() {
        // Built by hand: a tie between a fit and a proposal would be broken by id, and "a"
        // sorts before "fit". Equal is not below: the proposal must be capped.
        let row = |id: &str, score: f64, key: f64, shift: Option<i8>| Ranked {
            id: id.into(),
            score,
            key,
            tempo: 1.0,
            energy: 1.0,
            reasons: Vec::new(),
            tempo_ratio: Some(1.0),
            key_shift: shift,
            key_after: shift.map(|_| "8A".to_string()),
        };
        let mut rows = vec![
            row("a", 0.5, KEY_SHIFT_ONE, Some(1)),
            row("fit", 0.5, 0.85, None),
            row("fit-high", 0.9, 1.0, None),
            row("boost", 0.5, 0.6, None),
            row("below", 0.4, KEY_SHIFT_TWO, Some(2)),
        ];
        cap_proposals_below_fits(&mut rows);
        let score = |id: &str| rows.iter().find(|r| r.id == id).unwrap().score;
        assert!(score("a") < 0.5, "equal to the lowest fit is not below it");
        assert_eq!(score("a"), 0.5f64.next_down());
        // Nothing else moved: the fits, a boost that ties with the fit, a proposal already below.
        assert_eq!(
            (
                score("fit"),
                score("fit-high"),
                score("boost"),
                score("below")
            ),
            (0.5, 0.9, 0.5, 0.4)
        );
        // A fit is a row WITHOUT a proposal at the fit level: a proposal row never sets the cap
        // (its key term is 0.7 / 0.55 anyway), and a boost row (0.6) does not either.
        let mut no_fit = vec![
            row("p", 0.9, KEY_SHIFT_ONE, Some(1)),
            row("boost", 0.5, 0.6, None),
        ];
        cap_proposals_below_fits(&mut no_fit);
        assert_eq!(no_fit[0].score, 0.9, "no fit row: nothing is capped");
        // The fit level itself counts (adjacent = 0.85 exactly).
        let mut at_level = vec![
            row("p", 0.9, KEY_SHIFT_ONE, Some(1)),
            row("adjacent", 0.5, KEY_FITS_FROM, None),
        ];
        cap_proposals_below_fits(&mut at_level);
        assert!(at_level[0].score < 0.5);
    }

    /// The ranking as it was before key-shift proposals existed (WP19-20), kept here word for
    /// word as the reference `rank_next` must keep matching: the native apps rank through it.
    fn rank_before_proposals(
        playing: &TrackFeatures,
        candidates: &[Candidate],
        opts: &RankOptions,
    ) -> Vec<Ranked> {
        let mut out: Vec<Ranked> = candidates
            .iter()
            .filter(|c| c.track.id != playing.id)
            .map(|c| {
                let t = &c.track;
                let (k, ktag) = key_score(playing.key.as_deref(), t.key.as_deref());
                let (tp, ratio) = tempo_score(
                    playing.bpm,
                    t.bpm,
                    opts.max_tempo_change_pct,
                    opts.allow_half_double,
                );
                let (e, etag) = energy_score(playing.energy, t.energy, opts.energy);
                let mut score = 0.4 * k + 0.35 * tp + 0.25 * e;
                let mut reasons = vec![ktag.to_string(), etag.to_string()];
                if tp >= 0.75 {
                    reasons.push("tempo_close".into());
                } else if tp < 0.4 {
                    reasons.push("tempo_far".into());
                }
                if let Some(m) = c.played_minutes_ago {
                    let p = (0.5 * (1.0 - m / 60.0)).clamp(0.0, 0.5);
                    if p > 0.0 {
                        score -= p;
                        reasons.push("recently_played".into());
                    }
                }
                if opts.avoid_same_artist
                    && !t.artist.is_empty()
                    && t.artist.eq_ignore_ascii_case(&playing.artist)
                {
                    score -= 0.15;
                    reasons.push("same_artist".into());
                }
                if t.has_stems {
                    reasons.push("stems_ready".into());
                }
                Ranked {
                    id: t.id.clone(),
                    score,
                    key: k,
                    tempo: tp,
                    energy: e,
                    reasons,
                    tempo_ratio: ratio,
                    key_shift: None,
                    key_after: None,
                }
            })
            .collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
        out.truncate(opts.limit);
        out
    }

    #[test]
    fn the_plain_ranking_is_exactly_the_ranking_from_before_proposals() {
        // Fixtures where the cap WOULD move rows if it ran: fits that score below clashes
        // (a fit far off in tempo, a played fit), proposals, boost, diagonal, unknown keys.
        let (playing, mut list) = mixed();
        list.push(c(t("fit-far", 131.0, "9A", 6)));
        list.push(c(t("one-far", 140.0, "1A", 6)));
        list.push(Candidate {
            track: t("fit-played", 124.0, "9A", 6),
            played_minutes_ago: Some(1.0),
        });
        list.push(c(t("fit-slow", 150.0, "8B", 2)));
        for energy in [
            EnergyDirection::Hold,
            EnergyDirection::Up,
            EnergyDirection::Down,
        ] {
            for limit in [1, 3, 8, 12, 50] {
                let opts = RankOptions {
                    energy,
                    limit,
                    ..Default::default()
                };
                let want = rank_before_proposals(&playing, &list, &opts);
                let got = rank_next(&playing, &list, &opts);
                assert_eq!(got, want, "{energy:?} limit {limit}");
                // Bit for bit, not only `==` on floats.
                for (g, w) in got.iter().zip(&want) {
                    assert_eq!(g.score.to_bits(), w.score.to_bits(), "{}", g.id);
                }
            }
        }
        // The fixture can tell: in it a clash a shift fixes scores above a fit, so the cap,
        // had it run on the plain ranking, would have had something to move.
        let opts = RankOptions {
            limit: 50,
            ..Default::default()
        };
        let plain = rank_next(&playing, &list, &opts);
        let at = |id: &str| plain.iter().position(|r| r.id == id).unwrap();
        assert!(at("one-up") < at("fit-played"), "a clash above a fit");
        assert!(at("one-up") < at("fit-slow"));
        let on = rank_next_with(&playing, &list, &opts, ON);
        let at = |id: &str| on.iter().position(|r| r.id == id).unwrap();
        for fit in [
            "fit-played",
            "fit-slow",
            "fit-far",
            "same",
            "relative",
            "adjacent",
        ] {
            for shifted in [
                "one-up", "one-down", "two-up", "two-down", "stems", "sa", "recent", "one-far",
            ] {
                assert!(at(fit) < at(shifted), "{fit} must stand above {shifted}");
            }
        }
    }

    #[test]
    fn the_reference_key_is_the_one_the_caller_gives() {
        // The desktop passes the key the room hears: deck on 8A shifted +1 sounds 3A.
        let list = vec![c(t("x", 124.0, "3A", 6)), c(t("y", 124.0, "9A", 6))];
        let opts = RankOptions::default();
        let plain_ref = rank_next_with(&t("now", 124.0, "8A", 6), &list, &opts, ON);
        let x = plain_ref.iter().find(|r| r.id == "x").unwrap();
        assert_eq!(
            (x.key_shift, x.key_after.as_deref()),
            (Some(-1), Some("8A"))
        );
        let shifted_ref = rank_next_with(&t("now", 124.0, "3A", 6), &list, &opts, ON);
        let x = shifted_ref.iter().find(|r| r.id == "x").unwrap();
        assert_eq!((x.key_shift, x.reasons[0].as_str()), (None, "key_same"));
        // 9A against 3A: six steps apart, +1 (4A) or -1 (2A) are adjacent to 3A: +1 wins.
        let y = shifted_ref.iter().find(|r| r.id == "y").unwrap();
        assert_eq!((y.key_shift, y.key_after.as_deref()), (Some(1), Some("4A")));
    }
}
