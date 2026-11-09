//! Headless GPU render of synthetic decks: pixel assertions, PNG snapshots, frame timing.
//!
//! Skips (passes with a message) when no GPU adapter exists, not even a software fallback.

use std::path::PathBuf;
use std::time::Instant;

use decks_render::demo::SyntheticTrack;
use decks_render::{
    BeatGrid, DECK_COLORS, DeckFrame, FrameState, Marker, MarkerKind, Palette, Rect, RenderError,
    Renderer, Theme, ViewKind, ViewSpec, WaveStyle,
};

const W: u32 = 1200;
const H: u32 = 720;
/// Waveform view: zoom 6 s over 1200 px = 5 ms per px; playhead 30 s → t_left 27 s.
const ZOOM: f32 = 6.0;
const PLAYHEAD: f64 = 30.0;
const WAVE_H: u32 = 180;

fn renderer() -> Option<Renderer> {
    match Renderer::new_headless((W, H)) {
        Ok(r) => {
            let i = r.adapter_info();
            eprintln!("adapter: {} ({:?}, {:?})", i.name, i.backend, i.device_type);
            Some(r)
        }
        Err(RenderError::NoAdapter(e)) => {
            eprintln!("SKIP: no GPU adapter, not even a fallback ({e})");
            None
        }
        Err(e) => panic!("renderer: {e}"),
    }
}

fn views() -> [ViewSpec; 5] {
    [
        ViewSpec {
            kind: ViewKind::Waveform { deck: 0 },
            rect: Rect::new(0.0, 0.0, W as f32, WAVE_H as f32),
        },
        ViewSpec {
            kind: ViewKind::Overview { deck: 0 },
            rect: Rect::new(0.0, 184.0, W as f32, 36.0),
        },
        ViewSpec {
            kind: ViewKind::Stacked { first: 0, count: 3 },
            rect: Rect::new(0.0, 224.0, W as f32, 276.0),
        },
        ViewSpec {
            kind: ViewKind::Platter { deck: 1 },
            rect: Rect::new(8.0, 508.0, 204.0, 204.0),
        },
        ViewSpec {
            kind: ViewKind::DvsScope { deck: 1 },
            rect: Rect::new(224.0, 508.0, 204.0, 204.0),
        },
    ]
}

fn markers() -> [Marker; 3] {
    [
        Marker {
            kind: MarkerKind::Cue,
            start_s: 29.25,
            end_s: 29.25,
            color: [1.0, 0.6, 0.1, 1.0],
        },
        Marker {
            kind: MarkerKind::Loop,
            start_s: 31.0,
            end_s: 31.6,
            color: [0.2, 0.9, 0.4, 1.0],
        },
        Marker {
            kind: MarkerKind::HotCue(2),
            start_s: 60.0,
            end_s: 60.0,
            color: [0.8, 0.3, 1.0, 1.0],
        },
    ]
}

fn scope_points() -> Vec<[f32; 2]> {
    (0..600)
        .map(|i| {
            let a = i as f32 * 0.07;
            [0.8 * a.cos(), 0.8 * (a + 0.4).sin()]
        })
        .collect()
}

fn grid(first: f64) -> Option<BeatGrid> {
    Some(BeatGrid {
        bpm: 120.0,
        first_downbeat_s: first,
        beats_per_bar: 4,
    })
}

fn decks<'a>(markers: &'a [Marker], scope: &'a [[f32; 2]], playhead: f64) -> [DeckFrame<'a>; 3] {
    let base = DeckFrame {
        loaded: true,
        playhead_s: playhead,
        duration_s: 120.0,
        grid: grid(0.0),
        ..Default::default()
    };
    [
        DeckFrame {
            slip_playhead_s: Some(playhead - 1.25),
            markers,
            ..base
        },
        DeckFrame {
            playhead_s: playhead + 0.11,
            grid: grid(0.0),
            dvs_scope: scope,
            ..base
        },
        DeckFrame {
            playhead_s: playhead - 0.06,
            ..base
        },
    ]
}

fn snapshot_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .ancestors()
        .find(|a| a.join("pnpm-workspace.yaml").is_file())
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("target"));
    let d = root.join(".copilot-tmp").join("decks-render");
    std::fs::create_dir_all(&d).expect("create snapshot dir");
    d
}

fn save_png(name: &str, px: &[u8]) -> PathBuf {
    let path = snapshot_dir().join(name);
    let file = std::fs::File::create(&path).expect("create png");
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), W, H);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()
        .expect("png header")
        .write_image_data(px)
        .expect("png data");
    path.canonicalize().unwrap_or(path)
}

fn pixel(px: &[u8], x: u32, y: u32) -> [u8; 4] {
    let i = ((y * W + x) * 4) as usize;
    [px[i], px[i + 1], px[i + 2], px[i + 3]]
}

