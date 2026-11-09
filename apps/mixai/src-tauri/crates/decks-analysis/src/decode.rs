//! Optional file decoding (feature `decode`, symphonia 0.6 — MPL-2.0, file-level copyleft).

use std::fmt;
use std::fs::File;
use std::path::Path;

use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::{Analysis, AnalyzeOptions, analyze};

/// Decode / IO failure.
#[derive(Debug)]
pub struct ListenError(pub String);

impl fmt::Display for ListenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ListenError {}

/// Interleaved decoded audio.
#[derive(Debug, Clone)]
pub struct DecodedAudio {
    pub samples: Vec<f32>,
    pub channels: u16,
    pub sample_rate: u32,
}

/// Decode a whole file to interleaved f32 at its native rate and channel count.
pub fn decode_file(path: impl AsRef<Path>) -> Result<DecodedAudio, ListenError> {
    let path = path.as_ref();
    let file =
        File::open(path).map_err(|e| ListenError(format!("open {}: {e}", path.display())))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| ListenError(format!("probe: {e}")))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| ListenError("no audio track".into()))?;
    let track_id = track.id;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| ListenError("no audio codec parameters".into()))?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())
        .map_err(|e| ListenError(format!("make decoder: {e}")))?;

    let mut sample_rate = params.sample_rate.unwrap_or(0);
    let mut channels = 0usize;
    let mut samples = Vec::new();
    let mut planes: Vec<Vec<f32>> = Vec::new();
    while let Ok(Some(packet)) = format.next_packet() {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                if sample_rate == 0 {
                    sample_rate = decoded.spec().rate();
                }
                append(&decoded, &mut planes, &mut channels, &mut samples);
            }
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(e) => return Err(ListenError(format!("decode: {e}"))),
        }
    }
    if samples.is_empty() || channels == 0 || sample_rate == 0 {
        return Err(ListenError("decoded zero frames".into()));
    }
    Ok(DecodedAudio {
        samples,
        channels: channels as u16,
        sample_rate,
    })
}

fn append(
    decoded: &GenericAudioBufferRef<'_>,
    planes: &mut Vec<Vec<f32>>,
    channels: &mut usize,
    out: &mut Vec<f32>,
) {
    if decoded.num_planes() == 0 || decoded.frames() == 0 {
        return;
    }
    decoded.copy_to_vecs_planar::<f32>(planes);
    let n = decoded.num_planes();
    if *channels == 0 {
        *channels = n;
    }
    let ch = *channels;
    let frames = planes.iter().take(n).map(Vec::len).min().unwrap_or(0);
    out.reserve(frames * ch);
    for i in 0..frames {
        for c in 0..ch {
            let plane = if c < n { &planes[c] } else { &planes[0] };
            out.push(plane.get(i).copied().unwrap_or(0.0));
        }
    }
}

/// Decode and analyse a file.
pub fn analyze_file(
    path: impl AsRef<Path>,
    opts: &AnalyzeOptions,
) -> Result<Analysis, ListenError> {
    let a = decode_file(path)?;
    Ok(analyze(&a.samples, a.channels, a.sample_rate, opts))
}
