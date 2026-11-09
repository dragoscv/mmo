//! CPU side of a frame: turns [`FrameState`] + view layout into GPU instance arrays.
//!
//! Everything here writes into vectors allocated once in [`Scene::new`]; building a frame never
//! allocates (proved by `alloc_tests.rs`). Excess shapes are dropped and counted, not grown.

use std::f64::consts::TAU;

use crate::colors::{DECK_COLORS, Palette, Rgba, with_alpha};
use crate::model::{DeckFrame, FrameState, Marker, MarkerKind, Rect, ViewKind, ViewSpec};

/// Instanced quads per frame (underlay + overlay).
pub(crate) const MAX_SHAPES: usize = 16_384;
/// Waveform rectangles per frame (a stacked view uses up to 4).
pub(crate) const MAX_WAVES: usize = 32;
/// Views per renderer.
pub(crate) const MAX_VIEWS: usize = 32;
/// DVS scope points drawn per scope view (newest kept).
pub(crate) const MAX_SCOPE_POINTS: usize = 2_048;
/// Beat lines per waveform (zoomed far out the grid is capped).
const MAX_LINES_PER_VIEW: i64 = 1_024;

pub(crate) const SHAPE_SOLID: f32 = 0.0;
pub(crate) const SHAPE_PLATTER: f32 = 1.0;
pub(crate) const SHAPE_DOT: f32 = 2.0;

/// One instanced quad: rect in physical px, colour, `params.x` = shape kind.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Shape {
    pub rect: [f32; 4],
    pub color: [f32; 4],
    pub params: [f32; 4],
}

/// Per waveform rectangle, read by the fragment shader (std430 stride 64).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct WaveGpu {
    /// x, y, w, h in physical px.
    pub rect: [f32; 4],
    /// t_left seconds, seconds per px, points per second, unused.
    pub t: [f32; 4],
    /// peaks offset (points), point count, style code, unused.
    pub info: [u32; 4],
    /// Deck colour.
    pub color: [f32; 4],
}

/// Where a deck's peaks live in the GPU peaks buffer.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct PeaksSlot {
    pub offset: u32,
    pub count: u32,
    pub pps: f32,
}

#[derive(Clone, Copy)]
enum Layer {
    Under,
    Over,
}

pub(crate) struct Scene {
    pub under: Vec<Shape>,
    pub over: Vec<Shape>,
    pub waves: Vec<WaveGpu>,
    pub wave_rects: Vec<[f32; 4]>,
    pub dropped: usize,
    pub palette: Palette,
}

fn snap(r: Rect) -> Rect {
    let x0 = r.x.round();
    let y0 = r.y.round();
    Rect::new(x0, y0, (r.x + r.w).round() - x0, (r.y + r.h).round() - y0)
}

fn clip(r: Rect, c: Rect) -> Option<Rect> {
    let x0 = r.x.max(c.x);
    let y0 = r.y.max(c.y);
    let x1 = (r.x + r.w).min(c.x + c.w);
    let y1 = (r.y + r.h).min(c.y + c.h);
    (x1 > x0 && y1 > y0).then(|| Rect::new(x0, y0, x1 - x0, y1 - y0))
}

/// Beat phase in 0..1 of `t` on `grid`.
fn beat_phase(t: f64, bpm: f64, first: f64) -> f64 {
    ((t - first) * bpm / 60.0).rem_euclid(1.0)
}

impl Scene {
    pub fn new() -> Self {
        Self {
            under: Vec::with_capacity(MAX_SHAPES),
            over: Vec::with_capacity(MAX_SHAPES),
            waves: Vec::with_capacity(MAX_WAVES),
            wave_rects: Vec::with_capacity(MAX_WAVES),
            dropped: 0,
            palette: Palette::for_theme(Default::default()),
        }
    }

    fn push(&mut self, layer: Layer, s: Shape) {
        if self.under.len() + self.over.len() >= MAX_SHAPES {
            self.dropped += 1;
            return;
        }
        match layer {
            Layer::Under => self.under.push(s),
            Layer::Over => self.over.push(s),
        }
    }