fn to_u8(c: [f32; 4]) -> [u8; 3] {
    [0, 1, 2].map(|i| (c[i] * 255.0).round() as u8)
}

fn close(a: [u8; 4], b: [u8; 3], tol: i32) -> bool {
    (0..3).all(|i| (i32::from(a[i]) - i32::from(b[i])).abs() <= tol)
}

fn luma(p: [u8; 4]) -> f32 {
    0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])
}

fn column_luma(px: &[u8], x: u32) -> f32 {
    (4..WAVE_H - 4).map(|y| luma(pixel(px, x, y))).sum::<f32>() / (WAVE_H - 8) as f32
}

fn render(r: &mut Renderer, st: &FrameState<'_>) -> Vec<u8> {
    r.update(st);
    r.render().expect("render");
    r.read_pixels().expect("readback")
}

#[test]
fn waveform_playhead_beatgrid_and_bands() {
    let Some(mut r) = renderer() else {
        return;
    };
    let track = SyntheticTrack::new(120.0, 120.0, 150.0);
    for d in 0..3 {
        r.set_peaks(d, &track.view());
    }
    r.set_views(&views());
    let m = markers();
    let scope = scope_points();
    let decks = decks(&m, &scope, PLAYHEAD);
    let st = FrameState {
        decks: &decks,
        zoom_seconds: ZOOM,
        style: WaveStyle::Rgb3Band,
        theme: Theme::Dark,
        reduced_motion: false,
    };
    let px = render(&mut r, &st);
    let path = save_png("waveform-dark-rgb.png", &px);
    eprintln!("snapshot: {}", path.display());
    assert_eq!(r.dropped_shapes(), 0);

    let pal = Palette::for_theme(Theme::Dark);
    // 1. Playhead: 2 px at x 599..=600 over the whole waveform height, opaque playhead colour.
    let ph = to_u8(pal.playhead);
    for y in 0..WAVE_H {
        for x in [599, 600] {
            let p = pixel(&px, x, y);
            assert!(
                close(p, ph, 3),
                "playhead pixel ({x},{y}) = {p:?}, want {ph:?}"
            );
        }
    }
    // 2. Beat lines every 100 px (0.5 s at 120 BPM): x = 300 is a beat, x = 200 a downbeat.
    let neighbours = |x: u32| (column_luma(&px, x - 4) + column_luma(&px, x + 4)) / 2.0;
    for x in [100, 300, 500, 700, 900, 1100] {
        let (line, around) = (column_luma(&px, x), neighbours(x));
        assert!(
            line > around + 12.0,
            "beat line at x={x}: luma {line:.1} vs {around:.1}"
        );
    }
    for x in [199, 200, 999, 1000] {
        let (line, around) = (column_luma(&px, x), neighbours(x));
        assert!(
            line > around + 40.0,
            "downbeat at x={x}: luma {line:.1} vs {around:.1}"
        );
    }
    // 3. All three band colours (full or RMS-shaded peak fringe) inside the waveform.
    let shade = |c: [f32; 4], k: f32| to_u8([c[0] * k, c[1] * k, c[2] * k, 1.0]);
    for (name, c) in [("low", pal.low), ("mid", pal.mid), ("high", pal.high)] {
        let n = (0..WAVE_H)
            .flat_map(|y| (0..W).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let p = pixel(&px, x, y);
                close(p, shade(c, 1.0), 6) || close(p, shade(c, 0.62), 6)
            })
            .count();
        assert!(n > 200, "{name} band colour found on only {n} pixels");
    }
    // 4. Cue marker at t 29.25 → x 450, colour square at the top.
    assert!(close(pixel(&px, 452, 2), [255, 153, 26], 3), "cue square");
    // 5. Slip shadow playhead at t 28.75 → x 350, half-transparent playhead colour.
    assert!(
        column_luma(&px, 350) > neighbours(350) + 30.0,
        "slip playhead"
    );
    // 6. Platter rim is in deck B's colour somewhere; DVS scope dots in deck B's colour.
    let deck_b = to_u8(DECK_COLORS[1]);
    let scope_hits = (508..712)
        .flat_map(|y| (224..428).map(move |x| (x, y)))
        .filter(|&(x, y)| close(pixel(&px, x, y), deck_b, 40))
        .count();
    assert!(scope_hits > 100, "DVS scope dots: {scope_hits}");
}

