//! End-to-end tests on synthetic signals.

use std::f64::consts::TAU;

use super::*;

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

/// Add a beat at `t` seconds: a 20 ms noise click, plus a 60 Hz kick when `accent`.
fn add_beat(out: &mut [f32], sr: u32, t: f64, accent: bool, rng: &mut Lcg) {
    let start = (t * sr as f64).round() as usize;
    let len = (0.12 * sr as f64) as usize;
    let amp = if accent { 0.8 } else { 0.35 };
    for i in 0..len {
        let Some(o) = out.get_mut(start + i) else {
            break;
        };
        let tt = i as f64 / sr as f64;
        let mut v = 0.0;
        if tt < 0.02 {
            v += amp * rng.next() as f64 * (-tt / 0.004).exp();
        }
        if accent {
            v += 0.7 * (TAU * 60.0 * tt).sin() * (-tt / 0.04).exp();
        }
        *o += v as f32;
    }
}

/// Mono click track from explicit beat times; `accent(k)` marks bar starts.
fn clicks(sr: u32, secs: f64, times: &[f64], accent: impl Fn(usize) -> bool) -> Vec<f32> {
    let mut out = vec![0.0f32; (sr as f64 * secs) as usize];
    let mut rng = Lcg(42);
    for (k, &t) in times.iter().enumerate() {
        add_beat(&mut out, sr, t, accent(k), &mut rng);
    }
    out
}

fn steady_times(first: f64, bpm: f64, secs: f64) -> Vec<f64> {
    let p = 60.0 / bpm;
    (0..)
        .map(|k| first + k as f64 * p)
        .take_while(|&t| t < secs - 0.2)
        .collect()
}

fn to_stereo(mono: &[f32]) -> Vec<f32> {
    mono.iter().flat_map(|&x| [x, x]).collect()
}

/// Chords of additive tones (4 partials, amplitude 1/h) with a short attack/release.
fn chords(sr: u32, seq: &[&[f64]], chord_sec: f64, repeats: usize, a4: f64) -> Vec<f32> {
    let n_chord = (chord_sec * sr as f64) as usize;
    let mut out = vec![0.0f32; n_chord * seq.len() * repeats];
    for r in 0..repeats {
        for (c, notes) in seq.iter().enumerate() {
            let off = (r * seq.len() + c) * n_chord;
            for &m in notes.iter() {
                let f = a4 * 2f64.powf((m - 69.0) / 12.0);
                for i in 0..n_chord {
                    let t = i as f64 / sr as f64;
                    let env = (t / 0.01).min(1.0)
                        * ((chord_sec - t) / 0.02).clamp(0.0, 1.0)
                        * (-t / 1.5).exp();
                    let mut v = 0.0;
                    for h in 1..=4 {
                        let fh = f * h as f64;
                        if fh < 0.45 * sr as f64 {
                            v += (TAU * fh * t).sin() / h as f64;
                        }
                    }
                    out[off + i] += (0.06 * env * v) as f32;
                }
            }
        }
    }
    out
}

const C_MAJOR: [&[f64]; 4] = [
    &[48.0, 60.0, 64.0, 67.0],       // C
    &[53.0, 60.0, 65.0, 69.0],       // F
    &[43.0, 59.0, 62.0, 65.0, 67.0], // G7
    &[48.0, 60.0, 64.0, 67.0],       // C
];
const A_MINOR: [&[f64]; 4] = [
    &[45.0, 60.0, 64.0, 69.0], // Am
    &[50.0, 62.0, 65.0, 69.0], // Dm
    &[52.0, 56.0, 59.0, 64.0], // E (harmonic-minor dominant, G#)
    &[45.0, 60.0, 64.0, 69.0], // Am
];

fn key_only() -> AnalyzeOptions {
    AnalyzeOptions {
        tempo: false,
        loudness: false,
        peaks_per_second: 0,
        ..AnalyzeOptions::default()
    }
}

