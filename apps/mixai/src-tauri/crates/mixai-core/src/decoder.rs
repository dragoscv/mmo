//! Off-thread audio file decoding via symphonia (permissive, MPL-2.0).
//! Produces a planar stereo `TrackBuffer` at the file's native sample rate.
//! Resampling to the device rate is handled per-sample by the deck's varispeed
//! read (rate_ratio); a future revision can pre-resample with `rubato`.

use std::fs::File;
use std::io::Cursor;
use std::path::Path;

use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::deck::TrackBuffer;
use crate::error::CoreError;

pub fn decode_file(path: &str) -> Result<TrackBuffer, CoreError> {
    let file =
        File::open(Path::new(path)).map_err(|e| CoreError::Decode(format!("open {path}: {e}")))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    decode_stream(mss, hint)
}

/// Decode an in-memory encoded audio buffer (e.g. fetched over HTTP from a
/// remote companion / cloud). `ext` is an optional container hint such as
/// `"mp3"` / `"flac"` to help probing when there's no filename.
pub fn decode_bytes(bytes: Vec<u8>, ext: Option<&str>) -> Result<TrackBuffer, CoreError> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = ext {
        hint.with_extension(ext);
    }
    decode_stream(mss, hint)
}

/// Shared decode loop over any `MediaSourceStream`.
fn decode_stream(mss: MediaSourceStream, hint: Hint) -> Result<TrackBuffer, CoreError> {
    // symphonia 0.6: `Probe::probe` returns the `FormatReader` directly and takes options by value.
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| CoreError::Decode(format!("probe: {e}")))?;

    // 0.6: tracks carry `Option<CodecParameters>` (audio/video/subtitle); `default_track`
    // picks the default-flagged or first audio track with a known codec.
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| CoreError::Decode("no audio track".into()))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| CoreError::Decode("no audio codec parameters".into()))?
        .clone();
    let sample_rate = params.sample_rate.unwrap_or(44100);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| CoreError::Decode(format!("make decoder: {e}")))?;

    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();
    let mut planes: Vec<Vec<f32>> = Vec::new();

    // 0.6: end of stream is `Ok(None)` instead of an `UnexpectedEof` IO error.
    while let Ok(Some(packet)) = format.next_packet() {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => append_samples(&decoded, &mut planes, &mut left, &mut right),
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(_) => break,
        }
    }

    if left.is_empty() {
        return Err(CoreError::Decode("decoded zero frames".into()));
    }
    // Guarantee equal channel lengths.
    let n = left.len().min(right.len());
    left.truncate(n);
    right.truncate(n);

    Ok(TrackBuffer {
        left,
        right,
        sample_rate,
    })
}

/// Convert any symphonia buffer to planar stereo f32 and append.
///
/// symphonia 0.6 converts every sample format to f32 itself (`copy_to_vecs_planar`), so the
/// per-format match of 0.5 is gone. `planes` is a reusable scratch buffer (one Vec per channel).
fn append_samples(
    decoded: &GenericAudioBufferRef<'_>,
    planes: &mut Vec<Vec<f32>>,
    left: &mut Vec<f32>,
    right: &mut Vec<f32>,
) {
    if decoded.num_planes() == 0 || decoded.frames() == 0 {
        return;
    }
    decoded.copy_to_vecs_planar::<f32>(planes);
    let l = &planes[0];
    let r = planes.get(1).unwrap_or(l);
    left.extend_from_slice(l);
    right.extend_from_slice(r);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode a WAV in memory with hound (already a dependency) so the test needs no fixture file.
    fn wav_bytes(channels: u16, sample_rate: u32, frames: &[(i16, i16)]) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cur = Cursor::new(Vec::new());
        {
            let mut w = hound::WavWriter::new(&mut cur, spec).unwrap();
            for &(l, r) in frames {
                w.write_sample(l).unwrap();
                if channels == 2 {
                    w.write_sample(r).unwrap();
                }
            }
            w.finalize().unwrap();
        }
        cur.into_inner()
    }

    #[test]
    fn decodes_stereo_wav_to_planar_f32() {
        let frames: Vec<(i16, i16)> = (0..4096)
            .map(|i| ((i % 100) as i16 * 100, -16384))
            .collect();
        let buf = decode_bytes(wav_bytes(2, 48_000, &frames), Some("wav")).unwrap();
        assert_eq!(buf.sample_rate, 48_000);
        assert_eq!(buf.left.len(), frames.len());
        assert_eq!(buf.right.len(), frames.len());
        assert!((buf.left[1] - 100.0 / 32768.0).abs() < 1e-4);
        assert!((buf.right[0] + 0.5).abs() < 1e-4);
    }

    #[test]
    fn mono_wav_is_duplicated_to_both_channels() {
        let frames: Vec<(i16, i16)> = (0..1000).map(|i| (i as i16 * 10, 0)).collect();
        let buf = decode_bytes(wav_bytes(1, 44_100, &frames), None).unwrap();
        assert_eq!(buf.sample_rate, 44_100);
        assert_eq!(buf.left.len(), 1000);
        assert_eq!(buf.left, buf.right);
    }

    #[test]
    fn garbage_input_is_a_decode_error() {
        assert!(decode_bytes(vec![0u8; 64], Some("mp3")).is_err());
    }
}
