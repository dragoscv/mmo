//! Flexible beatgrid editing + encoder-drift over FFI (WP19-37).
//!
//! A beatgrid is a first beat, a tempo and a (possibly empty) list of **tempo-change markers**:
//! `(sec, bpm)` pairs meaning "from here on the tempo is `bpm`". `fixed` is the fixed-grid
//! toggle: the deck plays the constant `bpm` + first-beat grid while the markers are kept.
//!
//! Flow for the native shells:
//! `track_grid(library, track_id)` → edit with `grid_set_fixed` / `grid_add_marker` /
//! `grid_move_marker` / `grid_remove_marker` (each returns the new [`GridState`] and writes it
//! back to the library) → `grid_apply_to_deck(engine, deck, grid)` to hear it.
//! `drift_check(path, source)` reports the MP3 priming offset of another app's times.

use std::sync::Arc;

use decks_library::drift::{self, SourceApp};
use mixai_core::{BeatGrid as CoreGrid, TempoMarker};

use crate::{BeatGridInfo, DecksEngine, DecksError, DecksLibrary, LibraryGrid, TempoAnchorInfo};

/// One tempo-change marker of a track's beatgrid.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct GridMarker {
    /// Position in seconds of decoded audio.
    pub sec: f64,
    /// Tempo from here on.
    pub bpm: f64,
    /// Beat number (from the first beat) this marker falls on, rounded.
    pub beat: u32,
}

/// A track's editable beatgrid.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct GridState {
    /// Library track id (empty for a deck-only grid).
    pub track_id: String,
    /// Tempo from the first beat to the first marker.
    pub bpm: f64,
    pub first_beat_sec: f64,
    /// 0..3, position of the first beat inside its bar.
    pub downbeat_offset: u8,
    /// Fixed-grid toggle: markers kept but ignored.
    pub fixed: bool,
    /// Tempo changes, in time order (empty for a constant grid).
    pub markers: Vec<GridMarker>,
}

/// What `drift_check` found for one file.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DriftReport {
    pub path: String,
    /// Seconds to add to the other app's cue / grid times (negative = earlier, 0 = nothing to do).
    pub shift_sec: f64,
    /// `A`, `B`, `C` or `D` of the MP3 priming classification; empty for non-MP3 files.
    pub mp3_case: String,
    /// LAME / Lavc encoder string of the Xing tag (empty when absent).
    pub encoder: String,
    /// Encoder delay in samples reported by the LAME tag.
    pub encoder_delay_samples: u32,
    /// One line per assumption; unconfirmed ones say so and contribute 0.
    pub reason: String,
    /// False when the file is not an MP3 we can read (nothing to correct).
    pub analysed: bool,
}

/// Which application's decoder produced the times being checked.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, uniffi::Enum)]
pub enum DriftSource {
    Rekordbox,
    Serato,
    Traktor,
    EngineDj,
    MixAi,
    #[default]
    Unknown,
}

impl From<DriftSource> for SourceApp {
    fn from(s: DriftSource) -> Self {
        match s {
            DriftSource::Rekordbox => SourceApp::Rekordbox,
            DriftSource::Serato => SourceApp::Serato,
            DriftSource::Traktor => SourceApp::Traktor,
            DriftSource::EngineDj => SourceApp::EngineDj,
            DriftSource::MixAi => SourceApp::MixAi,
            DriftSource::Unknown => SourceApp::Unknown,
        }
    }
}

// ---- conversions ------------------------------------------------------------------------

fn finite(name: &str, v: f64) -> Result<f64, DecksError> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(DecksError::invalid(format!("{name} must be finite")))
    }
}

fn positive_bpm(v: f64) -> Result<f64, DecksError> {
    crate::engine::checked_bpm("bpm", v)
}

