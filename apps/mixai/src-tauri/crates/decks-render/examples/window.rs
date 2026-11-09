//! Manual viewer: animates synthetic decks in a window.
//!
//! `cargo run --manifest-path apps/mixai/src-tauri/Cargo.toml -p decks-render --example window --release`
//!
//! Keys: 1/2/3 style (RGB / single / spectral), T theme, M reduced motion, +/- zoom,
//! S slip shadow, Esc quit.

use std::sync::Arc;
use std::time::Instant;

use decks_render::demo::SyntheticTrack;
use decks_render::{
    BeatGrid, DeckFrame, FrameState, Marker, MarkerKind, Rect, Renderer, Theme, ViewKind, ViewSpec,
    WaveStyle,
};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, KeyEvent, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Window, WindowId};

struct App {
    window: Option<Arc<Window>>,
    renderer: Option<Renderer>,
    track: SyntheticTrack,
    start: Instant,
    style: WaveStyle,
    theme: Theme,
    reduced: bool,
    zoom: f32,
    slip: bool,
    markers: [Marker; 3],
    scope: Vec<[f32; 2]>,
    frames: u32,
    fps_at: Instant,
}

fn layout(w: f32, h: f32) -> [ViewSpec; 6] {
    let wave_h = (h * 0.24).floor();
    let stack_h = (h * 0.36).floor();
    let bottom = h - wave_h - stack_h - 52.0;
    let side = bottom.min(w * 0.3).max(40.0);
    [
        ViewSpec {
            kind: ViewKind::Waveform { deck: 0 },
            rect: Rect::new(0.0, 0.0, w, wave_h),
        },
        ViewSpec {
            kind: ViewKind::Overview { deck: 0 },
            rect: Rect::new(0.0, wave_h + 4.0, w, 36.0),
        },
        ViewSpec {
            kind: ViewKind::Stacked { first: 0, count: 4 },
            rect: Rect::new(0.0, wave_h + 44.0, w, stack_h),
        },
        ViewSpec {
            kind: ViewKind::Platter { deck: 0 },
            rect: Rect::new(8.0, h - side - 4.0, side, side),
        },
        ViewSpec {
            kind: ViewKind::Platter { deck: 1 },
            rect: Rect::new(w - side - 8.0, h - side - 4.0, side, side),
        },
        ViewSpec {
            kind: ViewKind::DvsScope { deck: 1 },
            rect: Rect::new((w - side) * 0.5, h - side - 4.0, side, side),
        },
    ]
}

impl App {
    fn relayout(&mut self) {
        let (Some(w), Some(r)) = (&self.window, &mut self.renderer) else {
            return;
        };
        let size = w.inner_size();
        let scale = w.scale_factor() as f32;
        r.resize((size.width, size.height), scale);
        r.set_views(&layout(
            size.width as f32 / scale,
            size.height as f32 / scale,
        ));
    }

