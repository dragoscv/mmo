//! Transition plans: style choice, phrase-aligned timing and the automation that performs it.

use serde::{Deserialize, Serialize};

use crate::automation::{Automation, Curve, Event, Keyframe, Lane, Target, TimedEvent};
use crate::camelot::{KEY_CLASH_BELOW, KEY_FITS_FROM, key_score};
use crate::{BEATS_PER_BAR, TrackFeatures};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    /// Classic house/techno: bring B in with low cut, swap the basses on a phrase, fade A out.
    BassSwap,
    /// High-pass A away while B rises through a low-pass.
    FilterSweep,
    /// Echo out A on the beat, B starts on the next phrase (for tempo / key gaps).
    EchoOut,
    /// Stems: A keeps vocals while B's drums + bass come in, then A's vocal leaves (needs stems).
    StemSwap,
    /// Hard cut on the downbeat.
    Cut,
}

/// What the planner needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanRequest {
    pub from: TrackFeatures,
    pub to: TrackFeatures,
    /// Engine decks for the outgoing / incoming track.
    pub from_deck: u8,
    pub to_deck: u8,
    /// Current playhead of the outgoing track.
    pub from_pos_sec: f64,
    /// Requested length in bars (`None` = automatic: 16 normally, 8 when time is short).
    pub bars: Option<u32>,
    /// Requested style (`None` = automatic).
    pub style: Option<Style>,
    /// Earliest start, in bars from now (0 = next phrase boundary).
    #[serde(default)]
    pub not_before_bars: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TransitionPlan {
    pub style: Style,
    pub bars: u32,
    /// Where it starts on the outgoing track (seconds) — always on a phrase (8-bar) boundary when
    /// the grid allows, else on a bar.
    pub start_sec: f64,
    /// Beats from the outgoing track's playhead to the start.
    pub beats_until_start: f64,
    /// Where the incoming track should be cued (seconds): its first downbeat.
    pub to_cue_sec: f64,
    /// Tempo ratio to apply to the incoming deck so it matches the outgoing one.
    pub to_tempo_ratio: f64,
    pub automation: Automation,
    /// Reason tags for the choice (localised by the UI).
    pub reasons: Vec<String>,
}

fn kf(beat: f64, value: f32, curve: Curve) -> Keyframe {
    Keyframe { beat, value, curve }
}

fn lane(target: Target, keys: Vec<Keyframe>) -> Lane {
    Lane { target, keys }
}

fn choose_style(req: &PlanRequest, reasons: &mut Vec<String>) -> Style {
    if let Some(s) = req.style {
        reasons.push("style_requested".into());
        return s;
    }
    let (k, _) = key_score(req.from.key.as_deref(), req.to.key.as_deref());
    let tempo_gap = match (req.from.bpm, req.to.bpm) {
        (Some(a), Some(b)) if a > 0.0 && b > 0.0 => {
            let r = a / b;
            [1.0, 2.0, 0.5]
                .iter()
                .map(|f| ((r / f) - 1.0).abs() * 100.0)
                .fold(f64::INFINITY, f64::min)
        }
        _ => 100.0,
    };
    if tempo_gap > 8.0 {
        reasons.push("tempo_gap_echo".into());
        return Style::EchoOut;
    }
    if k < KEY_CLASH_BELOW {
        reasons.push("key_clash_echo".into());
        return Style::EchoOut;
    }
    if req.from.has_stems && req.to.has_stems {
        reasons.push("stems_available".into());
        return Style::StemSwap;
    }
    if k >= KEY_FITS_FROM {
        reasons.push("harmonic_long_blend".into());
        return Style::BassSwap;
    }
    reasons.push("short_filter_blend".into());
    Style::FilterSweep
}

