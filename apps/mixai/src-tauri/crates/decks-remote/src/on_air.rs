//! Which track is "on air" for the stream overlay (`/now`, WP19-59): a pure rule fed with what
//! the app sees of the decks, no clock of its own.
//!
//! Rule: the audible level of a deck is `playing × channel fader × crossfader side` (a deck
//! assigned THRU ignores the crossfader), the same level as the set tracklist
//! (`apps/mixai/src/setlog/set-logger.ts`). The loudest audible deck at or above
//! [`AUDIBLE_THRESHOLD`] is the dominant one (ties go to the first deck in the slice). A track
//! becomes the on-air track once it has been dominant for [`ON_AIR_SEC`] in a row; until then
//! the previous one stays. [`ON_AIR_SEC`] without any audible deck clears it. The same track
//! taking over on another deck (a DJ doubling a track) is not a change. Nothing is backdated:
//! the overlay follows the room, not the tracklist (which waits 20 s and backdates).
//!
//! Time is a monotonic number of seconds; a non-finite or backward sample is ignored.
//! Non-finite levels count as 0. Nothing here panics.

/// A track must be the loudest audible one for this long (seconds) before the overlay shows it,
/// and the overlay clears after this long without any audible track.
pub const ON_AIR_SEC: f64 = 8.0;
/// Audible level (0..1) under which a deck counts as silent.
pub const AUDIBLE_THRESHOLD: f32 = 0.05;

/// Crossfader assignment of a deck.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    A,
    /// Not on the crossfader: the channel fader alone sets the level.
    Thru,
    B,
}

/// The track a deck holds, as the overlay would show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackRef {
    /// Stable identity (library id, or a key built from title / artist / length for a file
    /// without one). Two decks with the same id hold the same track.
    pub id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

/// One deck at one instant.
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub playing: bool,
    /// Channel fader 0..1 (clamped; non-finite = 0).
    pub fader: f32,
    pub side: Side,
    /// `None` = nothing loaded.
    pub track: Option<TrackRef>,
}

/// What the overlay shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnAirTrack {
    pub id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
}

impl From<&TrackRef> for OnAirTrack {
    fn from(t: &TrackRef) -> Self {
        Self {
            id: t.id.clone(),
            title: t.title.clone(),
            artist: t.artist.clone(),
        }
    }
}

/// Crossfader weight of a deck on `side` for position `x` (−1 = A only, 1 = B only; clamped,
/// non-finite = centre). Linear, full in the middle; THRU bypasses it.
pub fn crossfader_weight(side: Side, x: f32) -> f32 {
    let c = if x.is_finite() {
        x.clamp(-1.0, 1.0)
    } else {
        0.0
    };
    match side {
        Side::A => (1.0 - c).min(1.0),
        Side::B => (1.0 + c).min(1.0),
        Side::Thru => 1.0,
    }
}

/// Audible level of one deck (0 when paused, empty or non-finite).
pub fn audible_level(d: &Observation, crossfader: f32) -> f32 {
    if d.track.is_none() || !d.playing {
        return 0.0;
    }
    let v = if d.fader.is_finite() {
        d.fader.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let level = v * crossfader_weight(d.side, crossfader);
    if level.is_finite() { level } else { 0.0 }
}

/// The loudest audible deck at or above `threshold`; equal levels go to the first one.
pub fn dominant_of(decks: &[Observation], crossfader: f32, threshold: f32) -> Option<&Observation> {
    let mut best: Option<(&Observation, f32)> = None;
    for d in decks {
        let level = audible_level(d, crossfader);
        if level < threshold || d.track.is_none() {
            continue;
        }
        if best.is_none_or(|(_, b)| level > b) {
            best = Some((d, level));
        }
    }
    best.map(|(d, _)| d)
}

#[derive(Debug, Clone, PartialEq)]
struct Streak {
    /// `None` = silence.
    track: Option<TrackRef>,
    since: f64,
}

/// The on-air tracker. Feed it every tick with [`OnAir::observe`]; read [`OnAir::current`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OnAir {
    current: Option<OnAirTrack>,
    /// What has been dominant since when, while it differs from `current`.
    challenger: Option<Streak>,
    last_t: Option<f64>,
}