    fn frame(&mut self) {
        let t = self.start.elapsed().as_secs_f64();
        let Some(r) = &mut self.renderer else {
            return;
        };
        let n = self.scope.len();
        for (i, p) in self.scope.iter_mut().enumerate() {
            let a = (t * 40.0 + i as f64 * 0.05) as f32;
            let amp = 0.5 + 0.4 * ((t * 0.7) as f32).sin().abs() * (i as f32 / n as f32);
            *p = [amp * a.cos(), amp * (a + 0.35).sin()];
        }
        let grid = Some(BeatGrid {
            bpm: self.track.bpm,
            first_downbeat_s: 0.0,
            beats_per_bar: 4,
        });
        let dur = self.track.duration_s;
        let base = DeckFrame {
            loaded: true,
            duration_s: dur,
            grid,
            ..Default::default()
        };
        let head = (10.0 + t) % dur;
        let decks = [
            DeckFrame {
                playhead_s: head,
                slip_playhead_s: self.slip.then_some(head - 1.5),
                markers: &self.markers,
                ..base
            },
            DeckFrame {
                playhead_s: (head + 0.04 * (t * 0.5).sin()).max(0.0),
                dvs_scope: &self.scope,
                ..base
            },
            DeckFrame {
                playhead_s: (head + 32.0) % dur,
                ..base
            },
            DeckFrame {
                playhead_s: (head + 64.1) % dur,
                ..base
            },
        ];
        r.update(&FrameState {
            decks: &decks,
            zoom_seconds: self.zoom,
            style: self.style,
            theme: self.theme,
            reduced_motion: self.reduced,
        });
        if let Err(e) = r.render() {
            eprintln!("render: {e}");
        }
        self.frames += 1;
        let el = self.fps_at.elapsed().as_secs_f64();
        if el >= 2.0 {
            println!("{:.1} fps", f64::from(self.frames) / el);
            self.frames = 0;
            self.fps_at = Instant::now();
        }
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("MixAI Decks — decks-render")
            .with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0));
        let window = Arc::new(el.create_window(attrs).expect("create window"));
        let size = window.inner_size();
        let scale = window.scale_factor() as f32;
        let mut r = Renderer::new_from_window(window.clone(), (size.width, size.height), scale)
            .expect("renderer");
        let i = r.adapter_info();
        println!("adapter: {} ({:?})", i.name, i.backend);
        for d in 0..4 {
            r.set_peaks(d, &self.track.view());
        }
        self.window = Some(window);
        self.renderer = Some(r);
        self.relayout();
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => self.relayout(),
            WindowEvent::RedrawRequested => self.frame(),
            WindowEvent::KeyboardInput {
                event:
                    KeyEvent {
                        logical_key,
                        state: ElementState::Pressed,
                        ..
                    },
                ..
            } => match logical_key.as_ref() {
                Key::Named(NamedKey::Escape) => el.exit(),
                Key::Character("1") => self.style = WaveStyle::Rgb3Band,
                Key::Character("2") => self.style = WaveStyle::SingleColor,
                Key::Character("3") => self.style = WaveStyle::Spectral,
                Key::Character("t" | "T") => {
                    self.theme = match self.theme {
                        Theme::Dark => Theme::Light,
                        Theme::Light => Theme::Dark,
                    };
                }
                Key::Character("m" | "M") => self.reduced = !self.reduced,
                Key::Character("s" | "S") => self.slip = !self.slip,
                Key::Character("+" | "=") => self.zoom = (self.zoom * 0.8).max(0.5),
                Key::Character("-") => self.zoom = (self.zoom * 1.25).min(120.0),
                _ => {}
            },
            _ => {}
        }
    }

    fn about_to_wait(&mut self, _el: &ActiveEventLoop) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }
}

fn main() {
    let event_loop = EventLoop::new().expect("event loop");
    event_loop.set_control_flow(ControlFlow::Poll);
    let cue = |kind, s: f64, e: f64, c| Marker {
        kind,
        start_s: s,
        end_s: e,
        color: c,
    };
    let mut app = App {
        window: None,
        renderer: None,
        track: SyntheticTrack::new(300.0, 124.0, 150.0),
        start: Instant::now(),
        style: WaveStyle::Rgb3Band,
        theme: Theme::Dark,
        reduced: false,
        zoom: 8.0,
        slip: true,
        markers: [
            cue(MarkerKind::Cue, 15.48, 15.48, [1.0, 0.6, 0.1, 1.0]),
            cue(MarkerKind::Loop, 23.23, 27.10, [0.2, 0.9, 0.4, 1.0]),
            cue(MarkerKind::HotCue(1), 38.7, 38.7, [0.8, 0.3, 1.0, 1.0]),
        ],
        scope: vec![[0.0; 2]; 512],
        frames: 0,
        fps_at: Instant::now(),
    };
    event_loop.run_app(&mut app).expect("run");
}