#[test]
fn click_track_128_bpm_tempo_and_first_beat() {
    let sr = 44_100;
    let first = 0.25;
    let times = steady_times(first, 128.0, 30.0);
    let audio = to_stereo(&clicks(sr, 30.0, &times, |_| false));
    let a = analyze(&audio, 2, sr, &AnalyzeOptions::default());
    let g = a.beatgrid.expect("beatgrid");
    assert!((g.bpm - 128.0).abs() <= 0.5, "bpm {}", g.bpm);
    assert!(
        (g.first_beat_sec - first).abs() <= 0.010,
        "first beat {}",
        g.first_beat_sec
    );
    assert!(!g.is_variable && g.anchors.is_empty());
    let beats = g.beats.expect("beats");
    assert!(
        beats.len() + 2 >= times.len(),
        "{} of {}",
        beats.len(),
        times.len()
    );
    let worst = beats
        .iter()
        .map(|b| times.iter().map(|t| (t - b).abs()).fold(f64::MAX, f64::min))
        .fold(0.0, f64::max);
    assert!(worst < 0.015, "worst beat error {worst}");
}

#[test]
fn tempo_octave_and_other_rates() {
    for (bpm, sr) in [(174.0, 48_000), (90.0, 44_100), (122.0, 22_050)] {
        let times = steady_times(0.1, bpm, 25.0);
        let audio = clicks(sr, 25.0, &times, |k| k % 4 == 0);
        let g = analyze(&audio, 1, sr, &AnalyzeOptions::default())
            .beatgrid
            .expect("grid");
        assert!((g.bpm - bpm).abs() <= 0.5, "{bpm} @ {sr}: got {}", g.bpm);
    }
}

#[test]
fn downbeat_follows_the_accented_beat() {
    let sr = 44_100;
    let times = steady_times(0.3, 126.0, 30.0);
    // Bars start on beat 1 (the second click), so the expected offset is 1.
    let audio = to_stereo(&clicks(sr, 30.0, &times, |k| k % 4 == 1));
    let g = analyze(&audio, 2, sr, &AnalyzeOptions::default())
        .beatgrid
        .expect("grid");
    let downbeat = g.first_beat_sec + g.downbeat_offset_beats as f64 * 60.0 / g.bpm;
    let bar_phase = ((downbeat - times[1]) / (4.0 * 60.0 / 126.0)).rem_euclid(1.0);
    assert!(
        bar_phase < 0.02 || bar_phase > 0.98,
        "downbeat {downbeat} ({g:?})"
    );
    assert!(
        g.downbeat_confidence > 0.5,
        "confidence {}",
        g.downbeat_confidence
    );
}

#[test]
fn tempo_drift_is_flagged_variable() {
    let sr = 22_050;
    let secs = 60.0;
    let mut times = Vec::new();
    let mut t = 0.2;
    while t < secs - 0.2 {
        times.push(t);
        let bpm = 120.0 + 8.0 * t / secs; // 120 → 128 BPM ramp
        t += 60.0 / bpm;
    }
    let audio = clicks(sr, secs, &times, |k| k % 4 == 0);
    let g = analyze(&audio, 1, sr, &AnalyzeOptions::default())
        .beatgrid
        .expect("grid");
    assert!(g.is_variable, "{g:?}");
    assert!(g.anchors.len() >= 4);
    let first = g.anchors.first().unwrap().bpm;
    let last = g.anchors.last().unwrap().bpm;
    assert!(first < 122.0 && last > 126.0, "anchors {first} → {last}");
}

fn assert_key(audio: &[f32], sr: u32, tonic: u8, mode: Mode, camelot: &str) -> KeyResult {
    let k = analyze(audio, 1, sr, &key_only()).key.expect("key");
    assert_eq!((k.tonic, k.mode), (tonic, mode), "{k:?}");
    assert_eq!(k.camelot, camelot);
    assert_eq!(k.profile, KeyProfile::Edma);
    k
}

