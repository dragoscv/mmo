//! `DvsDecoder::process` must not touch the heap (real-time audio thread).

mod common;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use common::*;
use decks_dvs::{DvsConfig, DvsDecoder, SCOPE_POINTS, TimecodeFormat};

struct Counting;

static ARMED: AtomicBool = AtomicBool::new(false);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

// SAFETY: forwards to the system allocator; only counts calls while armed.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if ARMED.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        // SAFETY: same contract as the caller's.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if ARMED.load(Ordering::Relaxed) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
        }
        // SAFETY: same contract as the caller's.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

#[test]
fn process_report_and_scope_do_not_allocate() {
    let g = generator();
    let mut noise = Noise::new(12);
    let sigma = sigma_for_snr(30.0);
    let mut sig = Signal::new();
    let phi = sig.play(&g, 5_000.0, ms_to_frames(200.0), |_| 1.0, sigma, &mut noise);
    sig.silence(ms_to_frames(30.0), sigma, &mut noise);
    sig.play(
        &g,
        phi + 90_000.0,
        ms_to_frames(200.0),
        |_| -0.5,
        sigma,
        &mut noise,
    );
    let mut dec = DvsDecoder::with_code(DvsConfig::new(TimecodeFormat::MixAi, SR), code()).unwrap();
    let mut pts = [[0.0f32; 2]; SCOPE_POINTS];

    ARMED.store(true, Ordering::SeqCst);
    let mut locked = false;
    for chunk in sig.data.chunks(2 * BLOCK) {
        let st = dec.process(chunk, chunk.len() / 2);
        locked |= st.locked;
        let _ = dec.report();
        let _ = dec.scope(&mut pts);
    }
    ARMED.store(false, Ordering::SeqCst);

    assert!(locked);
    assert_eq!(ALLOCS.load(Ordering::SeqCst), 0, "heap used in the RT path");
}
