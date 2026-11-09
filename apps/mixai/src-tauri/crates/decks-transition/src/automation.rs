//! Editable automation: lanes of keyframes in beats (relative to the transition start), plus a
//! runner that samples them against the master beat and emits only changed values.

use serde::{Deserialize, Serialize};

/// What a lane drives. `deck` is the engine deck index (0..3).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    /// Channel fader 0..1.
    Volume { deck: u8 },
    /// EQ band dB (−26..+6); band 0 = low, 1 = mid, 2 = high.
    Eq { deck: u8, band: u8 },
    /// Bipolar filter −1..1.
    Filter { deck: u8 },
    /// Stem gain 0..1.5; stem 0 vocals, 1 drums, 2 bass, 3 melody.
    Stem { deck: u8, stem: u8 },
    /// Beat FX wet 0..1 (echo); `beats` = echo length.
    EchoWet { deck: u8 },
}

impl Target {
    pub fn deck(&self) -> u8 {
        match *self {
            Target::Volume { deck }
            | Target::Eq { deck, .. }
            | Target::Filter { deck }
            | Target::Stem { deck, .. }
            | Target::EchoWet { deck } => deck,
        }
    }

    /// Valid value range.
    pub fn range(&self) -> (f32, f32) {
        match self {
            Target::Volume { .. } | Target::EchoWet { .. } => (0.0, 1.0),
            Target::Eq { .. } => (-26.0, 6.0),
            Target::Filter { .. } => (-1.0, 1.0),
            Target::Stem { .. } => (0.0, 1.5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Curve {
    /// Straight line to the next keyframe.
    #[default]
    Linear,
    /// Equal-power style ease (sine).
    Smooth,
    /// Hold this value until the next keyframe, then jump.
    Step,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Keyframe {
    /// Beats from the transition start.
    pub beat: f64,
    pub value: f32,
    /// Shape from this keyframe to the next.
    #[serde(default)]
    pub curve: Curve,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lane {
    pub target: Target,
    /// Sorted by beat (enforced by [`Automation::normalise`]).
    pub keys: Vec<Keyframe>,
}

impl Lane {
    /// Value at `beat` (clamped to the first / last keyframe outside the range).
    pub fn value_at(&self, beat: f64) -> Option<f32> {
        let first = self.keys.first()?;
        if beat <= first.beat {
            return Some(first.value);
        }
        for w in self.keys.windows(2) {
            let (a, b) = (w[0], w[1]);
            if beat < b.beat {
                let span = (b.beat - a.beat).max(1e-9);
                let t = ((beat - a.beat) / span).clamp(0.0, 1.0);
                let t = match a.curve {
                    Curve::Linear => t,
                    Curve::Smooth => 0.5 - 0.5 * (std::f64::consts::PI * t).cos(),
                    Curve::Step => 0.0,
                };
                return Some(a.value + (b.value - a.value) * t as f32);
            }
        }
        self.keys.last().map(|k| k.value)
    }
}

/// A one-shot event at a beat.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    /// Start the incoming deck (already beat-synced by the app).
    Play {
        deck: u8,
    },
    Pause {
        deck: u8,
    },
    /// Phase sync + lock the incoming deck.
    Sync {
        deck: u8,
    },
    /// Turn stems playback on / off for a deck.
    Stems {
        deck: u8,
        on: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimedEvent {
    pub beat: f64,
    #[serde(flatten)]
    pub event: Event,
}

/// The full automation of a transition. Serialises as JSON so the user can save / tweak / share it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Automation {
    pub lanes: Vec<Lane>,
    pub events: Vec<TimedEvent>,
    /// Length in beats.
    pub length_beats: f64,
    /// Echo length for [`Target::EchoWet`] lanes.
    #[serde(default = "default_echo")]
    pub echo_beats: f64,
}

fn default_echo() -> f64 {
    0.75
}

impl Automation {
    /// Sort keys / events, clamp values to each target's range, drop empty lanes, merge lanes with
    /// the same target (later wins on equal beats).
    pub fn normalise(&mut self) {
        let mut merged: Vec<Lane> = Vec::new();
        for lane in self.lanes.drain(..) {
            match merged.iter_mut().find(|l| l.target == lane.target) {
                Some(l) => l.keys.extend(lane.keys),
                None => merged.push(lane),
            }
        }
        for l in &mut merged {
            let (lo, hi) = l.target.range();
            l.keys.retain(|k| k.beat.is_finite() && k.value.is_finite());
            for k in &mut l.keys {
                k.value = k.value.clamp(lo, hi);
                k.beat = k.beat.max(0.0);
            }
            l.keys.sort_by(|a, b| a.beat.total_cmp(&b.beat));
            l.keys.dedup_by(|later, earlier| {
                if (later.beat - earlier.beat).abs() < 1e-9 {
                    *earlier = *later;
                    true
                } else {
                    false
                }
            });
        }
        merged.retain(|l| !l.keys.is_empty());
        self.lanes = merged;
        self.events.retain(|e| e.beat.is_finite());
        self.events.sort_by(|a, b| a.beat.total_cmp(&b.beat));
        let end = self
            .lanes
            .iter()
            .filter_map(|l| l.keys.last().map(|k| k.beat))
            .chain(self.events.iter().map(|e| e.beat))
            .fold(0.0_f64, f64::max);
        self.length_beats = self.length_beats.max(end);
    }

    /// Edit: set (or insert) a keyframe on `target`.
    pub fn set_key(&mut self, target: Target, beat: f64, value: f32, curve: Curve) {
        match self.lanes.iter_mut().find(|l| l.target == target) {
            Some(l) => l.keys.push(Keyframe { beat, value, curve }),
            None => self.lanes.push(Lane {
                target,
                keys: vec![Keyframe { beat, value, curve }],
            }),
        }
        self.normalise();
    }

    /// Edit: stretch or squeeze the whole transition to `beats` (keeps the shape).
    pub fn retime(&mut self, beats: f64) {
        if self.length_beats <= 0.0 || beats <= 0.0 {
            return;
        }
        let f = beats / self.length_beats;
        for l in &mut self.lanes {
            for k in &mut l.keys {
                k.beat *= f;
            }
        }
        for e in &mut self.events {
            e.beat *= f;
        }
        self.length_beats = beats;
    }
}

/// An engine command produced by the runner (the app maps each to a `DecksEngine` call).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum AutoCmd {
    Set {
        target: Target,
        value: f32,
    },
    Event {
        event: Event,
    },
    /// Configure the echo before its wet lane starts.
    EchoSetup {
        deck: u8,
        beats: f64,
    },
    Done,
}

/// Plays an [`Automation`] from `start_beat` (master clock beats).
#[derive(Debug, Clone)]
pub struct TransitionRunner {
    pub automation: Automation,
    pub start_beat: f64,
    last: Vec<Option<f32>>,
    next_event: usize,
    echo_ready: Vec<u8>,
    done: bool,
    /// Smallest change worth sending.
    pub epsilon: f32,
}

impl TransitionRunner {
    pub fn new(mut automation: Automation, start_beat: f64) -> Self {
        automation.normalise();
        let n = automation.lanes.len();
        Self {
            automation,
            start_beat,
            last: vec![None; n],
            next_event: 0,
            echo_ready: Vec::new(),
            done: false,
            epsilon: 0.002,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    /// Commands for the current master beat. Call at UI rate; before `start_beat` nothing happens.
    pub fn tick(&mut self, master_beat: f64) -> Vec<AutoCmd> {
        if self.done {
            return Vec::new();
        }
        let rel = master_beat - self.start_beat;
        let mut out = Vec::new();
        if rel < 0.0 {
            return out;
        }
        while let Some(e) = self.automation.events.get(self.next_event) {
            if e.beat > rel {
                break;
            }
            out.push(AutoCmd::Event { event: e.event });
            self.next_event += 1;
        }
        for (i, lane) in self.automation.lanes.iter().enumerate() {
            if let Target::EchoWet { deck } = lane.target {
                if !self.echo_ready.contains(&deck) {
                    self.echo_ready.push(deck);
                    out.push(AutoCmd::EchoSetup {
                        deck,
                        beats: self.automation.echo_beats,
                    });
                }
            }
            let Some(v) = lane.value_at(rel) else {
                continue;
            };
            let changed = self.last[i].is_none_or(|p| (p - v).abs() >= self.epsilon);
            if changed {
                self.last[i] = Some(v);
                out.push(AutoCmd::Set {
                    target: lane.target,
                    value: v,
                });
            }
        }
        if rel >= self.automation.length_beats {
            // Land exactly on the final values.
            for (i, lane) in self.automation.lanes.iter().enumerate() {
                if let Some(k) = lane.keys.last() {
                    if self.last[i] != Some(k.value) {
                        self.last[i] = Some(k.value);
                        out.push(AutoCmd::Set {
                            target: lane.target,
                            value: k.value,
                        });
                    }
                }
            }
            out.push(AutoCmd::Done);
            self.done = true;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane(target: Target, keys: &[(f64, f32, Curve)]) -> Lane {
        Lane {
            target,
            keys: keys
                .iter()
                .map(|&(beat, value, curve)| Keyframe { beat, value, curve })
                .collect(),
        }
    }

    #[test]
    fn interpolation_curves() {
        let l = lane(
            Target::Volume { deck: 0 },
            &[
                (0.0, 0.0, Curve::Linear),
                (8.0, 1.0, Curve::Step),
                (16.0, 0.0, Curve::Linear),
            ],
        );
        assert_eq!(l.value_at(-1.0), Some(0.0));
        assert_eq!(l.value_at(4.0), Some(0.5));
        assert_eq!(l.value_at(12.0), Some(1.0), "step holds");
        assert_eq!(l.value_at(20.0), Some(0.0));
        let s = lane(
            Target::Volume { deck: 0 },
            &[(0.0, 0.0, Curve::Smooth), (4.0, 1.0, Curve::Linear)],
        );
        assert!((s.value_at(2.0).unwrap() - 0.5).abs() < 1e-6);
        assert!(s.value_at(1.0).unwrap() < 0.25, "ease-in at the start");
    }

    #[test]
    fn normalise_sorts_clamps_merges_and_sets_length() {
        let mut a = Automation {
            lanes: vec![
                lane(
                    Target::Eq { deck: 1, band: 0 },
                    &[(8.0, 10.0, Curve::Linear), (0.0, -90.0, Curve::Linear)],
                ),
                lane(
                    Target::Eq { deck: 1, band: 0 },
                    &[(8.0, -3.0, Curve::Linear)],
                ),
                lane(Target::Filter { deck: 0 }, &[]),
            ],
            events: vec![TimedEvent {
                beat: 12.0,
                event: Event::Pause { deck: 0 },
            }],
            length_beats: 0.0,
            echo_beats: 0.75,
        };
        a.normalise();
        assert_eq!(a.lanes.len(), 1, "empty lane dropped, same target merged");
        let k = &a.lanes[0].keys;
        assert_eq!(k.len(), 2);
        assert_eq!(k[0].value, -26.0);
        assert_eq!(k[1].value, -3.0, "later keyframe wins at the same beat");
        assert_eq!(a.length_beats, 12.0);
    }

    #[test]
    fn edits_set_key_and_retime() {
        let mut a = Automation::default();
        a.set_key(Target::Volume { deck: 1 }, 0.0, 0.0, Curve::Linear);
        a.set_key(Target::Volume { deck: 1 }, 32.0, 1.0, Curve::Linear);
        assert_eq!(a.length_beats, 32.0);
        a.retime(16.0);
        assert_eq!(a.lanes[0].keys[1].beat, 16.0);
        assert_eq!(a.lanes[0].value_at(8.0), Some(0.5));
        let json = serde_json::to_string(&a).unwrap();
        let back: Automation = serde_json::from_str(&json).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn runner_emits_changes_events_and_lands_on_final_values() {
        let a = Automation {
            lanes: vec![
                lane(
                    Target::Volume { deck: 1 },
                    &[(0.0, 0.0, Curve::Linear), (4.0, 1.0, Curve::Linear)],
                ),
                lane(
                    Target::EchoWet { deck: 0 },
                    &[(0.0, 0.0, Curve::Linear), (4.0, 0.6, Curve::Linear)],
                ),
            ],
            events: vec![TimedEvent {
                beat: 0.0,
                event: Event::Play { deck: 1 },
            }],
            length_beats: 4.0,
            echo_beats: 0.5,
        };
        let mut r = TransitionRunner::new(a, 100.0);
        assert!(r.tick(99.0).is_empty(), "nothing before the start");
        let first = r.tick(100.0);
        assert!(first.contains(&AutoCmd::Event {
            event: Event::Play { deck: 1 }
        }));
        assert!(first.contains(&AutoCmd::EchoSetup {
            deck: 0,
            beats: 0.5
        }));
        assert!(first.contains(&AutoCmd::Set {
            target: Target::Volume { deck: 1 },
            value: 0.0
        }));
        assert!(r.tick(100.0).is_empty(), "unchanged values are not re-sent");
        let mid = r.tick(102.0);
        assert!(mid.contains(&AutoCmd::Set {
            target: Target::Volume { deck: 1 },
            value: 0.5
        }));
        let end = r.tick(104.5);
        assert!(end.contains(&AutoCmd::Set {
            target: Target::Volume { deck: 1 },
            value: 1.0
        }));
        assert_eq!(end.last(), Some(&AutoCmd::Done));
        assert!(r.is_done());
        assert!(r.tick(110.0).is_empty());
    }
}
