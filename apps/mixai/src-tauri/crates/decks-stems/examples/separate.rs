//! `cargo run -p decks-stems --example separate --features onnx --release -- <onnxruntime lib> <htdemucs.onnx> <in.wav> <out dir>`
//!
//! Separates a WAV with HT-Demucs and writes the four stems into `<out dir>/<cache key>/`. Prints the
//! wall time and real-time factor so device benchmarks are comparable.

use std::path::Path;
use std::time::Instant;

use decks_stems::{OnnxSeparator, StemCache, cache_key, separate};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 5 {
        eprintln!("usage: separate <onnxruntime lib> <model.onnx> <in.wav> <out dir>");
        std::process::exit(2);
    }
    let (lib, model, input, out) = (
        Path::new(&args[1]),
        Path::new(&args[2]),
        Path::new(&args[3]),
        Path::new(&args[4]),
    );

    let mut r = hound::WavReader::open(input)?;
    let spec = r.spec();
    let ch = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let s = 1.0 / (1u64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>()
                .map(|v| v.map(|x| x as f32 * s))
                .collect::<Result<_, _>>()?
        }
    };
    let left: Vec<f32> = samples.chunks_exact(ch).map(|f| f[0]).collect();
    let right: Vec<f32> = samples
        .chunks_exact(ch)
        .map(|f| if ch > 1 { f[1] } else { f[0] })
        .collect();
    let secs = left.len() as f64 / spec.sample_rate as f64;

    let t0 = Instant::now();
    let mut sep = OnnxSeparator::load(lib, model, &[])?;
    println!(
        "loaded in {:.2}s, targets {:?}",
        t0.elapsed().as_secs_f64(),
        sep.targets()
    );

    let t1 = Instant::now();
    let stems = separate(&mut sep, &left, &right, spec.sample_rate, None, &mut |p| {
        eprintln!("segment {}/{}", p.done, p.total);
    })?;
    let el = t1.elapsed().as_secs_f64();
    println!(
        "separated {secs:.1}s of audio in {el:.2}s (RTF {:.3})",
        el / secs
    );

    let key = cache_key(input, "htdemucs")?;
    let dir = StemCache::new(out).store(&key, &stems)?;
    println!("wrote {}", dir.display());
    Ok(())
}
