//! The CDJ CUE button of one deck as a pure state machine, shared by the app's own CUE button
//! (`DecksEngine::cue`, holder [`CueHolder::Local`]) and the phone remote pump (`remote.rs`,
//! holder [`CueHolder::Remote`]). Same rules as the Tauri shell (`src/remote.rs`):
//!
//! * Playing: back to the cue point and pause. Paused on the cue point: play while held (the
//!   release goes back to the cue point). Paused elsewhere: set the cue point there.
//! * A held CUE belongs to whoever pressed it ([`Hold::by`]): another holder's press or release
//!   changes nothing until the owner lets go. [`CueState::end_hold_unless`] ends a hold whose
//!   owner may no longer hold it (phone gone, controls locked, server stopped): the deck goes
//!   back to the cue point, paused, unless another track was loaded meanwhile (then the deck is
//!   not touched).
//! * Except the DJ's own button ([`CueHolder::Local`]): its press on a deck a phone holds acts
//!   like a CUE press on a playing CDJ. The phone's hold ends and the deck goes back to the cue
//!   point, paused; the phone's later release and the local release of that press change
//!   nothing. Another phone still changes nothing, and a phone never ends a local hold.
//! * The engine applies a command at its next audio callback, so right after a command the
//!   snapshot is one buffer old. For [`SETTLE`] after a transport command the button goes by what
//!   was asked for, not by the snapshot; a press while the playhead is on its way somewhere
//!   unknown (hot cue, beat jump, phase sync) is dropped instead of moving the cue point to the
//!   place the playhead just left.

use std::time::{Duration, Instant};

/// "On the cue point" tolerance (the decks' CUE LED uses the same).
pub(crate) const AT_CUE_SEC: f64 = 0.02;
/// How long what was asked of a deck counts instead of the snapshot: one audio buffer at the
/// largest size (4096 frames at 44.1 kHz = 93 ms) plus one UI / pump tick.
pub(crate) const SETTLE: Duration = Duration::from_millis(150);

/// Who presses CUE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CueHolder {
    /// The app's own button (`DecksEngine::cue`, MIDI mappings included).
    Local,
    /// A phone: `server` names the `DecksRemote` it is connected to, `conn` its connection.
    Remote { server: u64, conn: u64 },
}

/// Where the playhead was last sent.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Playhead {
    /// To this position (seconds).
    At(f64),
    /// Not moved: the snapshot is right to within one buffer.
    Live,
    /// Moved by a jump the snapshot does not show yet: unknown.
    Jumped,
}

/// What was asked of the deck's transport, valid for [`SETTLE`].
#[derive(Debug, Clone, Copy, PartialEq)]
struct Expect {
    /// `None` = not changed: the snapshot counts.
    playing: Option<bool>,
    playhead: Playhead,
    at: Instant,
}

/// CUE held on the cue point.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Hold {
    /// Only this holder lets go.
    pub(crate) by: CueHolder,
    /// Track the hold began on (the deck's load ticket).
    track: u64,
}

/// Engine commands a step asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum CueSend {
    Play,
    /// Pause, then seek to this position.
    Return(f64),
}

/// Result of one press / release.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct CueStep {
    pub(crate) send: Option<CueSend>,
    /// The cue point moved here.
    pub(crate) moved: Option<f64>,
}

/// What the button reads of the deck.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DeckView {
    pub(crate) loaded: bool,
    pub(crate) playing: bool,
    pub(crate) position: f64,
    /// Identity of the loaded track (load ticket).
    pub(crate) track: u64,
}

/// Transport cue point + CUE button state of one deck, valid for one track.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct CueState {
    pub(crate) point: f64,
    track: u64,
    hold: Option<Hold>,
    expect: Option<Expect>,
}

