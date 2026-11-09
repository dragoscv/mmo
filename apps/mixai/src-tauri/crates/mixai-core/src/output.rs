//! Output device + stream configuration selection.
//!
//! [`choose_config`] is a pure function (supported config ranges in, chosen config + fallback
//! notes out) so the fallback rules are testable without an audio device. The cpal glue
//! ([`find_output_device`], [`device_ranges`]) lives next to it.

use std::cmp::Reverse;

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

/// One supported output configuration range (cpal `SupportedStreamConfigRange`, f32 only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigRange {
    pub channels: u16,
    pub min_sample_rate: u32,
    pub max_sample_rate: u32,
    /// Supported callback buffer size range in frames; `None` = the backend does not say.
    pub buffer: Option<(u32, u32)>,
}

/// The device's default output configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultConfig {
    pub channels: u16,
    pub sample_rate: u32,
    pub buffer: Option<(u32, u32)>,
}

/// Requested callback buffer size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferChoice {
    /// Let the backend pick.
    Default,
    /// Fixed frames per callback.
    Fixed(u32),
}

/// Result of [`choose_config`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChoice {
    pub channels: u16,
    pub sample_rate: u32,
    pub buffer: BufferChoice,
    /// `false` when a fixed buffer was requested but the backend reports no range: the stream
    /// build may still reject it (the engine then falls back to the default buffer).
    pub buffer_verified: bool,
    /// One line per requested setting that could not be honoured.
    pub notes: Vec<String>,
}

/// What the engine actually opened.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    /// Device id (`host:id`, as in [`crate::list_output_devices`]); `None` when unknown.
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate: u32,
    pub channels: u16,
    /// Frames per callback: the fixed size when one was applied, else the size observed in the
    /// audio callback (`None` until the first callback ran).
    pub buffer_frames: Option<u32>,
    pub latency_ms: f32,
    /// Requested settings that fell back, one line each (empty = everything honoured).
    pub notes: Vec<String>,
}

/// Pick the stream config for the requested sample rate / buffer size, falling back to the
/// device default for anything unsupported.
///
/// Sample rate: a range containing the rate with the default channel count wins, then the one
/// with the most channels. Buffer: clamped into the device range when it reports one.
pub fn choose_config(
    ranges: &[ConfigRange],
    default: &DefaultConfig,
    want_rate: Option<u32>,
    want_buffer: Option<u32>,
) -> ConfigChoice {
    let fits = |r: &ConfigRange, sr: u32| (r.min_sample_rate..=r.max_sample_rate).contains(&sr);
    let mut notes = Vec::new();
    let (mut channels, mut sample_rate) = (default.channels, default.sample_rate);
    let mut range: Option<&ConfigRange> = None;

    match want_rate {
        None => {}
        Some(0) => notes.push(format!(
            "sample_rate 0 is invalid; using the device default {sample_rate} Hz"
        )),
        Some(want) if want == default.sample_rate => {}
        Some(want) => {
            let pick = ranges
                .iter()
                .filter(|r| fits(r, want))
                .min_by_key(|r| (r.channels != default.channels, Reverse(r.channels)));
            match pick {
                Some(r) => {
                    if r.channels != default.channels {
                        notes.push(format!(
                            "{} Hz is only supported with {} channels (default {}); using {} channels",
                            want, r.channels, default.channels, r.channels
                        ));
                    }
                    channels = r.channels;
                    sample_rate = want;
                    range = Some(r);
                }
                None => notes.push(format!(
                    "sample_rate {want} Hz is not supported by the device; using its default {sample_rate} Hz"
                )),
            }
        }
    }

    let buf_range = match range.or_else(|| {
        ranges
            .iter()
            .find(|r| r.channels == channels && fits(r, sample_rate))
    }) {
        Some(r) => r.buffer.or(default.buffer),
        None => default.buffer,
    };

    let (buffer, buffer_verified) = match want_buffer {
        None => (BufferChoice::Default, true),
        Some(0) => {
            notes.push("buffer_frames 0 is invalid; using the device default buffer".into());
            (BufferChoice::Default, true)
        }
        Some(b) => match buf_range {
            Some((lo, hi)) if lo <= hi && hi > 0 => {
                let c = b.clamp(lo.max(1), hi);
                if c != b {
                    notes.push(format!(
                        "buffer_frames {b} is outside the device range {lo}..{hi}; using {c}"
                    ));
                }
                (BufferChoice::Fixed(c), true)
            }
            _ => (BufferChoice::Fixed(b), false),
        },
    };

    ConfigChoice {
        channels,
        sample_rate,
        buffer,
        buffer_verified,
        notes,
    }
}

fn buffer_range(b: &cpal::SupportedBufferSize) -> Option<(u32, u32)> {
    match b {
        cpal::SupportedBufferSize::Range { min, max } => Some((*min, *max)),
        cpal::SupportedBufferSize::Unknown => None,
    }
}