impl OnAir {
    pub fn new() -> Self {
        Self::default()
    }

    /// The track on air right now (`None` = nothing).
    pub fn current(&self) -> Option<&OnAirTrack> {
        self.current.as_ref()
    }

    /// Feed the state at `t_sec` (monotonic seconds). Returns the track on air after this
    /// sample. A non-finite or backward `t_sec` changes nothing.
    pub fn observe(
        &mut self,
        t_sec: f64,
        decks: &[Observation],
        crossfader: f32,
    ) -> Option<&OnAirTrack> {
        if !t_sec.is_finite() || self.last_t.is_some_and(|last| t_sec < last) {
            return self.current.as_ref();
        }
        self.last_t = Some(t_sec);
        let dominant =
            dominant_of(decks, crossfader, AUDIBLE_THRESHOLD).and_then(|d| d.track.as_ref());
        let same_as_current = match (&self.current, dominant) {
            (None, None) => true,
            (Some(c), Some(d)) => c.id == d.id,
            _ => false,
        };
        if same_as_current {
            // The on-air track stays (on whichever deck it plays now); its texts follow a
            // label that arrived later.
            if let (Some(c), Some(d)) = (&mut self.current, dominant) {
                c.title.clone_from(&d.title);
                c.artist.clone_from(&d.artist);
            }
            self.challenger = None;
            return self.current.as_ref();
        }
        let same_challenger = match (&self.challenger, dominant) {
            (Some(s), Some(d)) => s.track.as_ref().is_some_and(|t| t.id == d.id),
            (Some(s), None) => s.track.is_none(),
            (None, _) => false,
        };
        if !same_challenger {
            self.challenger = Some(Streak {
                track: dominant.cloned(),
                since: t_sec,
            });
        }
        let promote = self
            .challenger
            .as_ref()
            .is_some_and(|s| t_sec - s.since >= ON_AIR_SEC);
        if promote {
            self.current = dominant.map(OnAirTrack::from);
            self.challenger = None;
        }
        self.current.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str) -> TrackRef {
        TrackRef {
            id: id.into(),
            title: Some(format!("Title {id}")),
            artist: Some(format!("Artist {id}")),
        }
    }

    fn deck(id: Option<&str>, playing: bool, fader: f32, side: Side) -> Observation {
        Observation {
            playing,
            fader,
            side,
            track: id.map(track),
        }
    }

    fn a(playing: bool, fader: f32) -> Observation {
        deck(Some("x"), playing, fader, Side::A)
    }

    fn b(playing: bool, fader: f32) -> Observation {
        deck(Some("y"), playing, fader, Side::B)
    }

    fn id_of(o: &OnAir) -> Option<&str> {
        o.current().map(|t| t.id.as_str())
    }

    #[test]
    fn levels_follow_fader_and_crossfader_side_and_thru_ignores_the_crossfader() {
        assert_eq!(audible_level(&a(true, 1.0), -1.0), 1.0);
        assert_eq!(audible_level(&a(true, 1.0), 0.0), 1.0);
        assert_eq!(audible_level(&a(true, 1.0), 0.5), 0.5);
        assert_eq!(audible_level(&a(true, 1.0), 1.0), 0.0);
        assert_eq!(audible_level(&b(true, 0.8), 1.0), 0.8);
        assert!((audible_level(&b(true, 0.8), -0.5) - 0.4).abs() < 1e-6);
        assert_eq!(
            audible_level(&deck(Some("t"), true, 0.7, Side::Thru), 1.0),
            0.7
        );
        assert_eq!(
            audible_level(&deck(Some("t"), true, 0.7, Side::Thru), -1.0),
            0.7
        );
        assert_eq!(audible_level(&a(false, 1.0), 0.0), 0.0, "paused");
        assert_eq!(
            audible_level(&deck(None, true, 1.0, Side::A), 0.0),
            0.0,
            "empty"
        );
        // Out of range is clamped, non-finite counts as 0 (fader) or centre (crossfader).
        assert_eq!(audible_level(&a(true, 7.0), 0.0), 1.0);
        assert_eq!(audible_level(&a(true, f32::NAN), 0.0), 0.0);
        assert_eq!(audible_level(&a(true, f32::INFINITY), 0.0), 0.0);
        assert_eq!(audible_level(&a(true, 1.0), f32::NAN), 1.0);
        assert_eq!(audible_level(&a(true, 1.0), f32::NEG_INFINITY), 1.0);
    }

