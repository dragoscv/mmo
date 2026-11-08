//! Live chord recognition: 24 major/minor + 12 dominant-7th templates (plus "no chord") matched against chroma
//! by cosine similarity, smoothed online with an HMM forward pass (self-transition 0.9), so the strip does not
//! flicker on passing notes. A CRNN can replace the emission model later without changing the interface.

use crate::notation::PITCH_NAMES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChordQuality {
    Major,
    Minor,
    Dominant7,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Chord {
    pub root: u8,
    pub quality: ChordQuality,
}

impl Chord {
    /// `A`, `Am`, `A7`.
    pub fn label(self) -> String {
        let root = PITCH_NAMES[self.root as usize];
        match self.quality {
            ChordQuality::Major => root.to_string(),
            ChordQuality::Minor => format!("{root}m"),
            ChordQuality::Dominant7 => format!("{root}7"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChordEstimate {
    /// `None` = no chord (silence, drums only, noise).
    pub chord: Option<Chord>,
    /// Posterior probability of the shown state, 0..1.
    pub confidence: f64,
}

const STATES: usize = 37;
const SELF_P: f64 = 0.9;

fn template(state: usize) -> [f64; 12] {
    let mut t = [0.0; 12];
    if state == 36 {
        return [1.0; 12];
    }
    let root = state % 12;
    let ivs: &[usize] = match state / 12 {
        0 => &[0, 4, 7],
        1 => &[0, 3, 7],
        _ => &[0, 4, 7, 10],
    };
    for (n, iv) in ivs.iter().enumerate() {
        t[(root + iv) % 12] = if n == 0 { 1.2 } else { 1.0 };
    }
    t
}

fn state_chord(state: usize) -> Option<Chord> {
    let quality = match state / 12 {
        0 => ChordQuality::Major,
        1 => ChordQuality::Minor,
        2 => ChordQuality::Dominant7,
        _ => return None,
    };
    Some(Chord { root: (state % 12) as u8, quality })
}

pub(crate) struct ChordTracker {
    templates: Vec<[f64; 12]>,
    belief: [f64; STATES],
}

impl ChordTracker {
    pub fn new() -> Self {
        let templates = (0..STATES)
            .map(|s| {
                let t = template(s);
                let n = t.iter().map(|x| x * x).sum::<f64>().sqrt();
                t.map(|x| x / n)
            })
            .collect();
        Self { templates, belief: [1.0 / STATES as f64; STATES] }
    }

    pub fn push(&mut self, chroma: &[f32; 12], energy: f32) {
        let norm = chroma.iter().map(|&x| (x as f64).powi(2)).sum::<f64>().sqrt();
        let mut emit = [0.0f64; STATES];
        for (s, e) in emit.iter_mut().enumerate() {
            let sim = if norm > 1e-9 && energy > 0.0 {
                self.templates[s].iter().zip(chroma).map(|(t, &c)| t * c as f64).sum::<f64>() / norm
            } else if s == 36 {
                1.0
            } else {
                0.0
            };
            // Sharpen: similarity differences are small; exp(k·sim) acts like a softmax temperature. k = 6 keeps
            // one clean frame (sim gap ~0.7 → ×66) below the self-transition odds (0.9 / (0.1/36) ≈ ×324).
            *e = (6.0 * sim).exp();
        }
        // "No chord" sits slightly below a clean triad so flat/noisy chroma falls back to it.
        emit[36] *= 0.55;
        let switch = (1.0 - SELF_P) / (STATES - 1) as f64;
        let mut next = [0.0f64; STATES];
        let total: f64 = self.belief.iter().sum();
        for (s, n) in next.iter_mut().enumerate() {
            let prior = self.belief[s] * SELF_P + (total - self.belief[s]) * switch;
            *n = prior * emit[s];
        }
        let sum: f64 = next.iter().sum();
        if sum > 0.0 && sum.is_finite() {
            self.belief = next.map(|x| x / sum);
        }
    }

    pub fn snapshot(&self) -> ChordEstimate {
        let (s, p) = self.belief.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, p)| (i, *p)).unwrap();
        ChordEstimate { chord: state_chord(s), confidence: p }
    }

    pub fn reset(&mut self) {
        self.belief = [1.0 / STATES as f64; STATES];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chroma(notes: &[usize]) -> [f32; 12] {
        let mut c = [0.05f32; 12];
        for &n in notes {
            c[n % 12] = 1.0;
        }
        c
    }

    #[test]
    fn recognises_triads_and_sevenths() {
        let cases: [(&[usize], &str); 4] = [(&[9, 1, 4], "A"), (&[9, 0, 4], "Am"), (&[7, 11, 2, 5], "G7"), (&[2, 5, 9], "Dm")];
        for (notes, want) in cases {
            let mut t = ChordTracker::new();
            for _ in 0..20 {
                t.push(&chroma(notes), 1.0);
            }
            let s = t.snapshot();
            assert_eq!(s.chord.map(Chord::label).as_deref(), Some(want));
            assert!(s.confidence > 0.5, "{want}: {}", s.confidence);
        }
    }

    #[test]
    fn one_passing_frame_does_not_flip_the_chord() {
        let mut t = ChordTracker::new();
        for _ in 0..20 {
            t.push(&chroma(&[0, 4, 7]), 1.0);
        }
        t.push(&chroma(&[2, 5, 9]), 1.0);
        assert_eq!(t.snapshot().chord.map(Chord::label).as_deref(), Some("C"));
    }

    #[test]
    fn silence_is_no_chord() {
        let mut t = ChordTracker::new();
        for _ in 0..10 {
            t.push(&[0.0; 12], 0.0);
        }
        assert_eq!(t.snapshot().chord, None);
    }
}