/// Build a plan. `None` when the outgoing track has no tempo (nothing to align to).
pub fn plan_transition(req: &PlanRequest) -> Option<TransitionPlan> {
    // No tempo, nothing to align to.
    req.from.beat_sec()?;
    let mut reasons = Vec::new();
    let style = choose_style(req, &mut reasons);
    let a = req.from_deck;
    let b = req.to_deck;

    // Timing: next phrase (8 bars) from the downbeat-aligned grid, at least `not_before_bars` away.
    let now_beat = req.from.beat_at(req.from_pos_sec)?;
    let offset = f64::from(req.from.downbeat_offset);
    let phrase = 8.0 * BEATS_PER_BAR;
    let earliest = now_beat + f64::from(req.not_before_bars) * BEATS_PER_BAR;
    let total = req.from.total_beats().unwrap_or(f64::INFINITY);
    let mut start = ((earliest - offset) / phrase).ceil() * phrase + offset;
    let auto_bars = |remaining_beats: f64| -> u32 {
        if remaining_beats >= 16.0 * BEATS_PER_BAR + phrase {
            16
        } else {
            8
        }
    };
    let mut bars = req
        .bars
        .unwrap_or_else(|| auto_bars(total - earliest))
        .clamp(1, 64);
    if style == Style::Cut {
        bars = 1;
    }
    // Not enough track left for a phrase-aligned start: fall back to the next bar, and shorten.
    if start + f64::from(bars) * BEATS_PER_BAR > total {
        start = ((earliest - offset) / BEATS_PER_BAR).ceil() * BEATS_PER_BAR + offset;
        reasons.push("bar_aligned_short_track".into());
        let fit = ((total - start) / BEATS_PER_BAR).floor().max(1.0) as u32;
        if fit < bars {
            bars = fit;
            reasons.push("shortened_to_fit".into());
        }
    } else {
        reasons.push("phrase_aligned".into());
    }
    let len = f64::from(bars) * BEATS_PER_BAR;
    let to_cue_sec = req
        .to
        .time_of_beat(f64::from(req.to.downbeat_offset))
        .unwrap_or(req.to.first_beat_sec);
    let to_tempo_ratio = match (req.from.bpm, req.to.bpm) {
        (Some(x), Some(y)) if y > 0.0 => {
            let r = x / y;
            // Prefer the half/double-time match closest to 1.0.
            [r, r / 2.0, r * 2.0]
                .into_iter()
                .min_by(|p, q| (p - 1.0).abs().total_cmp(&(q - 1.0).abs()))
                .unwrap_or(1.0)
        }
        _ => 1.0,
    };

    let half = len / 2.0;
    let l = Curve::Linear;
    let s = Curve::Smooth;
    let st = Curve::Step;
    let mut lanes = Vec::new();
    let mut events = vec![TimedEvent {
        beat: 0.0,
        event: Event::Sync { deck: b },
    }];
    match style {
        Style::BassSwap => {
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Play { deck: b },
            });
            lanes.push(lane(
                Target::Volume { deck: b },
                vec![kf(0.0, 0.0, s), kf(half, 1.0, l)],
            ));
            lanes.push(lane(
                Target::Eq { deck: b, band: 0 },
                vec![kf(0.0, -26.0, st), kf(half, 0.0, l)],
            ));
            lanes.push(lane(
                Target::Eq { deck: a, band: 0 },
                vec![kf(0.0, 0.0, st), kf(half, -26.0, l)],
            ));
            lanes.push(lane(
                Target::Eq { deck: a, band: 2 },
                vec![kf(half, 0.0, l), kf(len, -12.0, l)],
            ));
            lanes.push(lane(
                Target::Volume { deck: a },
                vec![kf(half, 1.0, s), kf(len, 0.0, l)],
            ));
            events.push(TimedEvent {
                beat: len,
                event: Event::Pause { deck: a },
            });
        }
        Style::FilterSweep => {
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Play { deck: b },
            });
            lanes.push(lane(
                Target::Filter { deck: b },
                vec![kf(0.0, -0.8, l), kf(len * 0.75, 0.0, l)],
            ));
            lanes.push(lane(
                Target::Volume { deck: b },
                vec![kf(0.0, 0.0, s), kf(half, 1.0, l)],
            ));
            lanes.push(lane(
                Target::Filter { deck: a },
                vec![kf(half * 0.5, 0.0, l), kf(len, 0.8, l)],
            ));
            lanes.push(lane(
                Target::Volume { deck: a },
                vec![kf(half, 1.0, s), kf(len, 0.0, l)],
            ));
            events.push(TimedEvent {
                beat: len,
                event: Event::Pause { deck: a },
            });
        }
        Style::EchoOut => {
            // A echoes out over the first half; B starts dry on the half-way downbeat.
            let echo_end = half.max(BEATS_PER_BAR);
            lanes.push(lane(
                Target::EchoWet { deck: a },
                vec![kf(0.0, 0.0, l), kf(BEATS_PER_BAR, 0.7, l)],
            ));
            lanes.push(lane(
                Target::Volume { deck: a },
                vec![kf(BEATS_PER_BAR, 1.0, st), kf(BEATS_PER_BAR + 0.01, 0.0, l)],
            ));
            lanes.push(lane(
                Target::EchoWet { deck: a },
                vec![kf(echo_end, 0.7, l), kf(echo_end + BEATS_PER_BAR, 0.0, l)],
            ));
            lanes.push(lane(
                Target::Volume { deck: b },
                vec![kf(0.0, 0.0, st), kf(echo_end, 1.0, st)],
            ));
            events.retain(|e| !matches!(e.event, Event::Sync { .. }));
            events.push(TimedEvent {
                beat: echo_end,
                event: Event::Play { deck: b },
            });
            events.push(TimedEvent {
                beat: echo_end + BEATS_PER_BAR,
                event: Event::Pause { deck: a },
            });
        }
        Style::StemSwap => {
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Stems { deck: a, on: true },
            });
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Stems { deck: b, on: true },
            });
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Play { deck: b },
            });
            lanes.push(lane(Target::Volume { deck: b }, vec![kf(0.0, 1.0, st)]));
            // B: drums first, then bass on the half, melody after, vocal last.
            lanes.push(lane(
                Target::Stem { deck: b, stem: 1 },
                vec![kf(0.0, 0.0, l), kf(half * 0.5, 1.0, l)],
            ));
            lanes.push(lane(
                Target::Stem { deck: b, stem: 2 },
                vec![kf(0.0, 0.0, st), kf(half, 1.0, st)],
            ));
            lanes.push(lane(
                Target::Stem { deck: b, stem: 3 },
                vec![kf(0.0, 0.0, l), kf(len * 0.75, 1.0, l)],
            ));
            lanes.push(lane(
                Target::Stem { deck: b, stem: 0 },
                vec![kf(0.0, 0.0, st), kf(len, 1.0, st)],
            ));
            // A: drums out with B's drums in, bass swapped on the half, vocal rides to the end.
            lanes.push(lane(
                Target::Stem { deck: a, stem: 1 },
                vec![kf(0.0, 1.0, l), kf(half * 0.5, 0.0, l)],
            ));
            lanes.push(lane(
                Target::Stem { deck: a, stem: 2 },
                vec![kf(0.0, 1.0, st), kf(half, 0.0, st)],
            ));
            lanes.push(lane(
                Target::Stem { deck: a, stem: 3 },
                vec![kf(half, 1.0, l), kf(len * 0.75, 0.0, l)],
            ));
            lanes.push(lane(
                Target::Stem { deck: a, stem: 0 },
                vec![kf(len * 0.75, 1.0, l), kf(len, 0.0, l)],
            ));
            events.push(TimedEvent {
                beat: len,
                event: Event::Pause { deck: a },
            });
            events.push(TimedEvent {
                beat: len,
                event: Event::Stems { deck: b, on: false },
            });
        }
        Style::Cut => {
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Play { deck: b },
            });
            lanes.push(lane(Target::Volume { deck: b }, vec![kf(0.0, 1.0, st)]));
            lanes.push(lane(Target::Volume { deck: a }, vec![kf(0.0, 0.0, st)]));
            events.push(TimedEvent {
                beat: 0.0,
                event: Event::Pause { deck: a },
            });
        }
    }
    let mut automation = Automation {
        lanes,
        events,
        length_beats: len,
        echo_beats: 0.75,
    };
    automation.normalise();
    Some(TransitionPlan {
        style,
        bars,
        start_sec: req.from.time_of_beat(start)?,
        beats_until_start: start - now_beat,
        to_cue_sec,
        to_tempo_ratio,
        automation,
        reasons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::{AutoCmd, TransitionRunner};

    fn track(id: &str, bpm: f64, key: &str, dur: f64) -> TrackFeatures {
        TrackFeatures {
            id: id.into(),
            title: id.into(),
            bpm: Some(bpm),
            key: Some(key.into()),
            energy: Some(6),
            duration_sec: dur,
            first_beat_sec: 0.25,
            downbeat_offset: 0,
            ..Default::default()
        }
    }

    fn req(from: TrackFeatures, to: TrackFeatures, pos: f64) -> PlanRequest {
        PlanRequest {
            from,
            to,
            from_deck: 0,
            to_deck: 1,
            from_pos_sec: pos,
            bars: None,
            style: None,
            not_before_bars: 0,
        }
    }

    #[test]
    fn harmonic_pair_gets_a_phrase_aligned_bass_swap() {
        let p = plan_transition(&req(
            track("a", 128.0, "8A", 360.0),
            track("b", 126.0, "9A", 360.0),
            100.0,
        ))
        .unwrap();
        assert_eq!(p.style, Style::BassSwap);
        assert_eq!(p.bars, 16);
        let beat = 60.0 / 128.0;
        let start_beat = (p.start_sec - 0.25) / beat;
        assert!(
            (start_beat / 32.0 - (start_beat / 32.0).round()).abs() < 1e-9,
            "on an 8-bar phrase"
        );
        assert!(p.beats_until_start >= 0.0 && p.beats_until_start <= 32.0);
        assert!((p.to_tempo_ratio - 128.0 / 126.0).abs() < 1e-9);
        assert_eq!(p.automation.length_beats, 64.0);
        assert!(p.reasons.contains(&"phrase_aligned".to_string()));
    }

    #[test]
    fn bass_swap_never_has_both_basses_full_at_once() {
        let p = plan_transition(&req(
            track("a", 124.0, "8A", 400.0),
            track("b", 124.0, "8A", 400.0),
            30.0,
        ))
        .unwrap();
        let low = |deck: u8| {
            p.automation
                .lanes
                .iter()
                .find(|l| l.target == Target::Eq { deck, band: 0 })
                .unwrap()
                .clone()
        };
        let (la, lb) = (low(0), low(1));
        for i in 1..32 {
            let b = f64::from(i);
            let (va, vb) = (la.value_at(b).unwrap(), lb.value_at(b).unwrap());
            assert!(
                !(va > -3.0 && vb > -3.0),
                "both basses up at beat {b}: {va} / {vb}"
            );
        }
        assert_eq!(lb.value_at(0.0), Some(-26.0));
        assert_eq!(la.value_at(64.0), Some(-26.0));
        assert_eq!(lb.value_at(64.0), Some(0.0));
    }

    #[test]
    fn tempo_or_key_gaps_choose_echo_out_stems_choose_stem_swap() {
        let p = plan_transition(&req(
            track("a", 124.0, "8A", 400.0),
            track("b", 140.0, "8A", 400.0),
            30.0,
        ))
        .unwrap();
        assert_eq!(p.style, Style::EchoOut);
        assert!(p.reasons.contains(&"tempo_gap_echo".to_string()));
        let p = plan_transition(&req(
            track("a", 124.0, "8A", 400.0),
            track("b", 124.0, "2B", 400.0),
            30.0,
        ))
        .unwrap();
        assert_eq!(p.style, Style::EchoOut);
        let mut a = track("a", 124.0, "8A", 400.0);
        let mut b = track("b", 124.0, "9A", 400.0);
        a.has_stems = true;
        b.has_stems = true;
        let p = plan_transition(&req(a, b, 30.0)).unwrap();
        assert_eq!(p.style, Style::StemSwap);
        assert!(
            p.automation
                .lanes
                .iter()
                .any(|l| matches!(l.target, Target::Stem { deck: 1, stem: 2 }))
        );
        // Compatible but not close (energy boost +2): short filter blend.
        let p = plan_transition(&req(
            track("a", 124.0, "8A", 400.0),
            track("b", 124.0, "10A", 400.0),
            30.0,
        ))
        .unwrap();
        assert_eq!(p.style, Style::FilterSweep);
    }

    #[test]
    fn requested_style_and_length_win_and_short_tracks_are_shortened() {
        let mut r = req(
            track("a", 120.0, "8A", 400.0),
            track("b", 120.0, "8A", 400.0),
            30.0,
        );
        r.style = Some(Style::FilterSweep);
        r.bars = Some(32);
        let p = plan_transition(&r).unwrap();
        assert_eq!((p.style, p.bars), (Style::FilterSweep, 32));
        // 120 BPM: 2 s per bar. 10 s left -> no phrase fits, bar aligned, at most 4 bars.
        let r = req(
            track("a", 120.0, "8A", 100.25),
            track("b", 120.0, "8A", 400.0),
            90.25,
        );
        let p = plan_transition(&r).unwrap();
        assert!(p.bars <= 5, "bars {}", p.bars);
        assert!(p.reasons.contains(&"bar_aligned_short_track".to_string()));
        assert!(p.start_sec + f64::from(p.bars) * 2.0 <= 100.25 + 1e-9);
    }

    #[test]
    fn no_tempo_no_plan_and_cut_is_one_bar() {
        let mut a = track("a", 120.0, "8A", 300.0);
        a.bpm = None;
        assert!(plan_transition(&req(a, track("b", 120.0, "8A", 300.0), 10.0)).is_none());
        let mut r = req(
            track("a", 120.0, "8A", 300.0),
            track("b", 120.0, "8A", 300.0),
            10.0,
        );
        r.style = Some(Style::Cut);
        assert_eq!(plan_transition(&r).unwrap().bars, 1);
    }

    #[test]
    fn plan_runs_to_completion_through_the_runner() {
        let p = plan_transition(&req(
            track("a", 128.0, "8A", 360.0),
            track("b", 128.0, "8A", 360.0),
            60.0,
        ))
        .unwrap();
        let mut runner = TransitionRunner::new(p.automation.clone(), 1000.0);
        let mut cmds = Vec::new();
        let mut beat = 1000.0;
        while !runner.is_done() && beat < 1100.0 {
            cmds.extend(runner.tick(beat));
            beat += 0.25;
        }
        assert!(runner.is_done());
        assert!(cmds.contains(&AutoCmd::Event {
            event: Event::Play { deck: 1 }
        }));
        assert!(cmds.contains(&AutoCmd::Event {
            event: Event::Pause { deck: 0 }
        }));
        assert!(cmds.contains(&AutoCmd::Set {
            target: Target::Volume { deck: 0 },
            value: 0.0
        }));
        assert!(cmds.contains(&AutoCmd::Set {
            target: Target::Volume { deck: 1 },
            value: 1.0
        }));
    }
}
