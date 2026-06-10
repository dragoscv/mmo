//! Off-thread audio file decoding via symphonia (permissive, MPL-2.0).
//! Produces a planar stereo `TrackBuffer` at the file's native sample rate.
//! Resampling to the device rate is handled per-sample by the deck's varispeed
//! read (rate_ratio); a future revision can pre-resample with `rubato`.

use std::fs::File;
use std::io::Cursor;
use std::path::Path;

use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::deck::TrackBuffer;
use crate::error::CoreError;

pub fn decode_file(path: &str) -> Result<TrackBuffer, CoreError> {
    let file = File::open(Path::new(path))
        .map_err(|e| CoreError::Decode(format!("open {path}: {e}")))?;
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
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| CoreError::Decode(format!("probe: {e}")))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| CoreError::Decode("no audio track".into()))?;
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| CoreError::Decode(format!("make decoder: {e}")))?;

    let mut left: Vec<f32> = Vec::new();
    let mut right: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break, // end of stream / IO end
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => append_samples(&decoded, &mut left, &mut right),
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
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
fn append_samples(decoded: &AudioBufferRef<'_>, left: &mut Vec<f32>, right: &mut Vec<f32>) {
    macro_rules! handle {
        ($buf:expr, $conv:expr) => {{
            let spec = $buf.spec();
            let frames = $buf.frames();
            let chans = spec.channels.count();
            if chans == 0 {
                return;
            }
            let l = $buf.chan(0);
            let r = if chans > 1 { $buf.chan(1) } else { $buf.chan(0) };
            for i in 0..frames {
                left.push($conv(l[i]));
                right.push($conv(r[i]));
            }
        }};
    }

    match decoded {
        AudioBufferRef::F32(b) => handle!(b, |s: f32| s),
        AudioBufferRef::S16(b) => handle!(b, |s: i16| s as f32 / 32768.0),
        AudioBufferRef::S32(b) => handle!(b, |s: i32| s as f32 / 2147483648.0),
        AudioBufferRef::U8(b) => handle!(b, |s: u8| (s as f32 - 128.0) / 128.0),
        AudioBufferRef::F64(b) => handle!(b, |s: f64| s as f32),
        AudioBufferRef::S24(b) => handle!(b, |s: symphonia::core::sample::i24| s.inner() as f32 / 8388608.0),
        AudioBufferRef::U24(b) => handle!(b, |s: symphonia::core::sample::u24| (s.inner() as f32 - 8388608.0) / 8388608.0),
        AudioBufferRef::U16(b) => handle!(b, |s: u16| (s as f32 - 32768.0) / 32768.0),
        AudioBufferRef::U32(b) => handle!(b, |s: u32| (s as f32 - 2147483648.0) / 2147483648.0),
        AudioBufferRef::S8(b) => handle!(b, |s: i8| s as f32 / 128.0),
    }
}