    /// Solid rect, snapped to whole pixels and clipped to `c`.
    fn rect(&mut self, layer: Layer, r: Rect, color: Rgba, c: Rect) {
        if let Some(r) = clip(snap(r), c) {
            self.push(
                layer,
                Shape {
                    rect: [r.x, r.y, r.w, r.h],
                    color,
                    params: [SHAPE_SOLID, 0.0, 0.0, 0.0],
                },
            );
        }
    }

    fn vline(&mut self, x: f32, width: f32, r: Rect, color: Rgba) {
        let x0 = x - (width * 0.5).floor();
        self.rect(Layer::Over, Rect::new(x0, r.y, width, r.h), color, r);
    }

    pub fn build(
        &mut self,
        views: &[ViewSpec],
        st: &FrameState<'_>,
        slots: &[PeaksSlot; 4],
        scale: f32,
    ) {
        self.under.clear();
        self.over.clear();
        self.waves.clear();
        self.wave_rects.clear();
        self.dropped = 0;
        self.palette = Palette::for_theme(st.theme);
        for v in views {
            let r = snap(v.rect.scaled(scale));
            if r.w < 1.0 || r.h < 1.0 {
                continue;
            }
            match v.kind {
                ViewKind::Waveform { deck } => {
                    self.waveform_lane(r, deck as usize, st, slots, scale);
                }
                ViewKind::Overview { deck } => self.overview(r, deck as usize, st, slots, scale),
                ViewKind::Stacked { first, count } => {
                    self.stacked(r, first as usize, count as usize, st, slots, scale)
                }
                ViewKind::Platter { deck } => self.platter(r, deck as usize, st),
                ViewKind::DvsScope { deck } => self.scope(r, deck as usize, st, scale),
            }
        }
    }

    fn push_wave(
        &mut self,
        r: Rect,
        t_left: f64,
        spp: f64,
        slot: PeaksSlot,
        st: &FrameState<'_>,
        deck: usize,
    ) {
        if self.waves.len() >= MAX_WAVES || slot.count == 0 || slot.pps <= 0.0 {
            return;
        }
        self.waves.push(WaveGpu {
            rect: [r.x, r.y, r.w, r.h],
            t: [t_left as f32, spp as f32, slot.pps, 0.0],
            info: [slot.offset, slot.count, st.style.code() as u32, 0],
            color: DECK_COLORS[deck & 3],
        });
        self.wave_rects.push([r.x, r.y, r.w, r.h]);
    }

    /// Scrolling waveform. Returns `(t_left, seconds per px)` when a track is drawn.
    fn waveform_lane(
        &mut self,
        r: Rect,
        deck: usize,
        st: &FrameState<'_>,
        slots: &[PeaksSlot; 4],
        scale: f32,
    ) -> Option<(f64, f64)> {
        let p = self.palette;
        self.rect(Layer::Under, r, p.panel, r);
        let d = st.decks.get(deck).copied().unwrap_or_default();
        if !d.loaded || deck >= 4 {
            return None;
        }
        let spp = f64::from(st.zoom_seconds.max(0.05)) / f64::from(r.w);
        let (t_left, ph_x) = if st.reduced_motion {
            // Page mode: the waveform stands still, the playhead walks and the page flips.
            let page = spp * f64::from(r.w);
            let t_left = (d.playhead_s / page).floor() * page;
            (t_left, r.x + ((d.playhead_s - t_left) / spp).round() as f32)
        } else {
            // Centred playhead; content scrolls by whole pixels so lines never shimmer.
            let c = f64::from((r.w * 0.5).floor());
            ((d.playhead_s / spp - c).round() * spp, r.x + c as f32)
        };
        self.push_wave(r, t_left, spp, slots[deck], st, deck);
        self.grid_lines(r, &d, t_left, spp, scale);
        self.markers(r, d.markers, t_left, spp, scale);
        let pw = (2.0 * scale).round().max(2.0);
        if let Some(s) = d.slip_playhead_s {
            let x = ph_x + ((s - d.playhead_s) / spp).round() as f32;
            self.vline(x, pw, r, with_alpha(p.playhead, 0.45));
        }
        self.vline(ph_x, pw, r, p.playhead);
        let cap = (6.0 * scale).round();
        let ch = (3.0 * scale).round();
        let cx = ph_x - (cap * 0.5).floor();
        self.rect(Layer::Over, Rect::new(cx, r.y, cap, ch), p.playhead, r);
        self.rect(
            Layer::Over,
            Rect::new(cx, r.y + r.h - ch, cap, ch),
            p.playhead,
            r,
        );
        Some((t_left, spp))
    }

