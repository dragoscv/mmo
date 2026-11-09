//! `cargo run -p decks-analysis --features decode --release --example analyze -- <file> [--no-beats] [--compact]`
//!
//! Decodes the file and prints the full analysis as JSON.

use std::process::ExitCode;
use std::time::Instant;

use decks_analysis::{AnalyzeOptions, analyze_file};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.iter().find(|a| !a.starts_with("--")) else {
        eprintln!("usage: analyze <file> [--no-beats] [--compact]");
        return ExitCode::from(2);
    };
    let mut opts = AnalyzeOptions::default();
    if args.iter().any(|a| a == "--no-beats") {
        opts.include_beats = false;
    }
    let start = Instant::now();
    match analyze_file(path, &opts) {
        Ok(a) => {
            let json = if args.iter().any(|a| a == "--compact") {
                serde_json::to_string(&a)
            } else {
                serde_json::to_string_pretty(&a)
            };
            match json {
                Ok(s) => println!("{s}"),
                Err(e) => {
                    eprintln!("serialise: {e}");
                    return ExitCode::FAILURE;
                }
            }
            eprintln!(
                "analysed {:.1} s of audio in {:.2} s",
                a.duration_sec,
                start.elapsed().as_secs_f64()
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
