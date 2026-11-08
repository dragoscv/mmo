//! GiantSteps benchmark for mixai-listen (WP18-15, D69 release gate).
//!
//! ```text
//! mixai-listen-bench --audio <dir> [--keys <dir>] [--tempo <dir>] [--limit N] [--report out.tsv] [--gate]
//! ```
//!
//! Audio files (`<id>.mp3|wav|flac`) are matched to annotations by id: `<id>.key` ("A minor", "Ab major") and
//! `<id>.bpm` (a number). The datasets are Beatport previews: download them at CI time into a private cache and
//! never commit or redistribute them. Scores: MIREX weighted key (correct 1, fifth 0.5, relative 0.3,
//! parallel 0.2) and tempo Accuracy1 (±4 %) / Accuracy2 (±4 % incl. ×2 ×½ ×3 ×⅓). `--gate` exits 1 below
//! key 0.70 or Accuracy2 0.90.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use mixai_listen::decode::decode_mono;
use mixai_listen::{Key, analyze_samples};

const KEY_GATE: f64 = 0.70;
const ACC2_GATE: f64 = 0.90;

/// MIREX key score of `est` against `reference`.
fn mirex_key(est: Key, reference: Key) -> f64 {
    if est == reference {
        return 1.0;
    }
    if est.minor == reference.minor && (est.tonic == (reference.tonic + 7) % 12 || est.tonic == (reference.tonic + 5) % 12) {
        return 0.5;
    }
    if est == reference.relative() {
        return 0.3;
    }
    if est.tonic == reference.tonic {
        return 0.2;
    }
    0.0
}

fn within(est: f64, reference: f64) -> bool {
    (est - reference).abs() <= 0.04 * reference
}

fn tempo_acc1(est: f64, reference: f64) -> bool {
    within(est, reference)
}

fn tempo_acc2(est: f64, reference: f64) -> bool {
    [1.0, 2.0, 0.5, 3.0, 1.0 / 3.0].iter().any(|f| within(est, reference * f))
}

/// `123.LOFI.mp3` → `123.LOFI`.
fn id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    Some(name.rsplit_once('.').map_or(name, |(stem, _)| stem).to_string())
}

fn read_annotations(dir: Option<&Path>, ext: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(dir) = dir else { return map };
    let Ok(entries) = std::fs::read_dir(dir) else { return map };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some(ext) {
            if let (Some(id), Ok(text)) = (id_of(&p), std::fs::read_to_string(&p)) {
                map.insert(id, text.trim().to_string());
            }
        }
    }
    map
}

struct Row {
    id: String,
    ref_key: Option<Key>,
    est_key: Option<Key>,
    key_score: Option<f64>,
    ref_bpm: Option<f64>,
    est_bpm: Option<f64>,
    acc1: Option<bool>,
    acc2: Option<bool>,
    error: Option<String>,
}

