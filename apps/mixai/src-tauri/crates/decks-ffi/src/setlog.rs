//! Set recording + automatic tracklist (`decks-setlog`, WP19-22).
//!
//! `SetRecorder::start(engine, wav_path)` starts the master recording and a tracklist logger; call
//! `observe(engine)` from the UI tick with the library labels set per deck; `stop()` returns the
//! final entries; exports produce text, CUE (with ISRC), ORDA / UCMR-ADA CSV, Mixcloud sections, M3U8.

use std::sync::Mutex;
use std::time::Instant;

use decks_setlog as sl;

use crate::{DecksEngine, DecksError, lock};

/// Library labels for the track on a deck (title / artist / ISRC come from `DecksLibrary`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SetTrackLabel {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub isrc: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TracklistEntry {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub isrc: Option<String>,
    pub deck: u8,
    pub start_sec: f64,
    pub played_sec: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum TracklistFormat {
    Text,
    Cue,
    OrdaUcmrCsv,
    MixcloudSections,
    M3u8,
}

struct State {
    logger: sl::SetLogger,
    labels: Vec<Option<sl::TrackRef>>,
    started: Instant,
    wav_path: String,
    recording: bool,
}

/// One recorded set.
#[derive(uniffi::Object)]
pub struct SetRecorder {
    state: Mutex<State>,
}

fn entries_out(v: Vec<sl::Entry>) -> Vec<TracklistEntry> {
    v.into_iter()
        .map(|e| TracklistEntry {
            id: e.track.id,
            title: e.track.title,
            artist: e.track.artist,
            isrc: e.track.isrc,
            deck: e.deck,
            start_sec: e.start_sec,
            played_sec: e.played_sec,
        })
        .collect()
}

fn entries_in(v: &[TracklistEntry]) -> Vec<sl::Entry> {
    v.iter()
        .map(|e| sl::Entry {
            track: sl::TrackRef {
                id: e.id.clone(),
                title: e.title.clone(),
                artist: e.artist.clone(),
                isrc: e.isrc.clone(),
                path: None,
            },
            deck: e.deck,
            start_sec: e.start_sec,
            played_sec: e.played_sec,
        })
        .collect()
}

/// Render a tracklist (also usable on an edited list). `wav_file`, `set_title`, `dj` feed the CUE sheet.
#[uniffi::export]
pub fn tracklist_export(
    entries: Vec<TracklistEntry>,
    format: TracklistFormat,
    wav_file: String,
    set_title: String,
    dj: String,
) -> String {
    let e = entries_in(&entries);
    match format {
        TracklistFormat::Text => sl::export::text(&e),
        TracklistFormat::Cue => sl::export::cue_sheet(&e, &wav_file, &set_title, &dj),
        TracklistFormat::OrdaUcmrCsv => sl::export::orda_ucmr_csv(&e),
        TracklistFormat::MixcloudSections => sl::export::mixcloud_sections(&e),
        TracklistFormat::M3u8 => sl::export::m3u8(&e),
    }
}

impl SetRecorder {
    /// Logger only, no audio (tests and replays).
    pub fn new_detached() -> Self {
        Self {
            state: Mutex::new(State {
                logger: sl::SetLogger::default(),
                labels: vec![None; 4],
                started: Instant::now(),
                wav_path: String::new(),
                recording: false,
            }),
        }
    }

    /// Feed a deck observation at an explicit time (tests / replays).
    pub fn observe_at(&self, t_sec: f64, decks: &[(u8, bool, f32)], crossfader: f32) {
        let mut s = lock(&self.state);
        let obs: Vec<sl::DeckObs> = decks
            .iter()
            .map(|&(d, playing, volume)| sl::DeckObs {
                deck: d,
                playing,
                volume,
                track: s.labels.get(d as usize).cloned().flatten(),
            })
            .collect();
        s.logger.observe(t_sec, &obs, crossfader);
    }
}

#[uniffi::export]
impl SetRecorder {
    /// Start recording the master to `wav_path` and logging the tracklist. Fails when the engine is stopped.
    #[uniffi::constructor]
    pub fn start(engine: &DecksEngine, wav_path: String) -> Result<Self, DecksError> {
        engine.record_start(wav_path.clone())?;
        let r = Self::new_detached();
        {
            let mut s = lock(&r.state);
            s.wav_path = wav_path;
            s.recording = true;
        }
        Ok(r)
    }

