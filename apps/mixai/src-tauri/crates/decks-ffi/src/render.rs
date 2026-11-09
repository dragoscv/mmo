//! [`DecksRenderer`]: `decks-render` GPU views headless or on a native surface.
//!
//! Native handles cross the FFI as `u64` pointers / ids. **Every surface constructor is unsafe
//! by contract** (UniFFI cannot express it): the handle must be valid now and stay valid until
//! the renderer is dropped (`destroy()` / `close()` from Kotlin, deinit from Swift). Drop it on
//! Android in `surfaceDestroyed`, on Apple when the view leaves the window.

use std::ffi::c_void;
use std::num::NonZeroIsize;
use std::ptr::NonNull;
use std::sync::Mutex;

use decks_render::{
    BandPeaks, DeckFrame, FrameState, Marker, MarkerKind, PeaksView, Rect, Renderer, Theme,
    ViewKind, ViewSpec, WaveStyle,
};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, AppKitDisplayHandle, AppKitWindowHandle,
    RawDisplayHandle, RawWindowHandle, UiKitDisplayHandle, UiKitWindowHandle, WaylandDisplayHandle,
    WaylandWindowHandle, Win32WindowHandle, WindowsDisplayHandle, XlibDisplayHandle,
    XlibWindowHandle,
};

use crate::dvs::ScopePoint;
use crate::engine::WaveformPeaks;
use crate::{DecksError, lock};

fn render_err(e: decks_render::RenderError) -> DecksError {
    DecksError::Render {
        reason: e.to_string(),
    }
}

fn non_null(name: &str, v: u64) -> Result<NonNull<c_void>, DecksError> {
    NonNull::new(v as usize as *mut c_void)
        .ok_or_else(|| DecksError::invalid(format!("{name} is null")))
}

// ---- records ----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RenderViewKind {
    /// Scrolling waveform with centred playhead, beat grid and markers.
    Waveform { deck: u8 },
    /// Whole-track overview.
    Overview { deck: u8 },
    /// 2–4 aligned waveforms with phase meters.
    Stacked { first: u8, count: u8 },
    /// Rotating platter / jog.
    Platter { deck: u8 },
    /// DVS X/Y scope.
    DvsScope { deck: u8 },
}

