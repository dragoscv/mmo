//! Proves `StreamingAnalyzer::push` does not touch the heap after construction on this crate's
//! own paths (tempo, loudness, decimation, carry). The shared `mixai-listen` key engine allocates
//! inside its own `push`/`snapshot`, so it is switched off here (`live_key: false`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use decks_analysis::{StreamingAnalyzer, StreamingOptions};

struct Counting;

thread_local! {
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: forwards to the system allocator; only bumps a thread-local counter (const-initialised,
// so accessing it never allocates).
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.with(|c| c.set(c.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.with(|c| c.set(c.get() + 1));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn push_is_allocation_free_after_construction() {
    let sr = 44_100;
    let mut input = Vec::with_capacity(sr as usize * 2 * 12);
    for i in 0..sr as usize * 12 {
        let t = i as f64 / sr as f64;
        let beat = (t * 2.0).fract() < 0.01;
        let x = 0.2 * (std::f64::consts::TAU * 220.0 * t).sin() + if beat { 0.5 } else { 0.0 };
        input.push(x as f32);
        input.push(x as f32);
    }
    let opts = StreamingOptions {
        live_key: false,
        ..StreamingOptions::default()
    };
    let mut s = StreamingAnalyzer::new(2, sr, opts);
    let before = ALLOCS.with(Cell::get);
    // 12 s of audio in odd-sized chunks: includes ~11 estimate refreshes and partial frames.
    for chunk in input.chunks(777) {
        s.push(chunk);
    }
    let during = ALLOCS.with(Cell::get) - before;
    assert_eq!(during, 0, "push allocated {during} times");
    let snap = s.snapshot();
    assert!(snap.updates >= 11, "{snap:?}");
    assert!(snap.bpm.is_some());
}