/// Key through the shared `mixai-listen` engine (WP18-01): synthetic cadences in C major and
/// A minor must come back with the right tonic, mode and notation.
#[test]
fn cadences_give_the_right_key_through_the_shared_engine() {
    let sr = 44_100;
    let c = chords(sr, &C_MAJOR, 1.0, 4, 440.0);
    let am = chords(sr, &A_MINOR, 1.0, 4, 440.0);
    let k = assert_key(&c, sr, 0, Mode::Major, "8B");
    assert_eq!((k.name.as_str(), k.open_key.as_str()), ("C", "1d"));
    assert!(k.tuning_cents.abs() < 10.0, "tuning {}", k.tuning_cents);
    let k = assert_key(&am, sr, 9, Mode::Minor, "8A");
    assert_eq!((k.name.as_str(), k.open_key.as_str()), ("Am", "1m"));
    assert!((0.0..=1.0).contains(&k.confidence), "{k:?}");
}

#[test]
fn loudness_of_a_minus_20_dbfs_sine() {
    // BS.1770: one channel at −20 dBFS (rms −23.01 dB) + K gain +0.69 dB − 0.691 = −23.01 LUFS.
    // Same signal in both channels of a stereo file sums the channel energies: −20.0 LUFS.
    let sr = 48_000;
    let mono: Vec<f32> = (0..sr as usize * 10)
        .map(|i| (0.1 * (TAU * 1000.0 * i as f64 / sr as f64).sin()) as f32)
        .collect();
    let opts = AnalyzeOptions {
        key: false,
        tempo: false,
        peaks_per_second: 0,
        ..AnalyzeOptions::default()
    };
    let l = analyze(&mono, 1, sr, &opts).loudness.unwrap();
    assert!((l.integrated_lufs + 23.01).abs() <= 0.3, "{l:?}");
    assert!((l.true_peak_dbtp + 20.0).abs() < 0.1, "{l:?}");
    assert!((l.gain_to_minus9_db - 14.01).abs() <= 0.3);
    let l = analyze(&to_stereo(&mono), 2, sr, &opts).loudness.unwrap();
    assert!((l.integrated_lufs + 20.0).abs() <= 0.3, "{l:?}");
}

#[test]
fn peaks_have_the_requested_length() {
    let sr = 48_000;
    let audio = vec![0.0f32; (sr as f64 * 3.5) as usize * 2];
    let a = analyze(&audio, 2, sr, &AnalyzeOptions::default());
    let p = a.peaks.unwrap();
    assert_eq!(p.len, 525);
    for lane in [&p.low, &p.mid, &p.high] {
        assert_eq!(
            (lane.min.len(), lane.max.len(), lane.rms.len()),
            (525, 525, 525)
        );
    }
    let a = analyze(
        &audio,
        2,
        sr,
        &AnalyzeOptions {
            peaks_per_second: 40,
            ..AnalyzeOptions::default()
        },
    );
    assert_eq!(a.peaks.unwrap().len, 140);
    assert!(a.key.is_none() && a.beatgrid.is_none());
}

#[test]
fn analysis_round_trips_through_json() {
    let sr = 44_100;
    let times = steady_times(0.2, 128.0, 12.0);
    let mut mono = clicks(sr, 12.0, &times, |k| k % 4 == 0);
    for (o, c) in mono.iter_mut().zip(chords(sr, &C_MAJOR, 0.75, 4, 440.0)) {
        *o += c;
    }
    let a = analyze(&mono, 1, sr, &AnalyzeOptions::default());
    let json = serde_json::to_string(&a).unwrap();
    for k in [
        "\"camelot\"",
        "\"open_key\"",
        "\"first_beat_sec\"",
        "\"integrated_lufs\"",
        "\"low\"",
    ] {
        assert!(json.contains(k), "missing {k}");
    }
    let back: Analysis = serde_json::from_str(&json).unwrap();
    assert_eq!(
        back.key.as_ref().map(|k| k.camelot.clone()),
        a.key.as_ref().map(|k| k.camelot.clone())
    );
    assert_eq!(back.peaks, a.peaks);
    assert_eq!(
        back.beatgrid.as_ref().map(|g| g.downbeat_offset_beats),
        a.beatgrid.as_ref().map(|g| g.downbeat_offset_beats)
    );
}

