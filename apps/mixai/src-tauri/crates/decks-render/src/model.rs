//! Input data: peaks, per-frame deck state and view layout.

use crate::colors::{Rgba, Theme};

/// Peaks of one frequency band, one value per point.
///
/// Encoding (u8): `min` and `max` map `0..=255` to `-1.0..=1.0` (`v / 127.5 - 1`, so 128 ≈ 0),
/// `rms` maps `0..=255` to `0.0..=1.0`.
#[derive(Clone, Copy, Debug, Default)]
pub struct BandPeaks<'a> {
    /// Lowest sample per point.
    pub min: &'a [u8],
    /// Highest sample per point.
    pub max: &'a [u8],
    /// RMS per point.
    pub rms: &'a [u8],
}

/// Three-band peaks of a whole track at `points_per_second` (as produced by the analysis crate;
/// this crate does not depend on it — copy the slices in).
#[derive(Clone, Copy, Debug, Default)]
pub struct PeaksView<'a> {
    /// Points per second of audio.
    pub points_per_second: f32,
    /// Low band (bass).
    pub low: BandPeaks<'a>,
    /// Mid band.
    pub mid: BandPeaks<'a>,
    /// High band.
    pub high: BandPeaks<'a>,
}

impl PeaksView<'_> {
    /// Number of usable points (the shortest of the nine arrays).
    pub fn len(&self) -> usize {
        [&self.low, &self.mid, &self.high]
            .iter()
            .flat_map(|b| [b.min.len(), b.max.len(), b.rms.len()])
            .min()
            .unwrap_or(0)
    }

    /// True when there is nothing to draw.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Waveform colouring.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum WaveStyle {
    /// Three nested bands (low / mid / high), each in its own colour.
    #[default]
    Rgb3Band,
    /// One shape in the deck colour.
    SingleColor,
    /// One shape coloured by spectral balance (bass red → treble blue).
    Spectral,
}

impl WaveStyle {
    pub(crate) fn code(self) -> f32 {
        match self {
            Self::Rgb3Band => 0.0,
            Self::SingleColor => 1.0,
            Self::Spectral => 2.0,
        }
    }
}

/// Beat grid of a deck.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatGrid {
    /// Tempo, beats per minute (> 0).
    pub bpm: f64,
    /// Time of a downbeat (bar start), seconds. Earlier beats are extrapolated.
    pub first_downbeat_s: f64,
    /// Beats per bar (4 for most dance music).
    pub beats_per_bar: u32,
}

/// What a marker is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkerKind {
    /// Main cue point.
    Cue,
    /// Numbered hot cue.
    HotCue(u8),
    /// Loop region from `start_s` to `end_s`.
    Loop,
}

/// Cue / hot cue / loop marker.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Marker {
    /// Kind.
    pub kind: MarkerKind,
    /// Position (loop start), seconds.
    pub start_s: f64,
    /// Loop end, seconds (ignored for point markers).
    pub end_s: f64,
    /// Marker colour.
    pub color: Rgba,
}

/// Per-deck state for one frame. Slices are borrowed: building a frame allocates nothing.
#[derive(Clone, Copy, Debug)]
pub struct DeckFrame<'a> {
    /// Whether a track is loaded (empty decks draw only their panel).
    pub loaded: bool,
    /// Audible playhead, seconds.
    pub playhead_s: f64,
    /// Slip-mode shadow playhead (where playback resumes), seconds.
    pub slip_playhead_s: Option<f64>,
    /// Track duration, seconds.
    pub duration_s: f64,
    /// Beat grid, if analysed.
    pub grid: Option<BeatGrid>,
    /// Cue, hot cue and loop markers.
    pub markers: &'a [Marker],
    /// Platter speed in revolutions per minute (33⅓ default).
    pub platter_rpm: f32,
    /// DVS scope points (X/Y in -1..1, oldest first); drawn by [`ViewKind::DvsScope`].
    pub dvs_scope: &'a [[f32; 2]],
}

impl Default for DeckFrame<'_> {
    fn default() -> Self {
        Self {
            loaded: false,
            playhead_s: 0.0,
            slip_playhead_s: None,
            duration_s: 0.0,
            grid: None,
            markers: &[],
            platter_rpm: 100.0 / 3.0,
            dvs_scope: &[],
        }
    }
}

/// Everything that changes per frame.
#[derive(Clone, Copy, Debug)]
pub struct FrameState<'a> {
    /// Deck states, index = deck id (0..4). Missing decks count as unloaded.
    pub decks: &'a [DeckFrame<'a>],
    /// Seconds visible across a scrolling waveform (zoom).
    pub zoom_seconds: f32,
    /// Waveform colouring.
    pub style: WaveStyle,
    /// Light / dark theme.
    pub theme: Theme,
    /// Reduced motion: no smooth scrolling or rotation, content moves in steps.
    pub reduced_motion: bool,
}

impl Default for FrameState<'_> {
    fn default() -> Self {
        Self {
            decks: &[],
            zoom_seconds: 8.0,
            style: WaveStyle::default(),
            theme: Theme::default(),
            reduced_motion: false,
        }
    }
}

/// Rectangle in logical pixels (points / dp), origin top-left.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    /// Left.
    pub x: f32,
    /// Top.
    pub y: f32,
    /// Width.
    pub w: f32,
    /// Height.
    pub h: f32,
}

impl Rect {
    /// New rectangle.
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub(crate) fn scaled(self, s: f32) -> Self {
        Self::new(self.x * s, self.y * s, self.w * s, self.h * s)
    }
}

/// A view drawn by the renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewKind {
    /// Scrolling waveform of one deck with centred playhead, beat grid and markers.
    Waveform {
        /// Deck index 0..4.
        deck: u8,
    },
    /// Whole-track overview with played-region dimming and hot cues.
    Overview {
        /// Deck index 0..4.
        deck: u8,
    },
    /// 2–4 parallel waveforms, playheads aligned, with phase meters against deck 0 of the stack.
    Stacked {
        /// First deck index.
        first: u8,
        /// Number of decks (2..=4).
        count: u8,
    },
    /// Rotating platter / jog wheel.
    Platter {
        /// Deck index 0..4.
        deck: u8,
    },
    /// DVS X/Y Lissajous scope.
    DvsScope {
        /// Deck index 0..4.
        deck: u8,
    },
}

/// A view and where it goes on the surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewSpec {
    /// What to draw.
    pub kind: ViewKind,
    /// Where, in logical pixels.
    pub rect: Rect,
}
