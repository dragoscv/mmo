//! Behaviour tests on synthetic MixAI timecode (48 kHz, 256-frame blocks, SNR 30 dB).

mod common;

use std::sync::Arc;

use common::*;
use decks_dvs::{
    DecodeMode, Direction, DvsConfig, DvsDecoder, DvsError, DvsState, MixAiCode, PositionCode,
    Support, TimecodeFormat,
};

const SNR_DB: f64 = 30.0;

fn absolute_decoder() -> DvsDecoder {
    let cfg = DvsConfig::new(TimecodeFormat::MixAi, SR);
    DvsDecoder::with_code(cfg, code()).expect("decoder")
}

fn true_pos_sec(phi: f64) -> f64 {
    let len = code().len_cycles() as f64;
    phi.rem_euclid(len) / code().carrier_hz()
}

fn circ_err_sec(a: f64, b: f64) -> f64 {
    let len = code().len_cycles() as f64 / code().carrier_hz();
    let d = (a - b).rem_euclid(len);
    d.min(len - d)
}

/// Block-by-block decode; returns (end frame index, state) per block.
fn run(dec: &mut DvsDecoder, sig: &Signal, from_frame: usize) -> Vec<(usize, DvsState)> {
    let mut out = Vec::new();
    let mut f = from_frame;
    while f < sig.frames() {
        let n = BLOCK.min(sig.frames() - f);
        let st = dec.process(&sig.data[2 * f..2 * (f + n)], n);
        f += n;
        out.push((f - 1, st));
    }
    out
}

struct Check {
    lock_ms: f64,
    max_pos_err_ms: f64,
    max_speed_err_pct: f64,
}

/// Lock time from `start` (frame), then worst position/speed error after lock.
fn check(states: &[(usize, DvsState)], sig: &Signal, start: usize, speed: f64) -> Check {
    let lock = states
        .iter()
        .find(|(f, s)| *f >= start && s.locked)
        .map(|(f, _)| *f)
        .expect("never locked");
    let lock_ms = (lock - start) as f64 * 1e3 / SR as f64;
    let (mut max_pos, mut max_speed) = (0.0f64, 0.0f64);
    for (f, s) in states.iter().filter(|(f, _)| *f >= lock) {
        assert!(s.valid, "invalid state at frame {f}");
        let pos = s
            .position_sec
            .unwrap_or_else(|| panic!("lost lock at frame {f}"));
        max_pos = max_pos.max(circ_err_sec(pos, true_pos_sec(sig.phi[*f])));
        let err = ((s.speed as f64 - speed) / speed).abs() * 100.0;
        max_speed = max_speed.max(err);
    }
    Check {
        lock_ms,
        max_pos_err_ms: max_pos * 1e3,
        max_speed_err_pct: max_speed,
    }
}

fn constant_speed(speed: f64, seed: u64) {
    let g = generator();
    let mut noise = Noise::new(seed);
    let mut sig = Signal::new();
    sig.play(
        &g,
        123_456.3,
        ms_to_frames(400.0),
        |_| speed,
        sigma_for_snr(SNR_DB),
        &mut noise,
    );
    let mut dec = absolute_decoder();
    let states = run(&mut dec, &sig, 0);
    let c = check(&states, &sig, 0, speed);
    println!(
        "speed {speed}: lock {:.1} ms, pos err {:.3} ms, speed err {:.4} %",
        c.lock_ms, c.max_pos_err_ms, c.max_speed_err_pct
    );
    assert!(c.lock_ms < 100.0, "lock took {:.1} ms", c.lock_ms);
    assert!(
        c.max_pos_err_ms < 10.0,
        "position error {:.3} ms",
        c.max_pos_err_ms
    );
    assert!(
        c.max_speed_err_pct < 0.2,
        "speed error {:.4} %",
        c.max_speed_err_pct
    );
    let last = states.last().unwrap().1;
    let want = if speed > 0.0 {
        Direction::Forward
    } else {
        Direction::Reverse
    };
    assert_eq!(last.direction, want);
    assert!(last.quality > 0.8, "quality {}", last.quality);
}

#[test]
fn speed_1_00_locks_and_tracks() {
    constant_speed(1.0, 1);
}

#[test]
fn speed_1_08_locks_and_tracks() {
    constant_speed(1.08, 2);
}

#[test]
fn speed_minus_1_00_locks_and_tracks_in_reverse() {
    constant_speed(-1.0, 3);
}

#[test]
fn speed_0_33_locks_and_tracks() {
    constant_speed(0.33, 4);
}

