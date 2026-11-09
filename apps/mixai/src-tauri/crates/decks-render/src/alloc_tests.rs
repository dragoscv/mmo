//! Proves that building a frame's instance data allocates nothing (counting global allocator,
//! lib unit-test binary only).

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use crate::colors::DECK_COLORS;
use crate::model::{BeatGrid, DeckFrame, FrameState, Marker, MarkerKind, Rect, ViewKind, ViewSpec};
use crate::scene::{PeaksSlot, Scene};

struct Counting;

thread_local! {
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: forwards to the system allocator; only adds a thread-local counter.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = COUNT.try_with(|c| c.set(c.get() + 1));
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = COUNT.try_with(|c| c.set(c.get() + 1));
        // SAFETY: same contract as the caller's.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn allocations() -> usize {
    COUNT.with(Cell::get)
}

#[test]
fn building_a_frame_does_not_allocate() {
    let markers = [
        Marker {
            kind: MarkerKind::Cue,
            start_s: 30.0,
            end_s: 30.0,
            color: DECK_COLORS[0],
        },
        Marker {
            kind: MarkerKind::Loop,
            start_s: 32.0,
            end_s: 36.0,
            color: DECK_COLORS[3],
        },
        Marker {
            kind: MarkerKind::HotCue(1),
            start_s: 40.0,
            end_s: 40.0,
            color: DECK_COLORS[1],
        },
    ];
    let scope: Vec<[f32; 2]> = (0..512)
        .map(|i| [(i as f32).sin(), (i as f32).cos()])
        .collect();
    let deck = DeckFrame {
        loaded: true,
        playhead_s: 31.0,
        slip_playhead_s: Some(33.0),
        duration_s: 240.0,
        grid: Some(BeatGrid {
            bpm: 126.0,
            first_downbeat_s: 0.12,
            beats_per_bar: 4,
        }),
        markers: &markers,
        dvs_scope: &scope,
        ..Default::default()
    };
    let decks = [deck; 4];
    let views = [
        ViewSpec {
            kind: ViewKind::Waveform { deck: 0 },
            rect: Rect::new(0.0, 0.0, 1200.0, 160.0),
        },
        ViewSpec {
            kind: ViewKind::Overview { deck: 0 },
            rect: Rect::new(0.0, 160.0, 1200.0, 40.0),
        },
        ViewSpec {
            kind: ViewKind::Stacked { first: 0, count: 4 },
            rect: Rect::new(0.0, 200.0, 1200.0, 300.0),
        },
        ViewSpec {
            kind: ViewKind::Platter { deck: 1 },
            rect: Rect::new(0.0, 500.0, 200.0, 200.0),
        },
        ViewSpec {
            kind: ViewKind::DvsScope { deck: 1 },
            rect: Rect::new(200.0, 500.0, 200.0, 200.0),
        },
    ];
    let slots = [PeaksSlot {
        offset: 0,
        count: 36_000,
        pps: 150.0,
    }; 4];
    let mut scene = Scene::new();
    let mut st = FrameState {
        decks: &decks,
        ..Default::default()
    };
    scene.build(&views, &st, &slots, 2.0);
    let before = allocations();
    for i in 0..500 {
        st.zoom_seconds = 2.0 + (i % 30) as f32;
        st.reduced_motion = i % 2 == 0;
        scene.build(&views, &st, &slots, 2.0);
    }
    let after = allocations();
    assert_eq!(after - before, 0, "Scene::build allocated");
    assert!(!scene.under.is_empty() && !scene.over.is_empty() && !scene.waves.is_empty());
}
