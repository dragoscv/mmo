//! # decks-setlog — automatic tracklist for a recorded set (WP19-22, ADR-0014)
//!
//! The app records the master to WAV (`DecksEngine.record_start`) and feeds a [`SetLogger`] the
//! deck state at UI rate. The logger decides which track the audience hears (playing × channel
//! fader × crossfader side) and starts a tracklist entry when a new track has been dominant for
//! `min_dominant_sec` (default 20 s), backdated to when it became dominant. Short previews never
//! make the list.
//!
//! Exports ([`export`]): numbered text tracklist, CUE sheet (`INDEX 01 mm:ss:ff`, 75 frames/s, with
//! `ISRC`), ORDA / UCMR-ADA broadcast report CSV (title, artist, ISRC, start, seconds played),
//! Mixcloud upload `sections-N-*` fields as JSON, and M3U8. Documentation: `docs/decks/set-recording.md`.

pub mod export;

use serde::{Deserialize, Serialize};

/// What the logger knows about a loaded track.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackRef {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub isrc: Option<String>,
    pub path: Option<String>,
}

/// One deck at one instant.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeckObs {
    pub deck: u8,
    pub playing: bool,
    /// Channel fader 0..1.
    pub volume: f32,
    pub track: Option<TrackRef>,
}

/// A tracklist entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub track: TrackRef,
    pub deck: u8,
    /// Seconds from the start of the recording when it became the dominant track.
    pub start_sec: f64,
    /// Seconds it was the dominant track (filled when the next entry starts / the set stops).
    pub played_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoggerConfig {
    /// A track must dominate this long to become an entry.
    pub min_dominant_sec: f64,
    /// Audible level below this counts as silent.
    pub audible_threshold: f32,
}

impl Default for LoggerConfig {
    fn default() -> Self {
        Self {
            min_dominant_sec: 20.0,
            audible_threshold: 0.05,
        }
    }
}

/// Crossfader weight of a deck: deck 0 is on the left (A), deck 1 on the right (B), decks 2–3 are
/// not assigned (thru). Linear, full in the middle (`−1` = A only, `1` = B only).
pub fn crossfader_weight(deck: u8, crossfader: f32) -> f32 {
    let x = crossfader.clamp(-1.0, 1.0);
    match deck {
        0 => (1.0 - x).min(1.0),
        1 => (1.0 + x).min(1.0),
        _ => 1.0,
    }
}

/// Builds the tracklist while the set is recorded.
#[derive(Debug, Clone)]
pub struct SetLogger {
    cfg: LoggerConfig,
    entries: Vec<Entry>,
    /// (track id, deck, since) of the current dominant streak.
    streak: Option<(String, u8, f64, TrackRef)>,
    last_t: f64,
    stopped: bool,
}

impl SetLogger {
    pub fn new(cfg: LoggerConfig) -> Self {
        Self {
            cfg,
            entries: Vec::new(),
            streak: None,
            last_t: 0.0,
            stopped: false,
        }
    }

    /// Feed the state at `t_sec` (seconds since the recording started, non-decreasing).
    pub fn observe(&mut self, t_sec: f64, decks: &[DeckObs], crossfader: f32) {
        if self.stopped || !t_sec.is_finite() || t_sec < self.last_t {
            return;
        }
        self.last_t = t_sec;
        let dominant = decks
            .iter()
            .filter_map(|d| {
                let t = d.track.as_ref()?;
                if !d.playing {
                    return None;
                }
                let level = d.volume.clamp(0.0, 1.0) * crossfader_weight(d.deck, crossfader);
                (level >= self.cfg.audible_threshold).then_some((level, d.deck, t))
            })
            .max_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)));
        let Some((_, deck, track)) = dominant else {
            self.streak = None;
            return;
        };
        let same = self
            .streak
            .as_ref()
            .is_some_and(|(id, d, _, _)| *id == track.id && *d == deck);
        if !same {
            self.streak = Some((track.id.clone(), deck, t_sec, track.clone()));
        }
        let (id, d, since, tr) = self.streak.clone().expect("set above");
        let current = self.entries.last().map(|e| (e.track.id.clone(), e.deck));
        if current.as_ref() != Some(&(id.clone(), d)) && t_sec - since >= self.cfg.min_dominant_sec
        {
            if let Some(prev) = self.entries.last_mut() {
                prev.played_sec = (since - prev.start_sec).max(0.0);
            }
            self.entries.push(Entry {
                track: tr,
                deck: d,
                start_sec: since,
                played_sec: 0.0,
            });
        }
    }

    /// End of the set: closes the last entry.
    pub fn stop(&mut self, t_sec: f64) {
        if self.stopped {
            return;
        }
        let end = t_sec.max(self.last_t);
        if let Some(prev) = self.entries.last_mut() {
            prev.played_sec = (end - prev.start_sec).max(0.0);
        }
        self.stopped = true;
    }

    /// Entries so far (the last one's `played_sec` is provisional until `stop`).
    pub fn entries(&self) -> Vec<Entry> {
        let mut v = self.entries.clone();
        if !self.stopped {
            if let Some(last) = v.last_mut() {
                last.played_sec = (self.last_t - last.start_sec).max(0.0);
            }
        }
        v
    }

    /// Manual edit: remove an entry (e.g. a wrongly detected track); the previous one absorbs its time.
    pub fn remove(&mut self, index: usize) -> bool {
        if index >= self.entries.len() {
            return false;
        }
        let gone = self.entries.remove(index);
        if index > 0 {
            if let Some(prev) = self.entries.get_mut(index - 1) {
                prev.played_sec += gone.played_sec;
            }
        }
        true
    }
}