/// A view and its rectangle in logical pixels (points / dp).
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct RenderView {
    pub kind: RenderViewKind,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RenderWaveStyle {
    Rgb3Band,
    SingleColor,
    Spectral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RenderTheme {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RenderMarkerKind {
    Cue,
    HotCue { slot: u8 },
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct RenderMarker {
    pub kind: RenderMarkerKind,
    pub start_sec: f64,
    /// Loop end (ignored for point markers).
    pub end_sec: f64,
    /// `0xRRGGBB`.
    pub colour: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct RenderGrid {
    pub bpm: f64,
    /// Time of a downbeat (bar start), seconds.
    pub first_downbeat_sec: f64,
    pub beats_per_bar: u32,
}

/// Per-deck frame data.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct DeckFrameState {
    pub loaded: bool,
    pub playhead_sec: f64,
    pub slip_playhead_sec: Option<f64>,
    pub duration_sec: f64,
    pub grid: Option<RenderGrid>,
    pub markers: Vec<RenderMarker>,
    /// 33.333 by default.
    pub platter_rpm: f32,
    /// From `DvsInput.scope_points` (empty when no DVS).
    pub dvs_scope: Vec<ScopePoint>,
}

/// Everything that changes per frame.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RenderFrameState {
    /// Index = deck (0..4).
    pub decks: Vec<DeckFrameState>,
    /// Seconds visible across a scrolling waveform.
    pub zoom_seconds: f32,
    pub style: RenderWaveStyle,
    pub theme: RenderTheme,
    pub reduced_motion: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct RendererInfo {
    pub adapter: String,
    pub backend: String,
    pub width: u32,
    pub height: u32,
}

// ---- object -----------------------------------------------------------------------------

/// Reused per-deck buffers so `update` does not reallocate every frame.
#[derive(Default)]
struct DeckScratch {
    markers: Vec<Marker>,
    scope: Vec<[f32; 2]>,
}

struct RenderState {
    renderer: Renderer,
    scratch: [DeckScratch; 4],
}

/// GPU deck views. Thread-safe behind one lock; call from the UI / render thread.
#[derive(uniffi::Object)]
pub struct DecksRenderer {
    state: Mutex<RenderState>,
}

impl DecksRenderer {
    fn wrap(renderer: Renderer) -> Self {
        Self {
            state: Mutex::new(RenderState {
                renderer,
                scratch: Default::default(),
            }),
        }
    }

    fn surface(
        window: RawWindowHandle,
        display: RawDisplayHandle,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        // SAFETY: validity of the handles until drop is the documented contract of every
        // public surface constructor (see the module docs and docs/decks/ffi.md).
        let r = unsafe { Renderer::new_from_raw_handle(window, display, (width, height), scale) }
            .map_err(render_err)?;
        Ok(Self::wrap(r))
    }
}

#[uniffi::export]
impl DecksRenderer {
    /// Offscreen `Rgba8Unorm` renderer (snapshots, tests, hosts that composite textures).
    #[uniffi::constructor]
    pub fn new_headless(width: u32, height: u32) -> Result<Self, DecksError> {
        Renderer::new_headless((width, height))
            .map(Self::wrap)
            .map_err(render_err)
    }

    /// Apple: `view_ptr` = an `NSView` (macOS) or `UIView` (iOS / iPadOS) whose layer is a
    /// `CAMetalLayer` (e.g. `Unmanaged.passUnretained(view).toOpaque()`); `uikit` selects
    /// UIKit. wgpu creates its Metal surface on that layer.
    ///
    /// Unsafe contract: the view must outlive the renderer.
    #[uniffi::constructor]
    pub fn from_metal_layer(
        view_ptr: u64,
        uikit: bool,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        let view = non_null("view_ptr", view_ptr)?;
        let (w, d) = if uikit {
            (
                RawWindowHandle::UiKit(UiKitWindowHandle::new(view)),
                RawDisplayHandle::UiKit(UiKitDisplayHandle::new()),
            )
        } else {
            (
                RawWindowHandle::AppKit(AppKitWindowHandle::new(view)),
                RawDisplayHandle::AppKit(AppKitDisplayHandle::new()),
            )
        };
        Self::surface(w, d, width, height, scale)
    }

    /// Android: `native_window` = `ANativeWindow*` from `ANativeWindow_fromSurface` (JNI) for a
    /// `SurfaceView`'s surface.
    ///
    /// Unsafe contract: keep the window acquired until the renderer is dropped
    /// (`surfaceDestroyed`), then `ANativeWindow_release` it.
    #[uniffi::constructor]
    pub fn from_android_surface(
        native_window: u64,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        let w = non_null("native_window", native_window)?;
        Self::surface(
            RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(w)),
            RawDisplayHandle::Android(AndroidDisplayHandle::new()),
            width,
            height,
            scale,
        )
    }

    /// Windows: `hwnd` (+ optional `hinstance`, 0 = none) of a child window (Compose Desktop
    /// `SwingPanel` / AWT canvas via JAWT).
    ///
    /// Unsafe contract: the window must outlive the renderer.
    #[uniffi::constructor]
    pub fn from_win32(
        hwnd: u64,
        hinstance: u64,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        let h = NonZeroIsize::new(hwnd as isize).ok_or_else(|| DecksError::invalid("hwnd is 0"))?;
        let mut handle = Win32WindowHandle::new(h);
        handle.hinstance = NonZeroIsize::new(hinstance as isize);
        Self::surface(
            RawWindowHandle::Win32(handle),
            RawDisplayHandle::Windows(WindowsDisplayHandle::new()),
            width,
            height,
            scale,
        )
    }

    /// X11: `display` = `Display*` (Xlib), `window` = XID, `screen` = screen number.
    ///
    /// Unsafe contract: the display connection and window must outlive the renderer.
    #[uniffi::constructor]
    pub fn from_xlib(
        display: u64,
        window: u64,
        screen: i32,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        if window == 0 {
            return Err(DecksError::invalid("window is 0"));
        }
        let d = non_null("display", display)?;
        Self::surface(
            RawWindowHandle::Xlib(XlibWindowHandle::new(window as _)),
            RawDisplayHandle::Xlib(XlibDisplayHandle::new(Some(d), screen)),
            width,
            height,
            scale,
        )
    }

    /// Wayland: `display` = `wl_display*`, `surface` = `wl_surface*`.
    ///
    /// Unsafe contract: both must outlive the renderer.
    #[uniffi::constructor]
    pub fn from_wayland(
        display: u64,
        surface: u64,
        width: u32,
        height: u32,
        scale: f32,
    ) -> Result<Self, DecksError> {
        let d = non_null("display", display)?;
        let s = non_null("surface", surface)?;
        Self::surface(
            RawWindowHandle::Wayland(WaylandWindowHandle::new(s)),
            RawDisplayHandle::Wayland(WaylandDisplayHandle::new(d)),
            width,
            height,
            scale,
        )
    }

    pub fn info(&self) -> RendererInfo {
        let s = lock(&self.state);
        let a = s.renderer.adapter_info();
        let (width, height) = s.renderer.size();
        RendererInfo {
            adapter: a.name.clone(),
            backend: format!("{:?}", a.backend),
            width,
            height,
        }
    }

    /// Resize (physical pixels) and set the logical→physical scale.
    pub fn resize(&self, width: u32, height: u32, scale: f32) {
        lock(&self.state).renderer.resize((width, height), scale);
    }

    /// Replace the view layout (max 32 views).
    pub fn set_views(&self, views: Vec<RenderView>) {
        let specs: Vec<ViewSpec> = views
            .iter()
            .map(|v| ViewSpec {
                kind: match v.kind {
                    RenderViewKind::Waveform { deck } => ViewKind::Waveform { deck },
                    RenderViewKind::Overview { deck } => ViewKind::Overview { deck },
                    RenderViewKind::Stacked { first, count } => ViewKind::Stacked { first, count },
                    RenderViewKind::Platter { deck } => ViewKind::Platter { deck },
                    RenderViewKind::DvsScope { deck } => ViewKind::DvsScope { deck },
                },
                rect: Rect::new(v.x, v.y, v.w, v.h),
            })
            .collect();
        lock(&self.state).renderer.set_views(&specs);
    }

    /// Upload a deck's peaks (on track load, not per frame).
    pub fn set_peaks(&self, deck: u8, peaks: WaveformPeaks) -> Result<(), DecksError> {
        if deck > 3 {
            return Err(DecksError::invalid(format!(
                "deck {deck} out of range 0..=3"
            )));
        }
        let n = peaks.len as usize;
        let lanes = [
            &peaks.low_min,
            &peaks.low_max,
            &peaks.low_rms,
            &peaks.mid_min,
            &peaks.mid_max,
            &peaks.mid_rms,
            &peaks.high_min,
            &peaks.high_max,
            &peaks.high_rms,
        ];
        if lanes.iter().any(|l| l.len() < n) {
            return Err(DecksError::invalid("a peaks lane is shorter than len"));
        }
        let view = PeaksView {
            points_per_second: peaks.points_per_second as f32,
            low: BandPeaks {
                min: &peaks.low_min[..n],
                max: &peaks.low_max[..n],
                rms: &peaks.low_rms[..n],
            },
            mid: BandPeaks {
                min: &peaks.mid_min[..n],
                max: &peaks.mid_max[..n],
                rms: &peaks.mid_rms[..n],
            },
            high: BandPeaks {
                min: &peaks.high_min[..n],
                max: &peaks.high_max[..n],
                rms: &peaks.high_rms[..n],
            },
        };
        lock(&self.state).renderer.set_peaks(deck as usize, &view);
        Ok(())
    }

    /// Prepare the next frame.
    pub fn update(&self, frame: RenderFrameState) {
        let mut s = lock(&self.state);
        let RenderState { renderer, scratch } = &mut *s;
        for (i, sc) in scratch.iter_mut().enumerate() {
            sc.markers.clear();
            sc.scope.clear();
            if let Some(d) = frame.decks.get(i) {
                sc.markers.extend(d.markers.iter().map(|m| Marker {
                    kind: match m.kind {
                        RenderMarkerKind::Cue => MarkerKind::Cue,
                        RenderMarkerKind::HotCue { slot } => MarkerKind::HotCue(slot),
                        RenderMarkerKind::Loop => MarkerKind::Loop,
                    },
                    start_s: m.start_sec,
                    end_s: m.end_sec,
                    color: decks_render::colors::hex(m.colour & 0x00FF_FFFF),
                }));
                sc.scope.extend(d.dvs_scope.iter().map(|p| [p.x, p.y]));
            }
        }
        let mut decks = [DeckFrame::default(); 4];
        let n = frame.decks.len().min(4);
        for (i, df) in decks.iter_mut().enumerate().take(n) {
            let d = &frame.decks[i];
            *df = DeckFrame {
                loaded: d.loaded,
                playhead_s: d.playhead_sec,
                slip_playhead_s: d.slip_playhead_sec,
                duration_s: d.duration_sec,
                grid: d.grid.map(|g| decks_render::BeatGrid {
                    bpm: g.bpm,
                    first_downbeat_s: g.first_downbeat_sec,
                    beats_per_bar: g.beats_per_bar.max(1),
                }),
                markers: &scratch[i].markers,
                platter_rpm: d.platter_rpm,
                dvs_scope: &scratch[i].scope,
            };
        }
        let state = FrameState {
            decks: &decks[..n],
            zoom_seconds: frame.zoom_seconds,
            style: match frame.style {
                RenderWaveStyle::Rgb3Band => WaveStyle::Rgb3Band,
                RenderWaveStyle::SingleColor => WaveStyle::SingleColor,
                RenderWaveStyle::Spectral => WaveStyle::Spectral,
            },
            theme: match frame.theme {
                RenderTheme::Dark => Theme::Dark,
                RenderTheme::Light => Theme::Light,
            },
            reduced_motion: frame.reduced_motion,
        };
        renderer.update(&state);
    }

    /// Draw the prepared frame (present on surfaces, keep in the texture headless).
    pub fn render(&self) -> Result<(), DecksError> {
        lock(&self.state).renderer.render().map_err(render_err)
    }

    /// Headless only: tightly packed RGBA8 rows (`None` for surface renderers).
    pub fn read_pixels(&self) -> Option<Vec<u8>> {
        lock(&self.state).renderer.read_pixels()
    }
}