    fn grid_lines(&mut self, r: Rect, d: &DeckFrame<'_>, t_left: f64, spp: f64, scale: f32) {
        let Some(g) = d.grid.filter(|g| g.bpm > 1.0) else {
            return;
        };
        let p = self.palette;
        let bl = 60.0 / g.bpm;
        let t_right = t_left + spp * f64::from(r.w);
        let k0 = ((t_left - g.first_downbeat_s) / bl).ceil() as i64;
        let k1 = ((t_right - g.first_downbeat_s) / bl).floor() as i64;
        let bpb = i64::from(g.beats_per_bar.max(1));
        let wb = scale.round().max(1.0);
        let wd = (2.0 * scale).round().max(2.0);
        for k in k0..=k1.min(k0 + MAX_LINES_PER_VIEW) {
            let t = g.first_downbeat_s + k as f64 * bl;
            if t < 0.0 || (d.duration_s > 0.0 && t > d.duration_s) {
                continue;
            }
            let x = r.x + ((t - t_left) / spp).round() as f32;
            if k.rem_euclid(bpb) == 0 {
                self.vline(x, wd, r, p.downbeat);
            } else {
                self.vline(x, wb, r, p.beat);
            }
        }
    }

    fn markers(&mut self, r: Rect, markers: &[Marker], t_left: f64, spp: f64, scale: f32) {
        let lw = (2.0 * scale).round().max(2.0);
        let sq = (7.0 * scale).round();
        for m in markers {
            let xa = r.x + ((m.start_s - t_left) / spp).round() as f32;
            match m.kind {
                MarkerKind::Loop => {
                    let xb = r.x + ((m.end_s - t_left) / spp).round() as f32;
                    self.rect(
                        Layer::Over,
                        Rect::new(xa, r.y, xb - xa, r.h),
                        with_alpha(m.color, 0.22),
                        r,
                    );
                    self.rect(Layer::Over, Rect::new(xa, r.y, lw * 0.5, r.h), m.color, r);
                    self.rect(
                        Layer::Over,
                        Rect::new(xb - lw * 0.5, r.y, lw * 0.5, r.h),
                        m.color,
                        r,
                    );
                }
                MarkerKind::Cue | MarkerKind::HotCue(_) => {
                    self.vline(xa, lw, r, with_alpha(m.color, 0.9));
                    self.rect(Layer::Over, Rect::new(xa, r.y, sq, sq), m.color, r);
                    if m.kind == MarkerKind::Cue {
                        self.rect(
                            Layer::Over,
                            Rect::new(xa, r.y + r.h - sq, sq, sq),
                            m.color,
                            r,
                        );
                    }
                }
            }
        }
    }

    fn overview(
        &mut self,
        r: Rect,
        deck: usize,
        st: &FrameState<'_>,
        slots: &[PeaksSlot; 4],
        scale: f32,
    ) {
        let p = self.palette;
        self.rect(Layer::Under, r, p.panel, r);
        let d = st.decks.get(deck).copied().unwrap_or_default();
        if !d.loaded || deck >= 4 {
            return;
        }
        let slot = slots[deck];
        let dur = if d.duration_s > 0.0 {
            d.duration_s
        } else {
            f64::from(slot.count) / f64::from(slot.pps.max(1.0))
        };
        if dur <= 0.0 {
            return;
        }
        let spp = dur / f64::from(r.w);
        self.push_wave(r, 0.0, spp, slot, st, deck);
        let ph_x = r.x + (d.playhead_s.clamp(0.0, dur) / spp).round() as f32;
        // Played region dimmed (drawn before markers so hot cues stay bright).
        self.rect(
            Layer::Over,
            Rect::new(r.x, r.y, ph_x - r.x, r.h),
            with_alpha(p.background, 0.55),
            r,
        );
        self.markers(r, d.markers, 0.0, spp, scale);
        self.vline(ph_x, (2.0 * scale).round().max(2.0), r, p.playhead);
    }