    #[test]
    fn dominant_is_the_loudest_at_or_above_the_threshold_ties_to_the_first_deck() {
        let decks = [a(true, 0.6), b(true, 0.6)];
        assert_eq!(
            dominant_of(&decks, 0.0, AUDIBLE_THRESHOLD).map(|d| &d.track),
            Some(&decks[0].track)
        );
        assert_eq!(
            dominant_of(&decks, 0.2, AUDIBLE_THRESHOLD).map(|d| &d.track),
            Some(&decks[1].track)
        );
        let quiet = [a(true, 0.04), b(false, 1.0)];
        assert!(dominant_of(&quiet, 0.0, AUDIBLE_THRESHOLD).is_none());
        let edge = [a(true, 0.05)];
        assert!(
            dominant_of(&edge, 0.0, AUDIBLE_THRESHOLD).is_some(),
            "at the threshold counts"
        );
        assert!(dominant_of(&[], 0.0, AUDIBLE_THRESHOLD).is_none());
    }

    #[test]
    fn a_track_is_on_air_after_eight_seconds_of_dominance_not_before() {
        let mut o = OnAir::new();
        let decks = [a(true, 1.0), b(false, 1.0)];
        assert_eq!(o.observe(0.0, &decks, 0.0), None);
        assert_eq!(o.observe(7.9, &decks, 0.0), None, "7.9 s is not enough");
        assert_eq!(
            o.observe(8.0, &decks, 0.0).map(|t| t.id.as_str()),
            Some("x")
        );
        let t = o.current().unwrap();
        assert_eq!(t.title.as_deref(), Some("Title x"));
        assert_eq!(t.artist.as_deref(), Some("Artist x"));
    }

    #[test]
    fn a_challenger_takes_over_only_after_eight_seconds_and_a_short_one_changes_nothing() {
        let mut o = OnAir::new();
        o.observe(0.0, &[a(true, 1.0), b(false, 1.0)], -1.0);
        o.observe(8.0, &[a(true, 1.0), b(false, 1.0)], -1.0);
        assert_eq!(id_of(&o), Some("x"));
        // B is louder for 5 s (a blend that comes back): X stays.
        let both = [a(true, 1.0), b(true, 1.0)];
        o.observe(10.0, &both, 0.5);
        o.observe(15.0, &both, 0.5);
        assert_eq!(id_of(&o), Some("x"));
        o.observe(16.0, &both, -0.5);
        assert_eq!(id_of(&o), Some("x"), "back to A: the challenge is over");
        // B wins for 8 s in a row: it takes over at 8.0, not at 7.9.
        o.observe(20.0, &both, 0.5);
        o.observe(27.9, &both, 0.5);
        assert_eq!(id_of(&o), Some("x"));
        o.observe(28.0, &both, 0.5);
        assert_eq!(id_of(&o), Some("y"));
    }

    #[test]
    fn eight_seconds_of_silence_clears_the_overlay_and_a_shorter_gap_does_not() {
        let mut o = OnAir::new();
        o.observe(0.0, &[a(true, 1.0)], 0.0);
        o.observe(8.0, &[a(true, 1.0)], 0.0);
        assert_eq!(id_of(&o), Some("x"));
        o.observe(9.0, &[a(false, 1.0)], 0.0);
        o.observe(14.0, &[a(false, 1.0)], 0.0);
        assert_eq!(id_of(&o), Some("x"), "5 s of silence: still shown");
        o.observe(15.0, &[a(true, 1.0)], 0.0);
        assert_eq!(id_of(&o), Some("x"));
        o.observe(20.0, &[a(false, 1.0)], 0.0);
        o.observe(27.9, &[a(false, 1.0)], 0.0);
        assert_eq!(id_of(&o), Some("x"));
        o.observe(28.0, &[a(false, 1.0)], 0.0);
        assert_eq!(id_of(&o), None);
        // Silence then nothing: stays empty without a new 8 s.
        o.observe(40.0, &[], 0.0);
        assert_eq!(id_of(&o), None);
    }

