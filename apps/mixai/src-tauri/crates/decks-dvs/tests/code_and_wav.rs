//! Code properties, generator → WAV → decoder round trip, calibration report, scope buffer.

mod common;

use common::*;
use decks_dvs::{
    DvsConfig, DvsDecoder, MIXAI_LFSR_BITS, PositionCode, SCOPE_POINTS, TimecodeFormat,
    TimecodeGenerator, max_minutes,
};

#[test]
fn mixai_lfsr_is_maximal_and_windows_are_unique() {
    let code = code();
    let len = code.len_cycles();
    assert_eq!(len, (1 << MIXAI_LFSR_BITS) - 1);
    // Every non-zero 20-bit window occurs exactly once ⇔ x^20 + x^17 + 1 is primitive.
    assert_eq!(code.distinct_windows(), len as usize);
    // lookup() agrees with bit() for a sample of positions (window convention: bit i = cycle k+i).
    for k in [0u32, 1, 19, 4_242, 524_287, len - 21, len - 1] {
        let mut w = 0u32;
        for i in 0..MIXAI_LFSR_BITS {
            w |= u32::from(code.bit(k + i)) << i;
        }
        assert_eq!(code.lookup(w), Some(k), "window at {k}");
    }
    assert_eq!(code.lookup(0), None);
    // Balanced like any m-sequence: 2^19 ones.
    let ones = (0..len).filter(|&c| code.bit(c)).count();
    assert_eq!(ones, 1 << 19);
    assert!((max_minutes() - 17.476).abs() < 0.01);
}

#[test]
fn wav_round_trip_decodes_position_from_zero() {
    let path = std::env::temp_dir().join(format!("decks-dvs-rt-{}.wav", std::process::id()));
    let seconds = 3.0;
    let g = TimecodeGenerator::new(code(), SR, decks_dvs::DEFAULT_LEVEL);
    g.write_wav(
        std::io::BufWriter::new(std::fs::File::create(&path).unwrap()),
        seconds / 60.0,
    )
    .unwrap();

    let mut reader = hound::WavReader::open(&path).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.channels, 2);
    assert_eq!(spec.sample_rate, SR);
    assert_eq!(spec.bits_per_sample, 16);
    let data: Vec<f32> = reader
        .samples::<i16>()
        .map(|s| s.unwrap() as f32 / 32768.0)
        .collect();
    drop(reader);
    std::fs::remove_file(&path).ok();
    assert_eq!(data.len(), (seconds * SR as f64) as usize * 2);

    let mut dec = DvsDecoder::with_code(DvsConfig::new(TimecodeFormat::MixAi, SR), code()).unwrap();
    let frames = data.len() / 2;
    let mut first_lock = None;
    let mut f = 0;
    while f < frames {
        let n = BLOCK.min(frames - f);
        let st = dec.process(&data[2 * f..2 * (f + n)], n);
        f += n;
        let t = (f - 1) as f64 / SR as f64;
        if let Some(pos) = st.position_sec {
            first_lock.get_or_insert(t);
            assert!((pos - t).abs() < 0.001, "t {t:.4}: pos {pos:.4}");
            assert!((st.speed - 1.0).abs() < 0.001, "speed {}", st.speed);
        }
    }
    let lock = first_lock.expect("never locked");
    assert!(lock < 0.1, "lock at {lock:.3} s");
    let rep = dec.report();
    assert!(rep.snr_db > 35.0, "16-bit WAV SNR {:.1}", rep.snr_db);
}

#[test]
fn calibration_report_measures_snr_noise_bits_and_scope() {
    let g = generator();
    let mut noise = Noise::new(13);
    let mut sig = Signal::new();
    sig.play(
        &g,
        33_333.0,
        ms_to_frames(600.0),
        |_| 1.0,
        sigma_for_snr(30.0),
        &mut noise,
    );
    let mut dec = DvsDecoder::with_code(DvsConfig::new(TimecodeFormat::MixAi, SR), code()).unwrap();
    let st = dec.process(&sig.data, sig.frames());
    let rep = dec.report();
    println!("{rep:?}");
    assert!(rep.present && st.locked);
    assert!(rep.balance_db.abs() < 0.3, "balance {}", rep.balance_db);
    assert!(
        rep.phase_error_deg.abs() < 1.5,
        "phase err {}",
        rep.phase_error_deg
    );
    assert!((rep.snr_db - 30.0).abs() < 2.0, "snr {}", rep.snr_db);
    assert!(
        rep.valid_bits_pct.unwrap() > 99.0,
        "bits {:?}",
        rep.valid_bits_pct
    );
    assert!(rep.threshold > 0.0 && rep.noise_floor_dbfs < -30.0);

    // Scope: the newest points lie on the (normalised) circle.
    let mut pts = [[0.0f32; 2]; SCOPE_POINTS];
    let n = dec.scope(&mut pts);
    assert_eq!(n, SCOPE_POINTS);
    for p in &pts[..n] {
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        assert!(r > 0.3 && r < 1.3, "radius {r}");
    }
}

#[test]
fn calibration_report_measures_balance_and_phase_error() {
    let g = generator();
    let mut noise = Noise::new(11);
    let sigma = sigma_for_snr(30.0);
    let frames = ms_to_frames(600.0);
    let step = g.code().carrier_hz() / SR as f64;
    let delta = 10f64.to_radians(); // R lags its ideal by 10°, R 3 dB quieter
    let mut data = Vec::with_capacity(2 * frames);
    for i in 0..frames {
        let phi = 77_777.0 + i as f64 * step;
        let a = g.envelope(phi) * decks_dvs::DEFAULT_LEVEL as f64;
        let x = std::f64::consts::TAU * phi;
        data.push((a * x.sin() + sigma * noise.gauss()) as f32);
        data.push((0.708 * a * (x - delta).cos() + sigma * noise.gauss()) as f32);
    }
    let mut dec = DvsDecoder::with_code(DvsConfig::new(TimecodeFormat::MixAi, SR), code()).unwrap();
    let st = dec.process(&data, frames);
    let rep = dec.report();
    println!("{rep:?}");
    assert!(rep.present && st.locked);
    assert!(
        (rep.balance_db - 3.0).abs() < 0.5,
        "balance {}",
        rep.balance_db
    );
    assert!(
        (rep.phase_error_deg - 10.0).abs() < 1.5,
        "phase err {}",
        rep.phase_error_deg
    );
    // An imbalanced cartridge still decodes; the impairment shows up as a lower effective SNR.
    assert!(
        rep.valid_bits_pct.unwrap() > 99.0,
        "bits {:?}",
        rep.valid_bits_pct
    );
}