    fn stacked(
        &mut self,
        r: Rect,
        first: usize,
        count: usize,
        st: &FrameState<'_>,
        slots: &[PeaksSlot; 4],
        scale: f32,
    ) {
        let n = count.clamp(2, 4).min(4usize.saturating_sub(first)).max(1);
        let gap = (2.0 * scale).round();
        let lane_h = ((r.h - gap * (n as f32 - 1.0)) / n as f32).floor();
        if lane_h < 4.0 {
            return;
        }
        let reference = st.decks.get(first).copied().unwrap_or_default();
        let mh = (4.0 * scale).round().max(2.0);
        for i in 0..n {
            let lane = Rect::new(r.x, r.y + i as f32 * (lane_h + gap), r.w, lane_h);
            let deck = first + i;
            self.waveform_lane(lane, deck, st, slots, scale);
            if i == 0 {
                continue;
            }
            let d = st.decks.get(deck).copied().unwrap_or_default();
            let (Some(g0), Some(gi)) = (reference.grid, d.grid) else {
                continue;
            };
            if !(reference.loaded && d.loaded) || g0.bpm <= 1.0 || gi.bpm <= 1.0 {
                continue;
            }
            // Phase offset against the first deck, in beats, wrapped to -0.5..0.5.
            let diff = beat_phase(d.playhead_s, gi.bpm, gi.first_downbeat_s)
                - beat_phase(reference.playhead_s, g0.bpm, g0.first_downbeat_s);
            let diff = (diff - diff.round()) as f32;
            let p = self.palette;
            let my = lane.y + lane.h - mh;
            self.rect(Layer::Over, Rect::new(lane.x, my, lane.w, mh), p.grid, lane);
            let cx = lane.x + (lane.w * 0.5).floor();
            let len = diff * lane.w;
            let (x0, w) = if len < 0.0 {
                (cx + len, -len)
            } else {
                (cx, len)
            };
            self.rect(
                Layer::Over,
                Rect::new(x0, my, w.max(1.0), mh),
                DECK_COLORS[deck & 3],
                lane,
            );
            self.rect(
                Layer::Over,
                Rect::new(cx - 1.0, my - mh, 2.0, mh * 2.0),
                p.playhead,
                lane,
            );
        }
    }

    fn platter(&mut self, r: Rect, deck: usize, st: &FrameState<'_>) {
        let d = st.decks.get(deck).copied().unwrap_or_default();
        let side = r.w.min(r.h);
        let sq = snap(Rect::new(
            r.x + (r.w - side) * 0.5,
            r.y + (r.h - side) * 0.5,
            side,
            side,
        ));
        let mut angle = if d.loaded {
            (d.playhead_s * f64::from(d.platter_rpm) / 60.0).rem_euclid(1.0) * TAU
        } else {
            0.0
        };
        if st.reduced_motion {
            let step = TAU / 12.0;
            angle = (angle / step).round() * step;
        }
        self.push(
            Layer::Under,
            Shape {
                rect: [sq.x, sq.y, sq.w, sq.h],
                color: DECK_COLORS[deck & 3],
                params: [
                    SHAPE_PLATTER,
                    angle as f32,
                    if d.loaded { 1.0 } else { 0.0 },
                    0.0,
                ],
            },
        );
    }