    #[test]
    fn the_same_track_on_another_deck_is_not_a_change_and_a_later_label_is_taken() {
        let mut o = OnAir::new();
        o.observe(
            0.0,
            &[a(true, 1.0), deck(Some("x"), false, 1.0, Side::B)],
            -1.0,
        );
        o.observe(
            8.0,
            &[a(true, 1.0), deck(Some("x"), false, 1.0, Side::B)],
            -1.0,
        );
        assert_eq!(id_of(&o), Some("x"));
        // The DJ doubles the track: deck B now carries the same id and is the louder one.
        let doubled = [
            a(false, 1.0),
            Observation {
                playing: true,
                fader: 1.0,
                side: Side::B,
                track: Some(TrackRef {
                    id: "x".into(),
                    title: Some("Title x (library)".into()),
                    artist: Some("Artist x".into()),
                }),
            },
        ];
        o.observe(9.0, &doubled, 1.0);
        assert_eq!(
            id_of(&o),
            Some("x"),
            "no change, at once and without a new 8 s"
        );
        assert_eq!(
            o.current().unwrap().title.as_deref(),
            Some("Title x (library)"),
            "texts follow the deck that plays it"
        );
        o.observe(30.0, &doubled, 1.0);
        assert_eq!(id_of(&o), Some("x"));
    }

    #[test]
    fn backward_and_non_finite_time_samples_are_ignored() {
        let mut o = OnAir::new();
        let decks = [a(true, 1.0)];
        o.observe(10.0, &decks, 0.0);
        o.observe(f64::NAN, &decks, 0.0);
        o.observe(f64::INFINITY, &decks, 0.0);
        o.observe(5.0, &decks, 0.0);
        // Were the infinite sample taken, the track would be on air at once (infinitely later
        // than 10.0); were NaN taken, it would become the last time and nothing after it would
        // count as backward.
        assert_eq!(o.observe(17.9, &decks, 0.0), None);
        assert_eq!(id_of(&o), None);
        assert_eq!(
            o.observe(18.0, &decks, 0.0).map(|t| t.id.as_str()),
            Some("x")
        );
        // Backward samples after promotion change nothing: were they taken, these two (silence,
        // 8.5 s apart) would clear the overlay.
        assert_eq!(o.observe(1.0, &[], 0.0).map(|t| t.id.as_str()), Some("x"));
        assert_eq!(o.observe(9.5, &[], 0.0).map(|t| t.id.as_str()), Some("x"));
        // And they started no silence streak: 0.1 s of real silence later the track is still on.
        assert_eq!(o.observe(18.1, &[], 0.0).map(|t| t.id.as_str()), Some("x"));
        assert_eq!(o.observe(26.0, &[], 0.0).map(|t| t.id.as_str()), Some("x"));
        assert_eq!(o.observe(26.1, &[], 0.0), None, "8 s of silence from 18.1");
    }

    #[test]
    fn a_quiet_or_cued_deck_never_becomes_the_on_air_track() {
        let mut o = OnAir::new();
        // Playing in the headphones with the fader down, and a deck below the threshold.
        let decks = [a(true, 0.0), b(true, 0.04)];
        o.observe(0.0, &decks, 0.0);
        o.observe(60.0, &decks, 0.0);
        assert_eq!(id_of(&o), None);
        // The crossfader hard to B silences deck A even at full fader.
        let decks = [a(true, 1.0), b(false, 1.0)];
        o.observe(61.0, &decks, 1.0);
        o.observe(90.0, &decks, 1.0);
        assert_eq!(id_of(&o), None);
    }
}
