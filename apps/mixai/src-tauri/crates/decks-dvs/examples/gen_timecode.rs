//! Render MixAI timecode to a WAV file for cutting control vinyl or burning a control CD.
//!
//! ```text
//! cargo run -p decks-dvs --example gen_timecode -- out.wav [minutes=15] [sample_rate=44100]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next().map(PathBuf::from) else {
        eprintln!("usage: gen_timecode <out.wav> [minutes=15] [sample_rate=44100]");
        return ExitCode::from(2);
    };
    let minutes: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(15.0);
    let sample_rate: u32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(44_100);
    match decks_dvs::write_timecode_wav(&path, minutes, sample_rate) {
        Ok(()) => {
            println!(
                "wrote {minutes} min of MixAI timecode at {sample_rate} Hz to {} (max {:.2} min)",
                path.display(),
                decks_dvs::max_minutes()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