#[test]
fn spectral_light_reduced_motion_renders() {
    let Some(mut r) = renderer() else {
        return;
    };
    let track = SyntheticTrack::new(120.0, 120.0, 150.0);
    for d in 0..3 {
        r.set_peaks(d, &track.view());
    }
    r.set_views(&views());
    let m = markers();
    let scope = scope_points();
    let decks = decks(&m, &scope, 33.3);
    let st = FrameState {
        decks: &decks,
        zoom_seconds: ZOOM,
        style: WaveStyle::Spectral,
        theme: Theme::Light,
        reduced_motion: true,
    };
    let px = render(&mut r, &st);
    let path = save_png("waveform-light-spectral-reduced.png", &px);
    eprintln!("snapshot: {}", path.display());
    let pal = Palette::for_theme(Theme::Light);
    // Page mode: page = 6 s → t_left 30 s, playhead 3.3 s in = x 660 (2 px at 659..=660).
    let ph = to_u8(pal.playhead);
    assert!(
        close(pixel(&px, 660, WAVE_H / 2), ph, 3),
        "page-mode playhead"
    );
    let panel = to_u8(pal.panel);
    let wave_px = (0..WAVE_H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .filter(|&(x, y)| !close(pixel(&px, x, y), panel, 10))
        .count();
    assert!(
        wave_px > 20_000,
        "spectral waveform drew only {wave_px} pixels"
    );

    // Single-colour style uses the deck colour.
    let st = FrameState {
        style: WaveStyle::SingleColor,
        theme: Theme::Dark,
        reduced_motion: false,
        ..st
    };
    let px = render(&mut r, &st);
    save_png("waveform-dark-single.png", &px);
    let deck_a = to_u8(DECK_COLORS[0]);
    let hits = (0..WAVE_H)
        .flat_map(|y| (0..W).map(move |x| (x, y)))
        .filter(|&(x, y)| close(pixel(&px, x, y), deck_a, 6))
        .count();
    assert!(hits > 2_000, "deck A colour on {hits} pixels");
}

#[test]
#[ignore = "benchmark: cargo test -p decks-render --release -- --ignored --nocapture"]
fn frame_time_1000_renders() {
    let Some(mut r) = renderer() else {
        return;
    };
    let track = SyntheticTrack::new(420.0, 124.0, 150.0);
    for d in 0..4 {
        r.set_peaks(d, &track.view());
    }
    let v = [
        ViewSpec {
            kind: ViewKind::Stacked { first: 0, count: 4 },
            rect: Rect::new(0.0, 0.0, W as f32, 400.0),
        },
        ViewSpec {
            kind: ViewKind::Overview { deck: 0 },
            rect: Rect::new(0.0, 404.0, W as f32, 40.0),
        },
        ViewSpec {
            kind: ViewKind::Platter { deck: 0 },
            rect: Rect::new(0.0, 450.0, 260.0, 260.0),
        },
        ViewSpec {
            kind: ViewKind::DvsScope { deck: 0 },
            rect: Rect::new(270.0, 450.0, 260.0, 260.0),
        },
    ];
    r.set_views(&v);
    let m = markers();
    let scope = scope_points();
    let mut deck_frames = [DeckFrame::default(); 4];
    let mut cpu = Vec::with_capacity(1000);
    let mut synced = Vec::with_capacity(1000);
    let start = Instant::now();
    for i in 0..1000 {
        let t = 20.0 + i as f64 / 120.0;
        for (d, f) in deck_frames.iter_mut().enumerate() {
            *f = DeckFrame {
                loaded: true,
                playhead_s: t + d as f64 * 0.013,
                duration_s: 420.0,
                grid: Some(BeatGrid {
                    bpm: 124.0,
                    first_downbeat_s: 0.0,
                    beats_per_bar: 4,
                }),
                markers: &m,
                dvs_scope: &scope,
                ..Default::default()
            };
        }
        let st = FrameState {
            decks: &deck_frames,
            zoom_seconds: 8.0,
            ..Default::default()
        };
        let t0 = Instant::now();
        r.update(&st);
        r.render().expect("render");
        cpu.push(t0.elapsed().as_secs_f64() * 1e3);
        r.wait_idle();
        synced.push(t0.elapsed().as_secs_f64() * 1e3);
    }
    let total = start.elapsed().as_secs_f64();
    let stats = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        let avg = v.iter().sum::<f64>() / v.len() as f64;
        (avg, v[v.len() / 2], v[v.len() * 99 / 100], v[v.len() - 1])
    };
    let (ca, c50, c99, cmax) = stats(&mut cpu);
    let (sa, s50, s99, smax) = stats(&mut synced);
    let i = r.adapter_info();
    eprintln!(
        "PERF {} ({:?}) {W}x{H}, 4 stacked waveforms + overview + platter + scope, 1000 frames in {total:.2} s",
        i.name, i.backend
    );
    eprintln!("PERF cpu update+render ms: avg {ca:.3} p50 {c50:.3} p99 {c99:.3} max {cmax:.3}");
    eprintln!("PERF frame incl. GPU wait ms: avg {sa:.3} p50 {s50:.3} p99 {s99:.3} max {smax:.3}");
    eprintln!(
        "PERF 120 Hz budget 8.33 ms: p99 {}",
        if s99 < 8.33 { "OK" } else { "OVER" }
    );
}
