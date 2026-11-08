//! Key estimation from accumulated chroma: correlation against 24 rotated EDM key profiles (Faraldo et al.
//! 2016) plus a minor-mode bias tuned on GiantSteps-MTG (the dev set; the GiantSteps key test set is never used
//! for tuning), a long-term profile for the locked key and a short-term one for key-change alerts. A trained
//! CNN (WP18-16) replaces the final decision once it passes the GiantSteps gate; this classic path stays as the
//! instant first guess and the watch engine.

use crate::notation::Key;

/// EDM corpus profiles (Faraldo, Gómez, Jordà, Herrera, "Key Estimation in Electronic Dance Music", ECIR 2016).
/// Values from the paper's published table; electronic music is mostly minor and these profiles reflect it.
const EDMA_MAJOR: [f64; 12] = [1.00, 0.29, 0.50, 0.40, 0.60, 0.56, 0.32, 0.80, 0.31, 0.45, 0.42, 0.39];
const EDMA_MINOR: [f64; 12] = [1.00, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32];
/// Added to every minor correlation. Swept on GiantSteps-MTG (1077 confident tracks): 0 → 0.558,
/// 0.04 → 0.600, 0.09 → 0.625, 0.12 → 0.626 weighted.
const MINOR_BIAS: f64 = 0.09;

fn normalise(p: [f64; 12]) -> [f64; 12] {
    let mean = p.iter().sum::<f64>() / 12.0;
    let mut out = p.map(|x| x - mean);
    let norm = out.iter().map(|x| x * x).sum::<f64>().sqrt();
    out.iter_mut().for_each(|x| *x /= norm);
    out
}

/// Correlation of `chroma` with every key (index = `Key::index`).
pub fn key_correlations(chroma: &[f32; 12]) -> [f64; 24] {
    let major = normalise(EDMA_MAJOR);
    let minor = normalise(EDMA_MINOR);
    let mean = chroma.iter().map(|&x| x as f64).sum::<f64>() / 12.0;
    let c: [f64; 12] = std::array::from_fn(|i| chroma[i] as f64 - mean);
    let norm = c.iter().map(|x| x * x).sum::<f64>().sqrt();
    let mut out = [0.0; 24];
    if norm < 1e-12 {
        return out;
    }
    for (k, o) in out.iter_mut().enumerate() {
        let profile = if k < 12 { &major } else { &minor };
        let tonic = k % 12;
        *o = (0..12).map(|i| c[(i + tonic) % 12] * profile[i]).sum::<f64>() / norm;
    }
    for o in &mut out[12..] {
        *o += MINOR_BIAS;
    }
    out
}

/// One key reading.
#[derive(Debug, Clone, PartialEq)]
pub struct KeyEstimate {
    pub key: Key,
    /// 0..1.
    pub confidence: f64,
    /// Runner-up (often the relative or a fifth away), for the "or" hint in the UI.
    pub alternative: Key,
    pub locked: bool,
    /// Correlation per key (index = `Key::index`), for the Camelot wheel heat map.
    pub scores: [f64; 24],
}

fn best_two(scores: &[f64; 24]) -> (usize, usize) {
    let mut idx: Vec<usize> = (0..24).collect();
    idx.sort_by(|a, b| scores[*b].total_cmp(&scores[*a]));
    (idx[0], idx[1])
}

fn confidence(scores: &[f64; 24]) -> f64 {
    let (a, b) = best_two(scores);
    let margin = ((scores[a] - scores[b]) / 0.12).clamp(0.0, 1.0);
    let fit = ((scores[a] - 0.3) / 0.5).clamp(0.0, 1.0);
    (0.55 * margin + 0.45 * fit).clamp(0.0, 1.0)
}

pub(crate) struct KeyTracker {
    long: [f64; 12],
    short: [f64; 12],
    frames: u32,
    streak_key: Option<usize>,
    streak: u32,
    locked: Option<usize>,
    change_streak: u32,
    changed: bool,
    /// Short-term EMA coefficient (≈ 8 s at 10 frames/s).
    short_alpha: f64,
}

impl KeyTracker {
    pub fn new(frames_per_sec: f64) -> Self {
        Self {
            long: [0.0; 12],
            short: [0.0; 12],
            frames: 0,
            streak_key: None,
            streak: 0,
            locked: None,
            change_streak: 0,
            changed: false,
            short_alpha: 1.0 / (8.0 * frames_per_sec),
        }
    }

    pub fn push(&mut self, chroma: &[f32; 12], energy: f32) {
        if energy <= 0.0 {
            return;
        }
        self.frames += 1;
        for i in 0..12 {
            self.long[i] = self.long[i] * 0.999 + chroma[i] as f64;
            self.short[i] += (chroma[i] as f64 - self.short[i]) * self.short_alpha.max(1.0 / self.frames as f64);
        }
        let scores = key_correlations(&self.long.map(|x| x as f32));
        let (best, _) = best_two(&scores);
        let conf = confidence(&scores);
        if Some(best) == self.streak_key && conf >= 0.35 {
            self.streak += 1;
        } else {
            self.streak_key = Some(best);
            self.streak = u32::from(conf >= 0.35);
        }
        // ~8 s of agreement locks (D69 UX: provisional at 3-5 s, locked at 8-12 s).
        if self.locked.is_none() && self.streak >= 50 {
            self.locked = Some(best);
        }
        if let Some(locked) = self.locked {
            let short_scores = key_correlations(&self.short.map(|x| x as f32));
            let (sb, _) = best_two(&short_scores);
            let related = crate::harmonic::key_score(Key::from_index(locked), Key::from_index(sb)) >= 0.9;
            if sb != locked && !related && confidence(&short_scores) >= 0.45 {
                self.change_streak += 1;
            } else {
                self.change_streak = 0;
            }
            if self.change_streak >= 60 {
                // Key change: restart the long-term profile from the recent one.
                self.long = self.short.map(|x| x * 20.0);
                self.locked = Some(sb);
                self.streak_key = Some(sb);
                self.streak = 0;
                self.change_streak = 0;
                self.changed = true;
            }
        }
    }

    /// True once after a detected modulation (for the key-change alert).
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    pub fn snapshot(&self) -> Option<KeyEstimate> {
        // Provisional only after ~3 s of pitched audio.
        if self.frames < 30 {
            return None;
        }
        let scores = key_correlations(&self.long.map(|x| x as f32));
        let (a, b) = best_two(&scores);
        let key = self.locked.unwrap_or(a);
        let alternative = if key == a { b } else { a };
        Some(KeyEstimate {
            key: Key::from_index(key),
            confidence: confidence(&scores),
            alternative: Key::from_index(alternative),
            locked: self.locked.is_some(),
            scores,
        })
    }

    pub fn reset(&mut self) {
        *self = Self { short_alpha: self.short_alpha, ..Self::new(1.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_pick_their_own_key_on_every_tonic() {
        for tonic in 0..12 {
            for (profile, is_minor) in [(EDMA_MAJOR, false), (EDMA_MINOR, true)] {
                let chroma: [f32; 12] = std::array::from_fn(|i| profile[(i + 12 - tonic) % 12] as f32 + 1.0);
                let scores = key_correlations(&chroma);
                let (best, _) = best_two(&scores);
                assert_eq!(Key::from_index(best), Key::new(tonic as u8, is_minor));
            }
        }
    }

    #[test]
    fn silence_has_no_correlation() {
        assert_eq!(key_correlations(&[0.0; 12]), [0.0; 24]);
        assert_eq!(key_correlations(&[0.5; 12]), [0.0; 24], "flat chroma has no key, not a minor bias");
    }
}