    fn scope(&mut self, r: Rect, deck: usize, st: &FrameState<'_>, scale: f32) {
        let p = self.palette;
        self.rect(Layer::Under, r, p.panel, r);
        let d = st.decks.get(deck).copied().unwrap_or_default();
        let pad = (6.0 * scale).round();
        let side = (r.w.min(r.h) - 2.0 * pad).max(2.0);
        let half = (side * 0.5).floor();
        let cx = (r.x + r.w * 0.5).floor();
        let cy = (r.y + r.h * 0.5).floor();
        let lw = scale.round().max(1.0);
        self.rect(
            Layer::Under,
            Rect::new(cx - half, cy, 2.0 * half, lw),
            p.grid,
            r,
        );
        self.rect(
            Layer::Under,
            Rect::new(cx, cy - half, lw, 2.0 * half),
            p.grid,
            r,
        );
        let pts = d.dvs_scope;
        let n = pts.len().min(MAX_SCOPE_POINTS);
        if n == 0 {
            return;
        }
        let dot = (3.0 * scale).max(2.0);
        let color = DECK_COLORS[deck & 3];
        for (j, pt) in pts[pts.len() - n..].iter().enumerate() {
            let x = cx + pt[0].clamp(-1.0, 1.0) * half - dot * 0.5;
            let y = cy - pt[1].clamp(-1.0, 1.0) * half - dot * 0.5;
            let a = 0.15 + 0.85 * (j + 1) as f32 / n as f32;
            self.push(
                Layer::Over,
                Shape {
                    rect: [x, y, dot, dot],
                    color: with_alpha(color, a),
                    params: [SHAPE_DOT, 0.0, 0.0, 0.0],
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::BeatGrid;

    #[test]
    fn beat_lines_land_on_expected_columns() {
        let decks = [DeckFrame {
            loaded: true,
            playhead_s: 10.0,
            duration_s: 60.0,
            grid: Some(BeatGrid {
                bpm: 120.0,
                first_downbeat_s: 0.0,
                beats_per_bar: 4,
            }),
            ..Default::default()
        }];
        let st = FrameState {
            decks: &decks,
            zoom_seconds: 4.0,
            ..Default::default()
        };
        let mut s = Scene::new();
        let views = [ViewSpec {
            kind: ViewKind::Waveform { deck: 0 },
            rect: Rect::new(0.0, 0.0, 800.0, 200.0),
        }];
        let slots = [PeaksSlot {
            offset: 0,
            count: 1,
            pps: 100.0,
        }; 4];
        s.build(&views, &st, &slots, 1.0);
        let xs: Vec<f32> = s
            .over
            .iter()
            .filter(|q| q.rect[3] == 200.0)
            .map(|q| q.rect[0])
            .collect();
        // Beats every 0.5 s = 100 px; downbeats (2 px wide) at t = 8 s (x 0) and 10 s (x 400, under the playhead).
        for x in [100.0, 200.0, 300.0, 500.0, 600.0, 700.0] {
            assert!(xs.contains(&x), "beat line at {x} missing in {xs:?}");
        }
        assert!(
            xs.contains(&399.0),
            "playhead / downbeat at 399..401 missing"
        );
        assert_eq!(s.waves[0].t[0], 8.0);
    }

    #[test]
    fn reduced_motion_uses_page_mode() {
        let decks = [DeckFrame {
            loaded: true,
            playhead_s: 9.0,
            duration_s: 60.0,
            ..Default::default()
        }];
        let st = FrameState {
            decks: &decks,
            zoom_seconds: 4.0,
            reduced_motion: true,
            ..Default::default()
        };
        let mut s = Scene::new();
        let views = [ViewSpec {
            kind: ViewKind::Waveform { deck: 0 },
            rect: Rect::new(0.0, 0.0, 800.0, 100.0),
        }];
        let slots = [PeaksSlot {
            offset: 0,
            count: 1,
            pps: 100.0,
        }; 4];
        s.build(&views, &st, &slots, 1.0);
        assert_eq!(
            s.waves[0].t[0], 8.0,
            "page starts at a multiple of the zoom window"
        );
        // Playhead at (9 - 8) / 0.005 = 200 px.
        assert!(
            s.over
                .iter()
                .any(|q| q.rect[0] == 199.0 && q.rect[2] == 2.0)
        );
    }
}