impl GridState {
    /// Every tempo in range (20..400) and every time finite and non-negative. Called on every
    /// path that can reach a deck or the library, so no out-of-range value is ever silently
    /// dropped (WP19-37 P1-9).
    pub(crate) fn check(&self) -> Result<(), DecksError> {
        positive_bpm(self.bpm)?;
        crate::engine::checked_sec("first_beat_sec", self.first_beat_sec)?;
        for (i, m) in self.markers.iter().enumerate() {
            crate::engine::checked_bpm(&format!("markers[{i}].bpm"), m.bpm)?;
            crate::engine::checked_sec(&format!("markers[{i}].sec"), m.sec)?;
        }
        Ok(())
    }

    fn from_library(track_id: &str, g: &LibraryGrid) -> Self {
        let core = CoreGrid::from_markers(g.bpm, g.first_beat_sec, &markers_of(g), false);
        let markers = core
            .markers()
            .into_iter()
            .map(|m| GridMarker {
                sec: m.sec,
                bpm: m.bpm,
                beat: core.beat_at(m.sec).round().max(0.0) as u32,
            })
            .collect();
        Self {
            track_id: track_id.to_owned(),
            bpm: core.start_bpm(),
            first_beat_sec: g.first_beat_sec,
            downbeat_offset: g.downbeat_offset % 4,
            fixed: g.fixed,
            markers,
        }
    }

    fn to_library(&self) -> LibraryGrid {
        LibraryGrid {
            bpm: self.bpm,
            first_beat_sec: self.first_beat_sec,
            downbeat_offset: self.downbeat_offset % 4,
            anchors: self
                .markers
                .iter()
                .map(|m| crate::LibraryGridAnchor {
                    sec: m.sec,
                    bpm: m.bpm,
                })
                .collect(),
            fixed: self.fixed,
        }
    }

    /// Deck beatgrid for this state (what `grid_apply_to_deck` sends to the engine).
    pub fn to_beatgrid_info(&self) -> BeatGridInfo {
        // `is_variable` = the grid HAS tempo changes; `fixed` decides whether the engine uses
        // them. The anchors are carried either way so the toggle is reversible on the deck.
        let variable = !self.markers.is_empty();
        let mut anchors = Vec::with_capacity(self.markers.len() + 1);
        if variable {
            anchors.push(TempoAnchorInfo {
                beat_index: 0,
                time_sec: self.first_beat_sec,
                bpm: self.bpm,
            });
            anchors.extend(self.markers.iter().map(|m| TempoAnchorInfo {
                beat_index: m.beat,
                time_sec: m.sec,
                bpm: m.bpm,
            }));
        }
        BeatGridInfo {
            bpm: self.bpm,
            confidence: 0.0,
            first_beat_sec: self.first_beat_sec,
            downbeat_offset_beats: self.downbeat_offset % 4,
            downbeat_confidence: 0.0,
            is_variable: variable,
            anchors,
            beats: Vec::new(),
            fixed: self.fixed,
        }
    }

    /// Re-derive the marker list (sorted, merged, beat numbers refreshed) after an edit.
    fn renormalise(mut self) -> Self {
        let core = CoreGrid::from_markers(
            self.bpm,
            self.first_beat_sec,
            &self
                .markers
                .iter()
                .map(|m| TempoMarker {
                    sec: m.sec,
                    bpm: m.bpm,
                })
                .collect::<Vec<_>>(),
            false,
        );
        self.bpm = core.start_bpm();
        self.markers = core
            .markers()
            .into_iter()
            .map(|m| GridMarker {
                sec: m.sec,
                bpm: m.bpm,
                beat: core.beat_at(m.sec).round().max(0.0) as u32,
            })
            .collect();
        self
    }
}

fn markers_of(g: &LibraryGrid) -> Vec<TempoMarker> {
    g.anchors
        .iter()
        .map(|a| TempoMarker {
            sec: a.sec,
            bpm: a.bpm,
        })
        .collect()
}

// ---- library-backed editing -------------------------------------------------------------