impl CueState {
    /// A freshly loaded track with its cue point.
    pub(crate) fn for_track(track: u64, point: f64) -> Self {
        Self {
            point,
            track,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn holder(&self) -> Option<CueHolder> {
        self.hold.map(|h| h.by)
    }

    #[cfg(test)]
    pub(crate) fn test_hold(&mut self, by: CueHolder) {
        self.hold = Some(Hold {
            by,
            track: self.track,
        });
    }

    pub(crate) fn has_hold_not_kept(&self, keep: &dyn Fn(CueHolder) -> bool) -> bool {
        self.hold.is_some_and(|h| !keep(h.by))
    }

    /// Forget the hold and what was asked, without touching the deck.
    pub(crate) fn drop_hold(&mut self) {
        self.hold = None;
        self.expect = None;
    }

    fn expecting(&self, now: Instant) -> Option<Expect> {
        self.expect
            .filter(|e| now.saturating_duration_since(e.at) < SETTLE)
    }

    fn sent(&mut self, playing: Option<bool>, playhead: Playhead, now: Instant) {
        self.expect = Some(Expect {
            playing,
            playhead,
            at: now,
        });
    }

    fn go_back(&mut self, now: Instant) -> CueSend {
        self.sent(Some(false), Playhead::At(self.point), now);
        CueSend::Return(self.point)
    }

    /// PLAY was sent: a held CUE stays playing after its release.
    pub(crate) fn asked_play(&mut self, now: Instant) {
        self.hold = None;
        self.sent(Some(true), Playhead::Live, now);
    }

    /// PAUSE was sent (the deck stops within one buffer of the snapshot position).
    pub(crate) fn asked_pause(&mut self, now: Instant) {
        self.hold = None;
        self.sent(Some(false), Playhead::Live, now);
    }

    /// A seek to `sec` was sent.
    pub(crate) fn asked_seek(&mut self, sec: f64, now: Instant) {
        let playing = self.expecting(now).and_then(|e| e.playing);
        self.sent(playing, Playhead::At(sec), now);
    }

    /// A jump whose landing is not known here was sent (hot cue, beat jump, phase sync).
    pub(crate) fn asked_jump(&mut self, now: Instant) {
        let playing = self.expecting(now).and_then(|e| e.playing);
        self.sent(playing, Playhead::Jumped, now);
    }

    /// The CUE button pressed (`pressed`) or released by `by`.
    pub(crate) fn button(
        &mut self,
        view: DeckView,
        by: CueHolder,
        pressed: bool,
        now: Instant,
    ) -> CueStep {
        if !view.loaded {
            self.drop_hold();
            return CueStep::default();
        }
        // A hold that began on another track is over; its release changes nothing here.
        if self.track != view.track {
            self.drop_hold();
            self.track = view.track;
        }
        if !pressed {
            if self.hold.is_some_and(|h| h.by == by) {
                self.hold = None;
                return CueStep {
                    send: Some(self.go_back(now)),
                    moved: None,
                };
            }
            return CueStep::default();
        }
        // Held: the first holder owns it (its own repeated press changes nothing either).
        // The DJ's own button overrides a phone: back to the cue point, paused (module docs).
        if by == CueHolder::Local && self.hold.is_some_and(|h| h.by != CueHolder::Local) {
            self.hold = None;
            return CueStep {
                send: Some(self.go_back(now)),
                moved: None,
            };
        }
        if self.hold.is_some() {
            return CueStep::default();
        }
        let expect = self.expecting(now);
        let playing = expect.and_then(|e| e.playing).unwrap_or(view.playing);
        if playing {
            return CueStep {
                send: Some(self.go_back(now)),
                moved: None,
            };
        }
        let position = match expect.map(|e| e.playhead) {
            Some(Playhead::At(p)) => p,
            Some(Playhead::Jumped) => return CueStep::default(),
            Some(Playhead::Live) | None => view.position,
        };
        if (position - self.point).abs() < AT_CUE_SEC {
            self.hold = Some(Hold {
                by,
                track: view.track,
            });
            self.sent(Some(true), Playhead::Live, now);
            return CueStep {
                send: Some(CueSend::Play),
                moved: None,
            };
        }
        self.point = position;
        CueStep {
            send: None,
            moved: Some(position),
        }
    }

    /// End the hold when `keep(owner)` is false. Back to the cue point, paused, when the deck
    /// still holds the track the hold began on; otherwise the deck is not touched.
    pub(crate) fn end_hold_unless(
        &mut self,
        view: DeckView,
        keep: &dyn Fn(CueHolder) -> bool,
        now: Instant,
    ) -> Option<CueSend> {
        let hold = self.hold?;
        if keep(hold.by) {
            return None;
        }
        self.hold = None;
        let same_track = view.loaded && view.track == hold.track;
        if !same_track {
            self.expect = None;
            return None;
        }
        Some(self.go_back(now))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    const PHONE: CueHolder = CueHolder::Remote { server: 1, conn: 7 };
    const OTHER: CueHolder = CueHolder::Remote { server: 1, conn: 8 };
    const LOCAL: CueHolder = CueHolder::Local;
    const T1: u64 = 1;

    enum Change {
        Playing(bool),
        Position(f64),
    }

    /// A deck as the engine reports it; with `lag` a command shows only at [`Deck::callback`].
    struct Deck {
        view: DeckView,
        lag: bool,
        queued: VecDeque<Change>,
        log: Vec<String>,
    }

    impl Deck {
        fn new(position: f64, playing: bool) -> Self {
            Self {
                view: DeckView {
                    loaded: true,
                    playing,
                    position,
                    track: T1,
                },
                lag: false,
                queued: VecDeque::new(),
                log: Vec::new(),
            }
        }

        fn lagging(position: f64, playing: bool) -> Self {
            Self {
                lag: true,
                ..Self::new(position, playing)
            }
        }

        fn push(&mut self, c: Change) {
            if self.lag {
                self.queued.push_back(c);
            } else {
                self.commit(c);
            }
        }

        fn commit(&mut self, c: Change) {
            match c {
                Change::Playing(p) => self.view.playing = p,
                Change::Position(s) => self.view.position = s,
            }
        }

        fn apply(&mut self, send: Option<CueSend>) {
            match send {
                Some(CueSend::Play) => {
                    self.log.push("play".into());
                    self.push(Change::Playing(true));
                }
                Some(CueSend::Return(p)) => {
                    self.log.push(format!("back {p}"));
                    self.push(Change::Playing(false));
                    self.push(Change::Position(p));
                }
                None => {}
            }
        }

        /// An audio callback picking up the first `n` queued changes.
        fn callback(&mut self, n: usize) {
            for _ in 0..n {
                let Some(c) = self.queued.pop_front() else {
                    break;
                };
                self.commit(c);
            }
        }

        fn take(&mut self) -> Vec<String> {
            std::mem::take(&mut self.log)
        }
    }

    fn btn(
        c: &mut CueState,
        d: &mut Deck,
        by: CueHolder,
        pressed: bool,
        at: Instant,
    ) -> Option<f64> {
        let s = c.button(d.view, by, pressed, at);
        d.apply(s.send);
        s.moved
    }

    fn end(c: &mut CueState, d: &mut Deck, keep: &dyn Fn(CueHolder) -> bool, at: Instant) {
        let s = c.end_hold_unless(d.view, keep, at);
        d.apply(s);
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    const NONE: [&str; 0] = [];

    #[test]
    fn the_cdj_button_table() {
        let t0 = Instant::now();
        // Deck position, playing, cue point -> engine calls, moved cue point, held.
        let row = |pos: f64,
                   playing: bool,
                   point: f64,
                   calls: &[&str],
                   moved: Option<f64>,
                   held: bool| {
            let mut d = Deck::new(pos, playing);
            let mut c = CueState::for_track(T1, point);
            let got = btn(&mut c, &mut d, PHONE, true, t0);
            assert_eq!(got, moved, "{pos} {playing}");
            assert_eq!(d.take(), calls, "{pos} {playing}");
            assert_eq!(c.holder().is_some(), held, "{pos} {playing}");
        };
        row(42.0, true, 12.5, &["back 12.5"], None, false);
        row(12.51, false, 12.5, &["play"], None, true);
        row(12.49, false, 12.5, &["play"], None, true);
        row(33.25, false, 12.5, &[], Some(33.25), false);
        row(0.0, true, 0.0, &["back 0"], None, false);
        // Nothing loaded: nothing happens, a stale hold is forgotten.
        let mut d = Deck::new(0.0, false);
        d.view.loaded = false;
        let mut c = CueState::for_track(T1, 0.0);
        c.test_hold(PHONE);
        assert_eq!(btn(&mut c, &mut d, PHONE, true, t0), None);
        assert_eq!(d.take(), NONE);
        assert_eq!(c.holder(), None);
    }

    #[test]
    fn a_hold_previews_until_its_owner_lets_go_and_the_first_holder_owns_it() {
        let t0 = Instant::now();
        let mut d = Deck::new(12.5, false);
        let mut c = CueState::for_track(T1, 12.5);
        btn(&mut c, &mut d, PHONE, true, t0);
        assert_eq!(d.take(), ["play"]);
        d.view.position = 14.0;
        // Another phone, a local release without a press, and the holder's repeated press:
        // ignored (a local PRESS takes the deck back: the next test).
        for (by, pressed, at) in [
            (OTHER, true, 500),
            (OTHER, false, 600),
            (LOCAL, false, 700),
            (PHONE, true, 800),
        ] {
            assert_eq!(btn(&mut c, &mut d, by, pressed, t0 + ms(at)), None);
            assert_eq!(d.take(), NONE, "{by:?} {pressed}");
            assert_eq!(c.holder(), Some(PHONE));
        }
        assert!(d.view.playing);
        btn(&mut c, &mut d, PHONE, false, t0 + ms(1000));
        assert_eq!(d.take(), ["back 12.5"]);
        assert_eq!(c.holder(), None);
        // Free again: the app's own button may hold it now, and a phone cannot let it go.
        btn(&mut c, &mut d, LOCAL, true, t0 + ms(2000));
        assert_eq!(d.take(), ["play"]);
        btn(&mut c, &mut d, PHONE, false, t0 + ms(2100));
        assert_eq!(d.take(), NONE);
        btn(&mut c, &mut d, LOCAL, false, t0 + ms(2200));
        assert_eq!(d.take(), ["back 12.5"]);
        // PLAY while held keeps the deck playing after the release.
        btn(&mut c, &mut d, PHONE, true, t0 + ms(3000));
        c.asked_play(t0 + ms(3100));
        btn(&mut c, &mut d, PHONE, false, t0 + ms(3200));
        assert_eq!(d.take(), ["play"]);
        assert!(d.view.playing);
    }

    #[test]
    fn the_djs_own_button_takes_a_deck_back_from_a_phone_but_never_the_other_way() {
        let t0 = Instant::now();
        // Holder of the running hold, who presses / releases -> engine calls, holder after.
        let row = |held_by: CueHolder,
                   by: CueHolder,
                   pressed: bool,
                   calls: &[&str],
                   after: Option<CueHolder>| {
            let mut d = Deck::new(12.5, false);
            let mut c = CueState::for_track(T1, 12.5);
            btn(&mut c, &mut d, held_by, true, t0);
            assert_eq!(d.take(), ["play"]);
            d.view.position = 14.0;
            assert_eq!(btn(&mut c, &mut d, by, pressed, t0 + ms(500)), None);
            assert_eq!(d.take(), calls, "{held_by:?} then {by:?} {pressed}");
            assert_eq!(c.holder(), after, "{held_by:?} then {by:?} {pressed}");
            (c, d)
        };
        // The DJ presses CUE on a deck a phone previews: back to the cue point, paused.
        let (mut c, mut d) = row(PHONE, LOCAL, true, &["back 12.5"], None);
        assert!(!d.view.playing && d.view.position == 12.5);
        // The phone's late release and the DJ's own release change nothing now.
        assert_eq!(btn(&mut c, &mut d, PHONE, false, t0 + ms(600)), None);
        assert_eq!(btn(&mut c, &mut d, LOCAL, false, t0 + ms(700)), None);
        assert_eq!(d.take(), NONE);
        // A local release alone does not end a phone's hold.
        row(PHONE, LOCAL, false, &[], Some(PHONE));
        // Another phone changes nothing: the first phone owns it.
        row(PHONE, OTHER, true, &[], Some(PHONE));
        row(PHONE, OTHER, false, &[], Some(PHONE));
        // A phone never ends the DJ's own hold, and the DJ's repeated press changes nothing.
        row(LOCAL, PHONE, true, &[], Some(LOCAL));
        row(LOCAL, PHONE, false, &[], Some(LOCAL));
        row(LOCAL, LOCAL, true, &[], Some(LOCAL));
    }

    // ---- the scenario table shared with the desktop shell ------------------------------
    //
    // The SAME rows are in `src/remote.rs` (`tests::the_shared_cue_scenarios`, Tauri shell): the
    // two CUE implementations must make the same engine calls for the same presses. Edit both.

    #[derive(Debug, Clone, Copy)]
    enum Who {
        Phone,
        Other,
    }

    #[derive(Debug, Clone, Copy)]
    enum Step {
        /// A phone presses / lets go of CUE.
        Press(Who),
        Release(Who),
        /// The DJ's own PLAY / PAUSE / CUE (CUE on a playing deck = pause + back to the cue
        /// point; the desktop UI sends it as pause + seek).
        Play,
        Pause,
        Cue,
        /// Another track is loaded on the deck and the DJ starts it (playing at 33 s).
        NewTrack,
        /// The DJ locks the phone controls.
        Lock,
        /// The playhead has moved here.
        At(f64),
    }

    type Scenario = (
        &'static str,
        &'static [(Step, &'static [&'static str])],
        bool,
    );

    /// Deck A paused on its cue point 12.5 s; expected engine calls per step ("play", "pause",
    /// "seek <sec>"), and whether the deck plays at the end.
    const SCENARIOS: &[Scenario] = &[
        (
            "phone press and release",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Release(Who::Phone), &["pause", "seek 12.5"]),
            ],
            false,
        ),
        (
            "second phone ignored",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Press(Who::Other), &[]),
                (Step::Release(Who::Other), &[]),
                (Step::Release(Who::Phone), &["pause", "seek 12.5"]),
            ],
            false,
        ),
        (
            "local CUE overrides a phone hold",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Cue, &["pause", "seek 12.5"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
        (
            "local PLAY during a phone hold keeps the deck playing",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Play, &["play"]),
                (Step::Release(Who::Phone), &[]),
            ],
            true,
        ),
        (
            "local PAUSE during a phone hold stops where the deck is",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Pause, &["pause"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
        (
            "track change during a hold",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::NewTrack, &[]),
                (Step::Release(Who::Phone), &[]),
            ],
            true,
        ),
        (
            "lock ends holds",
            &[
                (Step::Press(Who::Phone), &["play"]),
                (Step::At(14.0), &[]),
                (Step::Lock, &["pause", "seek 12.5"]),
                (Step::Release(Who::Phone), &[]),
            ],
            false,
        ),
    ];

    /// The fake deck's log in the shared vocabulary ("back p" = "pause", "seek p").
    fn canon(calls: Vec<String>) -> Vec<String> {
        calls
            .into_iter()
            .flat_map(|c| match c.strip_prefix("back ") {
                Some(p) => vec!["pause".to_string(), format!("seek {p}")],
                None => vec![c],
            })
            .collect()
    }

    #[test]
    fn the_shared_cue_scenarios() {
        let t0 = Instant::now();
        let who = |w: Who| match w {
            Who::Phone => PHONE,
            Who::Other => OTHER,
        };
        for (name, steps, playing) in SCENARIOS {
            let mut d = Deck::new(12.5, false);
            let mut c = CueState::for_track(T1, 12.5);
            for (i, (step, calls)) in steps.iter().enumerate() {
                let t = t0 + ms(1000 * (i as u64 + 1));
                match *step {
                    Step::Press(w) => {
                        btn(&mut c, &mut d, who(w), true, t);
                    }
                    Step::Release(w) => {
                        btn(&mut c, &mut d, who(w), false, t);
                    }
                    Step::Play => {
                        c.asked_play(t);
                        d.apply(Some(CueSend::Play));
                    }
                    Step::Pause => {
                        c.asked_pause(t);
                        d.log.push("pause".into());
                        d.push(Change::Playing(false));
                    }
                    Step::Cue => {
                        btn(&mut c, &mut d, LOCAL, true, t);
                        btn(&mut c, &mut d, LOCAL, false, t + ms(100));
                    }
                    Step::NewTrack => {
                        d.view = DeckView {
                            loaded: true,
                            playing: true,
                            position: 33.0,
                            track: 2,
                        };
                    }
                    Step::Lock => end(&mut c, &mut d, &|h| h == LOCAL, t),
                    Step::At(p) => d.view.position = p,
                }
                assert_eq!(canon(d.take()), *calls, "{name}: step {i} {step:?}");
            }
            assert_eq!(d.view.playing, *playing, "{name}: playing at the end");
        }
    }

    #[test]
    fn a_hold_whose_owner_is_gone_ends_on_the_cue_point_once() {
        let t0 = Instant::now();
        let mut d = Deck::new(12.5, false);
        let mut c = CueState::for_track(T1, 12.5);
        btn(&mut c, &mut d, PHONE, true, t0);
        d.take();
        d.view.position = 31.0;
        // Still there, or another holder gone: nothing.
        end(&mut c, &mut d, &|_| true, t0 + ms(100));
        end(&mut c, &mut d, &|h| h != OTHER, t0 + ms(200));
        assert_eq!(d.take(), NONE);
        assert_eq!(c.holder(), Some(PHONE));
        // PHONE gone: back to the cue point, paused.
        end(&mut c, &mut d, &|h| h != PHONE, t0 + ms(7000));
        assert_eq!(d.take(), ["back 12.5"]);
        assert!(!d.view.playing);
        assert_eq!(d.view.position, 12.5);
        // Once: later checks and a late release from the vanished phone do nothing.
        end(&mut c, &mut d, &|_| false, t0 + ms(7050));
        btn(&mut c, &mut d, PHONE, false, t0 + ms(7100));
        assert_eq!(d.take(), NONE);
        // The app's own hold survives a check that only drops phones.
        btn(&mut c, &mut d, LOCAL, true, t0 + ms(9000));
        assert_eq!(d.take(), ["play"]);
        end(&mut c, &mut d, &|h| h == LOCAL, t0 + ms(9100));
        assert_eq!(d.take(), NONE);
        assert_eq!(c.holder(), Some(LOCAL));
    }

    #[test]
    fn another_track_loaded_during_a_hold_is_never_touched() {
        let t0 = Instant::now();
        let held = || {
            let mut d = Deck::new(12.5, false);
            let mut c = CueState::for_track(T1, 12.5);
            btn(&mut c, &mut d, PHONE, true, t0);
            assert_eq!(d.take(), ["play"]);
            // Track 2 loaded (loading stops the deck), and the DJ started it.
            d.view = DeckView {
                loaded: true,
                playing: true,
                position: 33.0,
                track: 2,
            };
            (d, c)
        };
        let (mut d, mut c) = held();
        btn(&mut c, &mut d, PHONE, false, t0 + ms(2000));
        assert_eq!(d.take(), NONE, "release");
        assert_eq!(c.holder(), None);
        let (mut d, mut c) = held();
        end(&mut c, &mut d, &|_| false, t0 + ms(6000));
        assert_eq!(d.take(), NONE, "owner gone");
        assert_eq!(c.holder(), None);
        assert!(d.view.playing && d.view.position == 33.0);
        // The deck was emptied instead.
        let (mut d, mut c) = held();
        d.view.loaded = false;
        end(&mut c, &mut d, &|_| false, t0 + ms(6000));
        assert_eq!(d.take(), NONE, "emptied");
        // Control: same track, the owner gone -> back to the cue point.
        let mut d = Deck::new(12.5, false);
        let mut c = CueState::for_track(T1, 12.5);
        btn(&mut c, &mut d, PHONE, true, t0);
        end(&mut c, &mut d, &|_| false, t0 + ms(6000));
        assert_eq!(d.take(), ["play", "back 12.5"]);
    }

    #[test]
    fn a_second_press_before_the_engine_caught_up_does_not_move_the_cue_point() {
        let t0 = Instant::now();
        let mut d = Deck::lagging(42.0, true);
        let mut c = CueState::for_track(T1, 12.5);
        assert_eq!(btn(&mut c, &mut d, PHONE, true, t0), None);
        assert_eq!(d.take(), ["back 12.5"]);
        btn(&mut c, &mut d, PHONE, false, t0 + ms(20));
        // The pause landed, the seek not yet: the snapshot says paused at 42 s.
        d.callback(1);
        assert!(!d.view.playing && d.view.position == 42.0);
        assert_eq!(
            btn(&mut c, &mut d, PHONE, true, t0 + ms(50)),
            None,
            "no move to 42"
        );
        assert_eq!(c.point, 12.5);
        assert_eq!(
            d.take(),
            ["play"],
            "the deck was sent to the cue point: preview"
        );
        assert_eq!(c.holder(), Some(PHONE));
        // Same race after letting go of a preview that had reached 14 s.
        d.callback(usize::MAX);
        d.view.position = 14.0;
        btn(&mut c, &mut d, PHONE, false, t0 + ms(2000));
        assert_eq!(d.take(), ["back 12.5"]);
        d.callback(1);
        assert_eq!(btn(&mut c, &mut d, LOCAL, true, t0 + ms(2040)), None);
        assert_eq!(c.point, 12.5);
        assert_eq!(d.take(), ["play"]);
        // Nothing applied yet (the snapshot still says playing): not a second "back" either.
        let mut d = Deck::lagging(42.0, true);
        let mut c = CueState::for_track(T1, 12.5);
        btn(&mut c, &mut d, LOCAL, true, t0);
        btn(&mut c, &mut d, LOCAL, false, t0 + ms(10));
        d.take();
        btn(&mut c, &mut d, LOCAL, true, t0 + ms(30));
        assert_eq!(d.take(), ["play"]);
        assert_eq!(c.point, 12.5);
    }

    #[test]
    fn the_snapshot_counts_again_after_settle_and_unknown_landings_drop_the_press() {
        let t0 = Instant::now();
        let mut d = Deck::lagging(42.0, true);
        let mut c = CueState::for_track(T1, 12.5);
        btn(&mut c, &mut d, PHONE, true, t0);
        d.callback(usize::MAX);
        d.take();
        d.view.position = 30.0;
        assert_eq!(btn(&mut c, &mut d, PHONE, true, t0 + SETTLE), Some(30.0));
        assert_eq!(d.take(), NONE);
        // PLAY then CUE before the engine reports playing: back to the cue point.
        let mut d = Deck::lagging(42.0, false);
        let mut c = CueState::for_track(T1, 12.5);
        c.asked_play(t0);
        assert_eq!(btn(&mut c, &mut d, PHONE, true, t0 + ms(40)), None);
        assert_eq!(d.take(), ["back 12.5"]);
        // A seek the app sent counts where it was sent.
        let mut d = Deck::lagging(50.0, false);
        let mut c = CueState::for_track(T1, 12.5);
        c.asked_seek(12.5, t0);
        assert_eq!(btn(&mut c, &mut d, LOCAL, true, t0 + ms(40)), None);
        assert_eq!(d.take(), ["play"]);
        // A jump on a paused deck: the press inside the window is dropped, the next counts.
        let mut d = Deck::lagging(12.5, false);
        let mut c = CueState::for_track(T1, 12.5);
        c.asked_jump(t0);
        assert_eq!(btn(&mut c, &mut d, PHONE, true, t0 + ms(40)), None);
        assert_eq!(d.take(), NONE, "no preview from the stale position");
        assert_eq!(c.holder(), None);
        d.view.position = 96.0;
        assert_eq!(
            btn(&mut c, &mut d, PHONE, true, t0 + ms(40) + SETTLE),
            Some(96.0)
        );
    }
}