struct Args {
    audio: PathBuf,
    keys: Option<PathBuf>,
    tempo: Option<PathBuf>,
    limit: usize,
    report: Option<PathBuf>,
    gate: bool,
    dump: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let mut a = Args { audio: PathBuf::new(), keys: None, tempo: None, limit: usize::MAX, report: None, gate: false, dump: None };
    while let Some(flag) = it.next() {
        let mut value = || it.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--audio" => a.audio = value()?.into(),
            "--keys" => a.keys = Some(value()?.into()),
            "--tempo" => a.tempo = Some(value()?.into()),
            "--limit" => a.limit = value()?.parse().map_err(|_| "--limit must be a number")?,
            "--report" => a.report = Some(value()?.into()),
            "--gate" => a.gate = true,
            "--dump-features" => a.dump = Some(value()?.into()),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if a.audio.as_os_str().is_empty() {
        return Err("--audio <dir> is required".into());
    }
    Ok(a)
}

/// `A minor`, `d minor 2` (GiantSteps-MTG: trailing confidence; 0/1 = ambiguous or tonal-but-unsure → skipped),
/// `-` (no key).
fn parse_ref_key(text: &str) -> Option<Key> {
    let mut parts: Vec<&str> = text.split_whitespace().collect();
    if let Some(last) = parts.last() {
        if let Ok(conf) = last.parse::<u8>() {
            if conf < 2 {
                return None;
            }
            parts.pop();
        }
    }
    Key::parse(&parts.join(" "))
}

/// Writes `<id>.f32` (little-endian `[frames][BINS]`) and appends `<id>\t<key index>\t<frames>` to the index.
fn dump_features(dir: &Path, id: &str, key: Key, samples: &[f32], sr: u32) -> Result<String, String> {
    let spec = mixai_listen::features::log_spectrogram(samples, sr);
    let mut bytes = Vec::with_capacity(spec.len() * mixai_listen::features::BINS * 4);
    for frame in &spec {
        for v in frame {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
    }
    std::fs::write(dir.join(format!("{id}.f32")), bytes).map_err(|e| e.to_string())?;
    Ok(format!("{id}\t{}\t{}\n", key.index(), spec.len()))
}

fn evaluate(path: &Path, keys: &HashMap<String, String>, tempos: &HashMap<String, String>, dump: Option<(&Path, &Mutex<String>)>) -> Option<Row> {
    let id = id_of(path)?;
    let ref_key = keys.get(&id).and_then(|k| parse_ref_key(k));
    let ref_bpm = tempos.get(&id).and_then(|t| t.split_whitespace().next()?.parse::<f64>().ok());
    if ref_key.is_none() && ref_bpm.is_none() {
        return None;
    }
    let mut row = Row { id, ref_key, est_key: None, key_score: None, ref_bpm, est_bpm: None, acc1: None, acc2: None, error: None };
    match decode_mono(path, None) {
        Err(e) => row.error = Some(e),
        Ok((samples, sr)) => {
            if let (Some((dir, index)), Some(k)) = (dump, ref_key) {
                match dump_features(dir, &row.id, k, &samples, sr) {
                    Ok(line) => index.lock().unwrap_or_else(|e| e.into_inner()).push_str(&line),
                    Err(e) => row.error = Some(e),
                }
            }
            let a = analyze_samples(&samples, sr, 88.0);
            row.est_key = a.key.map(|k| k.key);
            row.est_bpm = a.tempo.map(|t| t.bpm);
            if let Some(r) = ref_key {
                row.key_score = Some(row.est_key.map_or(0.0, |e| mirex_key(e, r)));
            }
            if let Some(r) = ref_bpm {
                row.acc1 = Some(row.est_bpm.is_some_and(|e| tempo_acc1(e, r)));
                row.acc2 = Some(row.est_bpm.is_some_and(|e| tempo_acc2(e, r)));
            }
        }
    }
    Some(row)
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}\nusage: mixai-listen-bench --audio <dir> [--keys <dir>] [--tempo <dir>] [--limit N] [--report out.tsv] [--gate]");
            std::process::exit(2);
        }
    };
    let keys = read_annotations(args.keys.as_deref(), "key");
    let tempos = read_annotations(args.tempo.as_deref(), "bpm");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&args.audio)
        .map(|d| d.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| matches!(p.extension().and_then(|x| x.to_str()), Some("mp3" | "wav" | "flac")));
    files.retain(|p| id_of(p).is_some_and(|id| keys.contains_key(&id) || tempos.contains_key(&id)));
    files.sort();
    files.truncate(args.limit);
    eprintln!("{} annotated files ({} key, {} tempo annotations)", files.len(), keys.len(), tempos.len());

    let next = AtomicUsize::new(0);
    let rows = Mutex::new(Vec::with_capacity(files.len()));
    let index = Mutex::new(String::new());
    if let Some(dir) = &args.dump {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("--dump-features: {e}");
            std::process::exit(2);
        }
    }
    let dump = args.dump.as_deref().map(|d| (d, &index));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(path) = files.get(i) else { break };
                if let Some(row) = evaluate(path, &keys, &tempos, dump) {
                    rows.lock().unwrap_or_else(|e| e.into_inner()).push(row);
                }
                if (i + 1) % 50 == 0 {
                    eprintln!("{} / {}", i + 1, files.len());
                }
            });
        }
    });
    let mut rows = rows.into_inner().unwrap_or_else(|e| e.into_inner());
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    if let Some(dir) = &args.dump {
        let mut lines: Vec<String> = index.into_inner().unwrap_or_else(|e| e.into_inner()).lines().map(String::from).collect();
        lines.sort();
        let header = format!("# bins={} fps={}\n", mixai_listen::features::BINS, mixai_listen::features::FRAMES_PER_SEC);
        if let Err(e) = std::fs::write(dir.join("index.tsv"), header + &lines.join("\n") + "\n") {
            eprintln!("index: {e}");
        }
    }

    let key_rows: Vec<f64> = rows.iter().filter_map(|r| r.key_score).collect();
    let tempo_rows: Vec<(bool, bool)> = rows.iter().filter_map(|r| Some((r.acc1?, r.acc2?))).collect();
    let errors = rows.iter().filter(|r| r.error.is_some()).count();
    let mean = |v: &[f64]| if v.is_empty() { f64::NAN } else { v.iter().sum::<f64>() / v.len() as f64 };
    let key_weighted = mean(&key_rows);
    let correct = mean(&key_rows.iter().map(|&s| f64::from(u8::from(s == 1.0))).collect::<Vec<_>>());
    let acc1 = mean(&tempo_rows.iter().map(|t| f64::from(u8::from(t.0))).collect::<Vec<_>>());
    let acc2 = mean(&tempo_rows.iter().map(|t| f64::from(u8::from(t.1))).collect::<Vec<_>>());

    if let Some(path) = &args.report {
        let mut tsv = String::from("id\tref_key\test_key\tkey_score\tref_bpm\test_bpm\tacc1\tacc2\terror\n");
        let opt = |v: Option<String>| v.unwrap_or_default();
        for r in &rows {
            tsv.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
                r.id,
                opt(r.ref_key.map(|k| k.name())),
                opt(r.est_key.map(|k| k.name())),
                opt(r.key_score.map(|s| s.to_string())),
                opt(r.ref_bpm.map(|b| format!("{b:.2}"))),
                opt(r.est_bpm.map(|b| format!("{b:.2}"))),
                opt(r.acc1.map(|b| b.to_string())),
                opt(r.acc2.map(|b| b.to_string())),
                opt(r.error.clone()),
            ));
        }
        if let Err(e) = std::fs::write(path, tsv) {
            eprintln!("report: {e}");
        }
    }

    println!("files\t{}\nerrors\t{errors}", rows.len());
    println!("key_tracks\t{}\nkey_weighted\t{key_weighted:.4}\nkey_correct\t{correct:.4}", key_rows.len());
    println!("tempo_tracks\t{}\ntempo_acc1\t{acc1:.4}\ntempo_acc2\t{acc2:.4}", tempo_rows.len());
    if args.gate {
        let key_ok = key_rows.is_empty() || key_weighted >= KEY_GATE;
        let tempo_ok = tempo_rows.is_empty() || acc2 >= ACC2_GATE;
        println!("gate\tkey {}\ttempo {}", if key_ok { "PASS" } else { "FAIL" }, if tempo_ok { "PASS" } else { "FAIL" });
        if !(key_ok && tempo_ok) || rows.is_empty() {
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> Key {
        Key::parse(s).unwrap()
    }

    #[test]
    fn mirex_key_scoring() {
        assert_eq!(mirex_key(k("A minor"), k("A minor")), 1.0);
        assert_eq!(mirex_key(k("E minor"), k("A minor")), 0.5);
        assert_eq!(mirex_key(k("D minor"), k("A minor")), 0.5);
        assert_eq!(mirex_key(k("C major"), k("A minor")), 0.3);
        assert_eq!(mirex_key(k("A major"), k("A minor")), 0.2);
        assert_eq!(mirex_key(k("E major"), k("A minor")), 0.0);
        assert_eq!(mirex_key(k("Ab major"), k("G# major")), 1.0);
    }

    #[test]
    fn tempo_accuracies() {
        assert!(tempo_acc1(127.0, 128.0));
        assert!(!tempo_acc1(64.0, 128.0));
        assert!(tempo_acc2(64.0, 128.0));
        assert!(tempo_acc2(174.0, 87.0));
        assert!(tempo_acc2(120.0, 40.0));
        assert!(!tempo_acc2(140.0, 128.0));
    }

    #[test]
    fn ids_strip_only_the_last_extension() {
        assert_eq!(id_of(Path::new("x/123.LOFI.mp3")).as_deref(), Some("123.LOFI"));
        assert_eq!(id_of(Path::new("123.LOFI.key")).as_deref(), Some("123.LOFI"));
    }

    #[test]
    fn reference_keys_in_both_dataset_formats() {
        assert_eq!(parse_ref_key("A minor"), Some(k("A minor")));
        assert_eq!(parse_ref_key("f# minor\t2"), Some(k("F# minor")));
        assert_eq!(parse_ref_key("d minor 1"), None);
        assert_eq!(parse_ref_key("-"), None);
    }
}