#[test]
fn degenerate_inputs_do_not_panic() {
    let o = AnalyzeOptions::default();
    let a = analyze(&[], 2, 44_100, &o);
    assert_eq!(a.duration_sec, 0.0);
    let a = analyze(&[0.1, 0.2, 0.3], 2, 44_100, &o); // trailing partial frame
    assert_eq!(a.duration_sec, 1.0 / 44_100.0);
    let a = analyze(&[0.0; 100], 1, 0, &o);
    assert!(a.loudness.is_none());
    let short = vec![0.5f32; 2_000];
    let _ = analyze(&short, 1, 8_000, &o);
}

#[test]
fn streaming_tracks_bpm_and_key_live() {
    let sr = 44_100;
    let secs = 16.0;
    let times = steady_times(0.2, 128.0, secs);
    let mut mono = clicks(sr, secs, &times, |k| k % 4 == 0);
    for (o, c) in mono.iter_mut().zip(chords(sr, &A_MINOR, 1.0, 4, 440.0)) {
        *o += c;
    }
    let stereo = to_stereo(&mono);
    let mut s = StreamingAnalyzer::new(2, sr, StreamingOptions::default());
    // Odd chunk size: exercises the partial-frame carry.
    for chunk in stereo.chunks(1023) {
        s.push(chunk);
    }
    let snap = s.snapshot();
    assert!((snap.elapsed_sec - secs).abs() < 0.01);
    assert!(
        snap.updates >= 15 && snap.updates <= 16,
        "updates {}",
        snap.updates
    );
    let bpm = snap.bpm.expect("bpm");
    assert!((bpm - 128.0).abs() <= 1.0, "live bpm {bpm}");
    let key = snap.key.expect("key");
    assert_eq!(key.camelot, "8A", "{key:?}");
    assert!(snap.loudness.momentary_lufs.is_finite());
    s.reset();
    assert_eq!(s.snapshot().updates, 0);
}

/// Release-only timing check: `cargo test -p decks-analysis --release -- --ignored --nocapture`.
#[test]
#[ignore = "perf: run with --release --ignored"]
fn three_minute_stereo_track_analyzes_under_3_s() {
    let sr = 44_100;
    let secs = 180.0;
    let times = steady_times(0.2, 126.0, secs);
    let mut mono = clicks(sr, secs, &times, |k| k % 4 == 0);
    let pad = chords(sr, &A_MINOR, 2.0, (secs / 8.0).ceil() as usize, 440.0);
    let mut rng = Lcg(7);
    for (o, c) in mono.iter_mut().zip(pad) {
        *o += c + 0.01 * rng.next();
    }
    let stereo = to_stereo(&mono);
    let start = std::time::Instant::now();
    let a = analyze(&stereo, 2, sr, &AnalyzeOptions::default());
    let took = start.elapsed();
    println!(
        "PERF analyze 180 s stereo 44.1 kHz: {:.3} s (bpm {:?}, key {:?}, lufs {:?})",
        took.as_secs_f64(),
        a.beatgrid.as_ref().map(|g| g.bpm),
        a.key.as_ref().map(|k| k.camelot.clone()),
        a.loudness.map(|l| l.integrated_lufs),
    );
    assert!(took.as_secs_f64() < 3.0, "took {took:?}");
    assert!((a.beatgrid.unwrap().bpm - 126.0).abs() < 0.5);
    assert_eq!(a.key.unwrap().camelot, "8A");
}
