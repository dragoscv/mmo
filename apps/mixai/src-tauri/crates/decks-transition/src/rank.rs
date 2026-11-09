//! Next-track ranking.

use serde::{Deserialize, Serialize};

use crate::TrackFeatures;
use crate::camelot::key_score;

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
            }
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
    out.truncate(opts.limit);
    out
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
}