    /// Label the track loaded on `deck` (call on load; `None` clears it).
    pub fn set_label(&self, deck: u8, label: Option<SetTrackLabel>) -> Result<(), DecksError> {
        if deck > 3 {
            return Err(DecksError::invalid(format!(
                "deck {deck} out of range 0..=3"
            )));
        }
        lock(&self.state).labels[deck as usize] = label.map(|l| sl::TrackRef {
            id: l.id,
            title: l.title,
            artist: l.artist,
            isrc: l.isrc,
            path: l.path,
        });
        Ok(())
    }

    /// Sample the engine (UI tick, a few Hz is enough).
    pub fn observe(&self, engine: &DecksEngine) {
        let snap = engine.snapshot();
        let t = lock(&self.state).started.elapsed().as_secs_f64();
        let decks: Vec<(u8, bool, f32)> = snap
            .decks
            .iter()
            .map(|d| (d.deck, d.playing, d.volume))
            .collect();
        self.observe_at(t, &decks, snap.crossfader);
    }

    pub fn entries(&self) -> Vec<TracklistEntry> {
        entries_out(lock(&self.state).logger.entries())
    }

    /// Remove a wrongly detected entry (its time goes to the previous one).
    pub fn remove_entry(&self, index: u32) -> bool {
        lock(&self.state).logger.remove(index as usize)
    }

    pub fn elapsed_sec(&self) -> f64 {
        lock(&self.state).started.elapsed().as_secs_f64()
    }

    pub fn wav_path(&self) -> String {
        lock(&self.state).wav_path.clone()
    }

    /// Stop the recording (if any) and close the tracklist. Idempotent.
    pub fn stop(&self, engine: &DecksEngine) -> Vec<TracklistEntry> {
        let mut s = lock(&self.state);
        if s.recording {
            let _ = engine.record_stop();
            s.recording = false;
        }
        let t = s.started.elapsed().as_secs_f64();
        s.logger.stop(t);
        entries_out(s.logger.entries())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DecksEngineConfig;

    fn label(id: &str) -> SetTrackLabel {
        SetTrackLabel {
            id: id.into(),
            title: format!("T{id}"),
            artist: format!("A{id}"),
            isrc: Some("USUM70912345".into()),
            path: None,
        }
    }

    #[test]
    fn detached_logger_builds_and_exports_a_tracklist() {
        let r = SetRecorder::new_detached();
        r.set_label(0, Some(label("a"))).unwrap();
        r.set_label(1, Some(label("b"))).unwrap();
        assert!(r.set_label(4, None).is_err());
        for t in 0..=200 {
            let x = if t < 100 { -1.0 } else { 1.0 };
            r.observe_at(f64::from(t), &[(0, true, 1.0), (1, true, 1.0)], x);
        }
        let e = r.entries();
        assert_eq!(e.len(), 2);
        assert_eq!((e[1].id.as_str(), e[1].start_sec), ("b", 100.0));
        let cue = tracklist_export(
            e.clone(),
            TracklistFormat::Cue,
            "set.wav".into(),
            "Set".into(),
            "DJ".into(),
        );
        assert!(cue.contains("INDEX 01 01:40:00"));
        assert!(cue.contains("ISRC USUM70912345"));
        let csv = tracklist_export(
            e,
            TracklistFormat::OrdaUcmrCsv,
            String::new(),
            String::new(),
            String::new(),
        );
        assert!(csv.starts_with("Nr,Titlu,Artist,ISRC,Start"));
    }

    #[test]
    fn start_needs_a_running_engine_and_stop_is_idempotent() {
        let engine = DecksEngine::new(DecksEngineConfig::default());
        assert!(SetRecorder::start(&engine, "x.wav".into()).is_err());
        let r = SetRecorder::new_detached();
        r.observe(&engine);
        assert!(r.stop(&engine).is_empty());
        assert!(r.stop(&engine).is_empty());
    }
}