fn load(library: &DecksLibrary, track_id: &str) -> Result<GridState, DecksError> {
    let grid = library
        .with(|l| l.grid(track_id))?
        .ok_or_else(|| DecksError::NotFound {
            reason: format!("no beatgrid for track {track_id}"),
        })?;
    Ok(GridState::from_library(
        track_id,
        &LibraryGrid {
            bpm: grid.bpm,
            first_beat_sec: grid.first_beat_sec,
            downbeat_offset: grid.downbeat_offset,
            anchors: grid
                .anchors
                .iter()
                .map(|a| crate::LibraryGridAnchor {
                    sec: a.sec,
                    bpm: a.bpm,
                })
                .collect(),
            fixed: grid.fixed,
        },
    ))
}

fn store(library: &DecksLibrary, state: GridState) -> Result<GridState, DecksError> {
    let state = state.renormalise();
    state.check()?;
    let g = state.to_library();
    let lib_grid = decks_library::BeatGrid {
        bpm: g.bpm,
        first_beat_sec: g.first_beat_sec,
        downbeat_offset: g.downbeat_offset,
        anchors: g
            .anchors
            .iter()
            .map(|a| decks_library::GridAnchor {
                sec: a.sec,
                bpm: a.bpm,
            })
            .collect(),
        fixed: g.fixed,
    };
    let id = state.track_id.clone();
    library.with(|l| l.set_grid(&id, &lib_grid))?;
    Ok(state)
}

/// The editable beatgrid of a library track (`NotFound` when the track has no grid yet).
#[uniffi::export]
pub fn track_grid(library: &DecksLibrary, track_id: String) -> Result<GridState, DecksError> {
    load(library, &track_id)
}

/// Just the tempo-change markers of a library track.
#[uniffi::export]
pub fn track_grid_markers(
    library: &DecksLibrary,
    track_id: String,
) -> Result<Vec<GridMarker>, DecksError> {
    Ok(load(library, &track_id)?.markers)
}

/// Turn the fixed-grid toggle on or off (the markers are kept either way).
#[uniffi::export]
pub fn grid_set_fixed(
    library: &DecksLibrary,
    track_id: String,
    fixed: bool,
) -> Result<GridState, DecksError> {
    let mut s = load(library, &track_id)?;
    s.fixed = fixed;
    store(library, s)
}

/// Move the whole grid: new first beat and starting tempo (markers keep their times).
#[uniffi::export]
pub fn grid_set_base(
    library: &DecksLibrary,
    track_id: String,
    bpm: f64,
    first_beat_sec: f64,
    downbeat_offset: u8,
) -> Result<GridState, DecksError> {
    let mut s = load(library, &track_id)?;
    s.bpm = positive_bpm(bpm)?;
    s.first_beat_sec = crate::engine::checked_sec("first_beat_sec", first_beat_sec)?;
    s.downbeat_offset = downbeat_offset % 4;
    store(library, s)
}

/// Add a tempo change at `sec` (replaces a marker within 1 ms of it).
#[uniffi::export]
pub fn grid_add_marker(
    library: &DecksLibrary,
    track_id: String,
    sec: f64,
    bpm: f64,
) -> Result<GridState, DecksError> {
    let mut s = load(library, &track_id)?;
    let sec = crate::engine::checked_sec("sec", sec)?;
    let bpm = positive_bpm(bpm)?;
    if sec <= s.first_beat_sec + 1e-9 {
        s.bpm = bpm;
    } else {
        s.markers.retain(|m| (m.sec - sec).abs() > 1e-3);
        s.markers.push(GridMarker { sec, bpm, beat: 0 });
    }
    store(library, s)
}

/// Move and/or retune the marker nearest to `at_sec` (within `tolerance_sec`).
#[uniffi::export]
pub fn grid_move_marker(
    library: &DecksLibrary,
    track_id: String,
    at_sec: f64,
    new_sec: f64,
    new_bpm: Option<f64>,
    tolerance_sec: f64,
) -> Result<GridState, DecksError> {
    let mut s = load(library, &track_id)?;
    let at = finite("at_sec", at_sec)?;
    let new_sec = crate::engine::checked_sec("new_sec", new_sec)?;
    let tol = finite("tolerance_sec", tolerance_sec)?.abs().max(1e-3);
    let i = nearest(&s.markers, at, tol)?;
    s.markers[i].sec = new_sec;
    if let Some(b) = new_bpm {
        s.markers[i].bpm = positive_bpm(b)?;
    }
    store(library, s)
}