fn needle_drop(lift_ms: f64, seed: u64) {
    let g = generator();
    let sigma = sigma_for_snr(SNR_DB);
    let mut noise = Noise::new(seed);
    let mut sig = Signal::new();
    sig.play(
        &g,
        50_000.0,
        ms_to_frames(300.0),
        |_| 1.0,
        sigma,
        &mut noise,
    );
    sig.silence(ms_to_frames(lift_ms), sigma, &mut noise);
    let resume = sig.frames();
    sig.play(
        &g,
        700_123.6,
        ms_to_frames(300.0),
        |_| 1.0,
        sigma,
        &mut noise,
    );
    let mut dec = absolute_decoder();
    let states = run(&mut dec, &sig, 0);
    let c = check(&states, &sig, resume, 1.0);
    println!(
        "needle drop (lift {lift_ms} ms): relock {:.1} ms, pos err {:.3} ms, speed err {:.4} %",
        c.lock_ms, c.max_pos_err_ms, c.max_speed_err_pct
    );
    assert!(c.lock_ms < 100.0, "relock took {:.1} ms", c.lock_ms);
    assert!(
        c.max_pos_err_ms < 10.0,
        "position error {:.3} ms",
        c.max_pos_err_ms
    );
    assert!(
        c.max_speed_err_pct < 0.2,
        "speed error {:.4} %",
        c.max_speed_err_pct
    );
    // During the lift nothing may claim a position.
    let lifted_mid = resume - ms_to_frames(lift_ms / 2.0);
    if lift_ms > 10.0 {
        let (_, s) = states.iter().find(|(f, _)| *f >= lifted_mid).unwrap();
        assert!(
            !s.valid && s.position_sec.is_none(),
            "state during lift: {s:?}"
        );
    }
}

#[test]
fn needle_drop_with_lift_relocks_at_new_position() {
    needle_drop(30.0, 5);
}

#[test]
fn instant_jump_relocks_at_new_position() {
    needle_drop(0.0, 6);
}

#[test]
fn relative_mode_detects_stop() {
    let g = generator();
    let sigma = sigma_for_snr(SNR_DB);
    let mut noise = Noise::new(7);
    let mut sig = Signal::new();
    let run_f = ms_to_frames(200.0);
    let brake_f = ms_to_frames(100.0);
    let mut phi = sig.play(&g, 10_000.0, run_f, |_| 1.0, sigma, &mut noise);
    phi = sig.play(
        &g,
        phi,
        brake_f,
        |i| 1.0 - i as f64 / brake_f as f64,
        sigma,
        &mut noise,
    );
    let stop_at = sig.frames();
    sig.play(&g, phi, ms_to_frames(200.0), |_| 0.0, sigma, &mut noise);

    let cfg = DvsConfig::new(TimecodeFormat::MixAi, SR).with_mode(DecodeMode::Relative);
    let mut dec = DvsDecoder::new(cfg).unwrap();
    let states = run(&mut dec, &sig, 0);
    // Running: forward, ~1.0, no position in relative mode (last block before the brake).
    let (_, running) = states.iter().rev().find(|(f, _)| *f < run_f).unwrap();
    assert!(running.valid && !running.stopped);
    assert_eq!(running.direction, Direction::Forward);
    assert!(
        (running.speed - 1.0).abs() < 0.002,
        "speed {}",
        running.speed
    );
    assert!(running.position_sec.is_none());
    // Decelerating at 10 /s: speed follows the ramp (4 ms group delay → 0.04 lag + noise).
    for (f, s) in states
        .iter()
        .filter(|(f, _)| *f > run_f + 2 * BLOCK && *f < stop_at - 2 * BLOCK)
    {
        let truth = 1.0 - (*f - run_f) as f32 / brake_f as f32;
        assert!(
            (s.speed - truth).abs() < 0.06,
            "brake frame {f}: speed {} truth {truth}",
            s.speed
        );
    }
    // Stopped within 20 ms of the platter halting, and stays stopped.
    let deadline = stop_at + ms_to_frames(20.0);
    for (f, s) in states.iter().filter(|(f, _)| *f >= deadline) {
        assert!(s.stopped, "not stopped at frame {f}: {s:?}");
        assert_eq!(s.speed, 0.0);
        assert_eq!(s.direction, Direction::Stopped);
    }
}