/// Supported f32 ranges (all ranges if the device offers no f32) + the default config.
pub(crate) fn device_ranges(
    device: &cpal::Device,
) -> Result<(Vec<ConfigRange>, DefaultConfig), String> {
    let def = device
        .default_output_config()
        .map_err(|e| format!("default config: {e}"))?;
    let default = DefaultConfig {
        channels: def.channels(),
        sample_rate: def.sample_rate(),
        buffer: buffer_range(def.buffer_size()),
    };
    let all: Vec<_> = device
        .supported_output_configs()
        .map(|it| it.collect())
        .unwrap_or_default();
    let has_f32 = all
        .iter()
        .any(|r| r.sample_format() == cpal::SampleFormat::F32);
    let ranges = all
        .iter()
        .filter(|r| !has_f32 || r.sample_format() == cpal::SampleFormat::F32)
        .map(|r| ConfigRange {
            channels: r.channels(),
            min_sample_rate: r.min_sample_rate(),
            max_sample_rate: r.max_sample_rate(),
            buffer: buffer_range(r.buffer_size()),
        })
        .collect();
    Ok((ranges, default))
}

/// Resolve an output device id as produced by [`crate::list_output_devices`] (`host:id`, or the
/// device name when the backend had no id).
pub fn find_output_device(id: &str) -> Option<cpal::Device> {
    if let Ok(did) = id.parse::<cpal::DeviceId>()
        && let Ok(host) = cpal::host_from_id(did.host())
        && let Some(d) = host.device_by_id(&did)
    {
        return Some(d);
    }
    cpal::default_host().output_devices().ok()?.find(|d| {
        d.description()
            .map(|desc| desc.name() == id)
            .unwrap_or(false)
    })
}

/// `host:id` of a device (falls back to its name).
pub(crate) fn device_id_of(d: &cpal::Device) -> Option<String> {
    d.id()
        .map(|id| id.to_string())
        .ok()
        .or_else(|| device_name_of(d))
}

pub(crate) fn device_name_of(d: &cpal::Device) -> Option<String> {
    d.description().map(|desc| desc.name().to_owned()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEF: DefaultConfig = DefaultConfig {
        channels: 2,
        sample_rate: 48_000,
        buffer: Some((64, 4096)),
    };

    fn ranges() -> Vec<ConfigRange> {
        vec![
            ConfigRange {
                channels: 2,
                min_sample_rate: 44_100,
                max_sample_rate: 48_000,
                buffer: Some((64, 4096)),
            },
            ConfigRange {
                channels: 4,
                min_sample_rate: 44_100,
                max_sample_rate: 96_000,
                buffer: Some((128, 2048)),
            },
            ConfigRange {
                channels: 8,
                min_sample_rate: 96_000,
                max_sample_rate: 96_000,
                buffer: Some((128, 2048)),
            },
        ]
    }

    #[test]
    fn nothing_requested_uses_default_without_notes() {
        let c = choose_config(&ranges(), &DEF, None, None);
        assert_eq!((c.channels, c.sample_rate), (2, 48_000));
        assert_eq!(c.buffer, BufferChoice::Default);
        assert!(c.notes.is_empty());
    }

    #[test]
    fn supported_rate_and_buffer_are_honoured() {
        let c = choose_config(&ranges(), &DEF, Some(44_100), Some(256));
        assert_eq!((c.channels, c.sample_rate), (2, 44_100));
        assert_eq!(c.buffer, BufferChoice::Fixed(256));
        assert!(c.buffer_verified);
        assert!(c.notes.is_empty(), "{:?}", c.notes);
    }

    #[test]
    fn default_rate_needs_no_range() {
        let c = choose_config(&[], &DEF, Some(48_000), None);
        assert_eq!(c.sample_rate, 48_000);
        assert!(c.notes.is_empty());
    }

    #[test]
    fn rate_only_on_other_channels_prefers_most_channels_and_notes_it() {
        let c = choose_config(&ranges(), &DEF, Some(96_000), None);
        assert_eq!((c.channels, c.sample_rate), (8, 96_000));
        assert_eq!(c.notes.len(), 1, "{:?}", c.notes);
        assert!(c.notes[0].contains("8 channels"));
    }

    #[test]
    fn unsupported_rate_falls_back_to_default() {
        let c = choose_config(&ranges(), &DEF, Some(192_000), None);
        assert_eq!((c.channels, c.sample_rate), (2, 48_000));
        assert_eq!(c.notes.len(), 1);
        assert!(c.notes[0].contains("192000"));
    }

    #[test]
    fn buffer_is_clamped_into_the_chosen_range() {
        let c = choose_config(&ranges(), &DEF, Some(96_000), Some(16));
        // 8-channel range at 96 kHz: 128..2048.
        assert_eq!(c.buffer, BufferChoice::Fixed(128));
        assert!(
            c.notes.iter().any(|n| n.contains("128..2048")),
            "{:?}",
            c.notes
        );
        let c = choose_config(&ranges(), &DEF, None, Some(10_000));
        assert_eq!(c.buffer, BufferChoice::Fixed(4096));
    }

    #[test]
    fn unknown_buffer_range_is_tried_unverified() {
        let def = DefaultConfig {
            buffer: None,
            ..DEF
        };
        let r = [ConfigRange {
            buffer: None,
            ..ranges()[0]
        }];
        let c = choose_config(&r, &def, None, Some(512));
        assert_eq!(c.buffer, BufferChoice::Fixed(512));
        assert!(!c.buffer_verified);
        assert!(c.notes.is_empty());
    }

    #[test]
    fn zero_values_are_rejected_with_notes() {
        let c = choose_config(&ranges(), &DEF, Some(0), Some(0));
        assert_eq!((c.sample_rate, c.buffer), (48_000, BufferChoice::Default));
        assert_eq!(c.notes.len(), 2);
    }
}