/// Delete the marker nearest to `at_sec` (within `tolerance_sec`).
#[uniffi::export]
pub fn grid_remove_marker(
    library: &DecksLibrary,
    track_id: String,
    at_sec: f64,
    tolerance_sec: f64,
) -> Result<GridState, DecksError> {
    let mut s = load(library, &track_id)?;
    let at = finite("at_sec", at_sec)?;
    let tol = finite("tolerance_sec", tolerance_sec)?.abs().max(1e-3);
    let i = nearest(&s.markers, at, tol)?;
    s.markers.remove(i);
    store(library, s)
}

fn nearest(markers: &[GridMarker], at: f64, tol: f64) -> Result<usize, DecksError> {
    markers
        .iter()
        .enumerate()
        .filter(|(_, m)| (m.sec - at).abs() <= tol)
        .min_by(|a, b| (a.1.sec - at).abs().total_cmp(&(b.1.sec - at).abs()))
        .map(|(i, _)| i)
        .ok_or_else(|| DecksError::NotFound {
            reason: format!("no tempo marker within {tol} s of {at} s"),
        })
}

// ---- decks ------------------------------------------------------------------------------

/// Hand a grid to a loaded deck (same path as `DecksEngine.set_beatgrid`).
///
/// Every marker is range-checked here, not just the base tempo: `GridState` is a plain record
/// the foreign side builds, so a marker at 1e-300 or 1e308 BPM would otherwise reach the audio
/// thread and make `beat_at` return `NaN` (WP19-37 P1-9).
#[uniffi::export]
pub fn grid_apply_to_deck(
    engine: Arc<DecksEngine>,
    deck: u8,
    grid: GridState,
) -> Result<(), DecksError> {
    grid.check()?;
    engine.set_beatgrid(deck, grid.to_beatgrid_info())
}

/// The grid of a loaded deck as an editable [`GridState`] (`NotFound` when the deck has none).
#[uniffi::export]
pub fn deck_grid(engine: Arc<DecksEngine>, deck: u8) -> Result<GridState, DecksError> {
    let info = engine.beatgrid(deck)?.ok_or_else(|| DecksError::NotFound {
        reason: format!("deck {deck} has no beatgrid"),
    })?;
    let g = info.to_library();
    Ok(GridState::from_library(
        "",
        &LibraryGrid {
            bpm: g.bpm,
            first_beat_sec: g.first_beat_sec,
            downbeat_offset: g.downbeat_offset,
            anchors: g
                .anchors
                .iter()
                .map(|a| crate::LibraryGridAnchor {
                    sec: a.sec,
                    bpm: a.bpm,
                })
                .collect(),
            fixed: g.fixed,
        },
    ))
}

// ---- drift ------------------------------------------------------------------------------

/// MP3 priming offset of `path` for times written by `source` (see `docs/decks/beatgrid.md`).
/// Never fails: a non-MP3 or unreadable file comes back with `analysed = false` and shift 0.
#[uniffi::export]
pub fn drift_check(path: String, source: DriftSource) -> DriftReport {
    let app: SourceApp = source.into();
    let p = drift::probe_mp3(std::path::Path::new(&path));
    match (p, drift::drift_shift(std::path::Path::new(&path), app)) {
        (Some(p), Some(fix)) => DriftReport {
            path,
            shift_sec: fix.shift_sec,
            mp3_case: p.case.as_str().to_owned(),
            encoder: p.encoder,
            encoder_delay_samples: p.enc_delay,
            reason: fix.reason,
            analysed: true,
        },
        _ => DriftReport {
            path,
            shift_sec: 0.0,
            mp3_case: String::new(),
            encoder: String::new(),
            encoder_delay_samples: 0,
            reason: "not an mp3 we can read; nothing to correct".to_owned(),
            analysed: false,
        },
    }
}