#[test]
fn scratch_follows_speed_and_direction() {
    let g = generator();
    let mut noise = Noise::new(8);
    let mut sig = Signal::new();
    let speed = |i: usize| 2.0 * (std::f64::consts::TAU * 2.0 * i as f64 / SR as f64).sin();
    sig.play(
        &g,
        300_000.0,
        ms_to_frames(1000.0),
        speed,
        sigma_for_snr(SNR_DB),
        &mut noise,
    );
    let cfg = DvsConfig::new(TimecodeFormat::MixAi, SR).with_mode(DecodeMode::Relative);
    let mut dec = DvsDecoder::new(cfg).unwrap();
    let states = run(&mut dec, &sig, 0);
    // Estimate is centred half a window back (4 ms group delay).
    let delay = ms_to_frames(4.0);
    let mut checked = 0;
    for (f, s) in states.iter().filter(|(f, _)| *f > ms_to_frames(20.0)) {
        let truth = speed(*f - delay);
        if truth.abs() < 0.3 {
            continue;
        }
        checked += 1;
        assert!(s.valid, "invalid at {f}");
        assert!(
            (s.speed as f64 - truth).abs() < 0.02 + 0.01 * truth.abs(),
            "frame {f}: speed {} truth {truth}",
            s.speed
        );
        let want = if truth > 0.0 {
            Direction::Forward
        } else {
            Direction::Reverse
        };
        assert_eq!(s.direction, want);
    }
    assert!(checked > 100);
}

#[test]
fn noise_only_is_never_valid() {
    let mut noise = Noise::new(9);
    let mut sig = Signal::new();
    sig.silence(ms_to_frames(500.0), 0.05, &mut noise);
    let mut dec = absolute_decoder();
    for (f, s) in run(&mut dec, &sig, 0) {
        assert!(!s.locked, "noise locked at {f}");
        assert!(!s.valid || s.stopped, "noise produced motion at {f}: {s:?}");
    }
}

#[test]
fn format_support_matrix_is_explicit() {
    assert_eq!(TimecodeFormat::MixAi.absolute_support(), Support::Supported);
    assert_eq!(
        TimecodeFormat::SeratoCv25.relative_support(),
        Support::Experimental
    );
    assert!(matches!(
        TimecodeFormat::SeratoCv25.absolute_support(),
        Support::Pending(_)
    ));
    assert!(matches!(
        TimecodeFormat::TraktorMk2.absolute_support(),
        Support::Pending(_)
    ));
    assert!(matches!(
        TimecodeFormat::Phase.relative_support(),
        Support::Pending(_)
    ));
    // Serato defaults to relative; asking for absolute says why it is pending.
    let serato = DvsConfig::new(TimecodeFormat::SeratoCv25, SR);
    assert_eq!(serato.mode, DecodeMode::Relative);
    assert!(DvsDecoder::new(serato).is_ok());
    assert!(matches!(
        DvsDecoder::new(serato.with_mode(DecodeMode::Absolute)),
        Err(DvsError::Unsupported(_))
    ));
    assert!(matches!(
        DvsDecoder::new(DvsConfig::new(TimecodeFormat::Phase, SR)),
        Err(DvsError::Unsupported(_))
    ));
    assert!(matches!(
        DvsDecoder::new(DvsConfig::new(TimecodeFormat::TraktorMk2, 8_000)),
        Err(DvsError::InvalidSampleRate(8_000))
    ));
    // A code with another carrier is refused for a 2.5 kHz format.
    let code: Arc<dyn PositionCode> = Arc::new(MixAiCode::new());
    assert_eq!(
        DvsDecoder::with_code(DvsConfig::new(TimecodeFormat::TraktorMk2, SR), code).err(),
        Some(DvsError::CarrierMismatch)
    );
}

#[test]
fn generic_front_end_tracks_a_2500_hz_offset_carrier() {
    // Custom carrier through the differentiating front-end (Traktor-style), relative mode.
    let carrier = 2500.0f64;
    let frames = ms_to_frames(200.0);
    let mut data = Vec::with_capacity(2 * frames);
    let mut noise = Noise::new(10);
    for i in 0..frames {
        let x = std::f64::consts::TAU * carrier * 1.05 * i as f64 / SR as f64;
        let offset = 0.3 * (i as f64 / 700.0).sin(); // slowly wandering DC offset
        data.push((0.5 * x.sin() + offset + 0.005 * noise.gauss()) as f32);
        data.push((0.5 * x.cos() + offset + 0.005 * noise.gauss()) as f32);
    }
    let cfg = DvsConfig::new(
        TimecodeFormat::Custom {
            carrier_hz: 2500.0,
            differentiate: true,
        },
        SR,
    );
    let mut dec = DvsDecoder::new(cfg).unwrap();
    let st = dec.process(&data, frames);
    assert!(st.valid);
    assert!((st.speed - 1.05).abs() < 0.002, "speed {}", st.speed);
}
