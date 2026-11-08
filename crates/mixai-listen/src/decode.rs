//! File mode decoding (feature `decode`): any symphonia-supported file → mono f32.

use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::{Analysis, analyze_samples};

/// Decodes `path` to mono samples, stopping after `max_secs` (None = whole file).
pub fn decode_mono(path: &Path, max_secs: Option<f64>) -> Result<(Vec<f32>, u32), String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("no audio track")?;
    let track_id = track.id;
    let mut sr = track.codec_params.sample_rate.unwrap_or(44_100);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        sr = spec.rate;
        let ch = spec.channels.count().max(1);
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        out.extend(buf.samples().chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32));
        if max_secs.is_some_and(|m| out.len() as f64 >= m * sr as f64) {
            break;
        }
    }
    if out.is_empty() {
        return Err("no samples decoded".into());
    }
    Ok((out, sr))
}

/// File mode: decode (first 10 minutes at most) and analyse.
pub fn analyze_file(path: &Path, bpm_floor: f64) -> Result<Analysis, String> {
    let (samples, sr) = decode_mono(path, Some(600.0))?;
    Ok(analyze_samples(&samples, sr, bpm_floor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_wav_and_reports_its_rate() {
        let sr = 22_050u32;
        let n = sr as usize;
        let mut wav = Vec::new();
        let data_len = (n * 2) as u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&sr.to_le_bytes());
        wav.extend_from_slice(&(sr * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..n {
            let v = (8000.0 * (std::f32::consts::TAU * 440.0 * i as f32 / sr as f32).sin()) as i16;
            wav.extend_from_slice(&v.to_le_bytes());
        }
        let path = std::env::temp_dir().join(format!("mixai-listen-{}.wav", std::process::id()));
        std::fs::write(&path, wav).unwrap();
        let (s, rate) = decode_mono(&path, None).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(rate, sr);
        assert_eq!(s.len(), n);
        assert!(decode_mono(Path::new("does-not-exist.mp3"), None).is_err());
    }
}