impl Default for SetLogger {
    fn default() -> Self {
        Self::new(LoggerConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tr(id: &str) -> TrackRef {
        TrackRef {
            id: id.into(),
            title: format!("Title {id}"),
            artist: format!("Artist {id}"),
            isrc: Some(format!("RO-ABC-26-0000{}", id.len())),
            path: None,
        }
    }

    fn deck(d: u8, playing: bool, vol: f32, id: Option<&str>) -> DeckObs {
        DeckObs {
            deck: d,
            playing,
            volume: vol,
            track: id.map(tr),
        }
    }

    /// Simulate a 2-deck set at 1 Hz: `plan(t) -> (decks, crossfader)`.
    fn run(until: u32, plan: impl Fn(u32) -> (Vec<DeckObs>, f32)) -> SetLogger {
        let mut l = SetLogger::default();
        for t in 0..=until {
            let (d, x) = plan(t);
            l.observe(f64::from(t), &d, x);
        }
        l.stop(f64::from(until));
        l
    }

    #[test]
    fn crossfader_weights() {
        assert_eq!(crossfader_weight(0, -1.0), 1.0);
        assert_eq!(crossfader_weight(1, -1.0), 0.0);
        assert_eq!(crossfader_weight(0, 0.0), 1.0);
        assert_eq!(crossfader_weight(1, 0.5), 1.0);
        assert_eq!(crossfader_weight(0, 0.5), 0.5);
        assert_eq!(crossfader_weight(2, 1.0), 1.0);
    }

    #[test]
    fn crossfader_transition_makes_two_entries_backdated() {
        // A plays alone to 100 s; B joins at 90 with fader up; crossfader moves to B at 120.
        let l = run(300, |t| {
            let a = deck(0, t < 140, 1.0, Some("a"));
            let b = deck(1, t >= 90, if t >= 90 { 1.0 } else { 0.0 }, Some("b"));
            let x = if t < 120 { -1.0 } else { 1.0 };
            (vec![a, b], x)
        });
        let e = l.entries();
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].track.id.as_str(), e[0].start_sec), ("a", 0.0));
        assert_eq!((e[1].track.id.as_str(), e[1].start_sec), ("b", 120.0));
        assert_eq!(e[0].played_sec, 120.0);
        assert_eq!(e[1].played_sec, 180.0);
    }

    #[test]
    fn short_previews_and_silence_are_ignored() {
        let l = run(200, |t| {
            let a = deck(0, true, 1.0, Some("a"));
            // B is louder only between 50 and 60 (10 s < 20 s minimum).
            let b = deck(
                1,
                true,
                if (50..60).contains(&t) { 1.0 } else { 0.0 },
                Some("b"),
            );
            let x = if (50..60).contains(&t) { 1.0 } else { -1.0 };
            (vec![a, b], x)
        });
        let e = l.entries();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].track.id, "a");
        let silent = run(100, |_| (vec![deck(0, false, 1.0, Some("a"))], 0.0));
        assert!(silent.entries().is_empty());
    }

    #[test]
    fn same_track_reloaded_after_another_counts_again_and_remove_merges_time() {
        let l = run(400, |t| {
            let id = if t < 150 {
                "a"
            } else if t < 300 {
                "b"
            } else {
                "a"
            };
            (vec![deck(0, true, 1.0, Some(id))], -1.0)
        });
        let ids: Vec<_> = l.entries().iter().map(|e| e.track.id.clone()).collect();
        assert_eq!(ids, vec!["a", "b", "a"]);
        let mut l = l;
        assert!(l.remove(1));
        let e = l.entries();
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].played_sec, 300.0);
        assert!(!l.remove(9));
    }

    #[test]
    fn time_going_backwards_or_after_stop_is_ignored() {
        let mut l = SetLogger::default();
        l.observe(30.0, &[deck(0, true, 1.0, Some("a"))], 0.0);
        l.observe(10.0, &[deck(0, true, 1.0, Some("b"))], 0.0);
        l.observe(f64::NAN, &[deck(0, true, 1.0, Some("b"))], 0.0);
        l.observe(51.0, &[deck(0, true, 1.0, Some("a"))], 0.0);
        assert_eq!(l.entries().len(), 1);
        l.stop(60.0);
        l.observe(200.0, &[deck(0, true, 1.0, Some("b"))], 0.0);
        assert_eq!(l.entries().len(), 1);
        assert_eq!(l.entries()[0].played_sec, 30.0);
    }
}
