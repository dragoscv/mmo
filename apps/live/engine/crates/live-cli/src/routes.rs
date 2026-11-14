//! The routes this engine can drive, compared on what each one *declares*.
//!
//! Everything here is read from a driver or from a setting: the device's own period limits, the
//! requested buffer, Voicemeeter's buffer sizes. Nothing is measured through a loopback — that is
//! what `latency` does, and it needs the cable. A declared figure is a chooser; only a measured one
//! is the truth about a route, so the two are never added together or presented as the same number.

use live_engine::{IoConfig, voicemeeter};
use serde_json::{Value, json};

/// The three buffer terms of a route, in frames, and their sum in milliseconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Terms {
    pub input_period_frames: u32,
    /// Frames kept queued between input and output (0 when both are the same callback).
    pub cushion_frames: u32,
    pub output_period_frames: u32,
    pub declared_ms: f32,
}

impl Terms {
    pub fn to_json(self) -> Value {
        json!({
            "input_period_frames": self.input_period_frames,
            "cushion_frames": self.cushion_frames,
            "output_period_frames": self.output_period_frames,
            // As f64: an f32 10.67 serialises as 10.670000076293945.
            "declared_ms": (f64::from(self.declared_ms) * 100.0).round() / 100.0,
        })
    }
}

fn terms(input: u32, cushion: u32, output: u32, rate: u32) -> Terms {
    let frames = input + cushion + output;
    Terms {
        input_period_frames: input,
        cushion_frames: cushion,
        output_period_frames: output,
        declared_ms: if rate == 0 {
            0.0
        } else {
            frames as f32 * 1000.0 / rate as f32
        },
    }
}

/// Where each figure of a route comes from, so a reader can tell a read value from an assumption.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Read from the driver (its period limits).
    Device,
    /// Read from another program's configuration (Voicemeeter).
    Voicemeeter,
    /// Not readable without opening the device: the figure is the request, not the truth.
    Assumed,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Device => "device",
            Source::Voicemeeter => "voicemeeter",
            Source::Assumed => "assumed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    pub host: String,
    pub device: Option<String>,
    pub terms: Terms,
    pub source: Source,
    /// What the driver really runs, when that could be read.
    pub device_periods: Option<DevicePeriods>,
    pub note: String,
    /// A measured round trip is never put here: fill it with `latency` on a real loopback.
    pub measured_ms: Option<f32>,
}

impl Route {
    pub fn to_json(&self) -> Value {
        json!({
            "host": self.host,
            "device": self.device,
            "terms": self.terms.to_json(),
            "source": self.source.as_str(),
            "device_periods": self.device_periods.map(|p| json!({
                "exclusive_min": p.exclusive_min,
                "shared_min": p.shared_min,
                "shared_default": p.shared_default,
                "shared_rate": p.shared_rate,
            })),
            "note": self.note,
            "measured_ms": self.measured_ms,
        })
    }
}

/// The period limits of one endpoint (see `mixai-live-engine periods`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DevicePeriods {
    pub exclusive_min: u32,
    pub shared_min: Option<u32>,
    pub shared_default: Option<u32>,
    pub shared_rate: Option<u32>,
}

/// What the routes are, from what could be read. Pure: no device is opened.
///
/// * the exclusive route runs at the larger of the request and the device's own minimum;
/// * the shared route runs at the Windows mixer's default period (the request only sizes the ring);
/// * Voicemeeter's insert route pays its input buffer and its A1 buffer, nothing else;
/// * an ASIO driver's buffer cannot be read without opening it, so its figure is the request.
pub fn declared(
    rate: u32,
    buffer: u32,
    exclusive_min: Option<u32>,
    device_periods: Option<DevicePeriods>,
    voicemeeter_buffers: Option<&VoicemeeterBuffers>,
) -> Vec<Route> {
    let mut out = Vec::new();

    let excl = exclusive_min.map_or(buffer, |min| buffer.max(min));
    out.push(Route {
        host: "WASAPI Exclusive".into(),
        device: None,
        terms: terms(excl, excl, excl, rate),
        source: if exclusive_min.is_some() {
            Source::Device
        } else {
            Source::Assumed
        },
        device_periods,
        note: match exclusive_min {
            Some(min) if min > buffer => format!(
                "the device's minimum is {min} frames, so a request of {buffer} runs at {min}"
            ),
            Some(_) => "the device accepts the requested period".into(),
            None => {
                "the device's minimum could not be read: this is the request, not the truth".into()
            }
        },
        measured_ms: None,
    });

    let shared = device_periods
        .and_then(|p| p.shared_default)
        .unwrap_or(buffer);
    out.push(Route {
        host: "WASAPI (shared)".into(),
        device: None,
        terms: terms(shared, shared, shared, rate),
        source: if device_periods.and_then(|p| p.shared_default).is_some() {
            Source::Device
        } else {
            Source::Assumed
        },
        device_periods,
        note: "shared mode runs at the Windows mixer's period; the mixer's own buffering is not declared here".into(),
        measured_ms: None,
    });

    if let Some(vm) = voicemeeter_buffers {
        // The engine runs inside Voicemeeter's callback: its input buffer and its A1 buffer are the
        // whole declared path, and there is no second stream to queue between.
        out.push(Route {
            host: "Voicemeeter Insert".into(),
            device: vm.a1_device.clone(),
            terms: terms(vm.frames, 0, vm.frames, rate),
            source: Source::Voicemeeter,
            device_periods: None,
            note: "the insert point is Voicemeeter's own callback: no device is opened and the engine adds no buffer; whether the insert point itself adds one is not documented by VB-Audio".into(),
            measured_ms: None,
        });
    }

    out.push(Route {
        host: "ASIO".into(),
        device: None,
        terms: terms(buffer, buffer, buffer, rate),
        source: Source::Assumed,
        device_periods: None,
        note: "an ASIO driver's own buffer size is not readable without opening the device, so this is the request; its real figure is whatever the driver runs".into(),
        measured_ms: None,
    });

    out
}

/// The Voicemeeter numbers a route needs.
#[derive(Clone, Debug, PartialEq)]
pub struct VoicemeeterBuffers {
    /// Frames per buffer Voicemeeter runs (the size of its own audio stream).
    pub frames: u32,
    pub a1_device: Option<String>,
}

/// Read what this machine can tell: the endpoint's period limits, Voicemeeter's buffer, nothing more.
pub fn collect(cfg: &IoConfig) -> Vec<Route> {
    let device = cfg.output.as_deref().or(cfg.input.as_deref());
    let read = device
        .and_then(|d| {
            live_engine::io::device_periods(d, cfg.sample_rate)
                .ok()
                .flatten()
        })
        .map(|p| {
            (
                p.exclusive_min,
                DevicePeriods {
                    exclusive_min: p.exclusive_min,
                    shared_min: p.shared_min,
                    shared_default: p.shared_default,
                    shared_rate: p.shared_rate,
                },
            )
        });
    let (exclusive_min, periods) = match read {
        Some((min, p)) => (Some(min), Some(p)),
        None => (None, None),
    };
    let vm = {
        let info = voicemeeter::info();
        if !info.running {
            None
        } else {
            // The stream's own buffer: the WDM size is what the driver list reports for a WDM A1,
            // and the engine cannot ask Voicemeeter which driver A1 uses.
            let frames = [
                info.buffer_wdm,
                info.buffer_ks,
                info.buffer_mme,
                info.buffer_asio,
            ]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(0);
            (frames > 0).then(|| VoicemeeterBuffers {
                frames,
                a1_device: info.a1_device.clone(),
            })
        }
    };
    let mut routes = declared(
        cfg.sample_rate,
        cfg.buffer_frames,
        exclusive_min,
        periods,
        vm.as_ref(),
    );
    for r in &mut routes {
        // The two WASAPI rows are the named endpoint; the insert row names Voicemeeter's A1 device
        // and the ASIO row is not this endpoint at all, so neither may borrow its name.
        if r.device.is_none() && r.host.starts_with("WASAPI") {
            r.device = device.map(str::to_owned);
        }
    }
    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn periods(exclusive_min: u32, shared_default: Option<u32>) -> DevicePeriods {
        DevicePeriods {
            exclusive_min,
            shared_min: shared_default,
            shared_default,
            shared_rate: shared_default.map(|_| 48_000),
        }
    }

    #[test]
    fn exclusive_runs_at_the_device_minimum_when_the_request_is_smaller() {
        // The owner's rig: a 144-frame minimum at 48 kHz is 3 ms.
        let rs = declared(48_000, 128, Some(144), Some(periods(144, Some(336))), None);
        let excl = &rs[0];
        assert_eq!(excl.terms.input_period_frames, 144);
        assert_eq!(excl.terms.cushion_frames, 144);
        assert_eq!(excl.terms.output_period_frames, 144);
        assert!(
            (excl.terms.declared_ms - 9.0).abs() < 0.01,
            "{:?}",
            excl.terms
        );
        assert_eq!(excl.source, Source::Device);
    }

    #[test]
    fn shared_runs_at_the_mixers_period_and_says_so_when_it_is_unknown() {
        let known = declared(48_000, 128, Some(144), Some(periods(144, Some(480))), None);
        let shared = known.iter().find(|r| r.host.contains("shared")).unwrap();
        assert_eq!(shared.terms.input_period_frames, 480);
        assert_eq!(shared.source, Source::Device);
        let unknown = declared(48_000, 128, None, None, None);
        let shared = unknown.iter().find(|r| r.host.contains("shared")).unwrap();
        assert_eq!(shared.terms.input_period_frames, 128);
        assert_eq!(shared.source, Source::Assumed);
        assert!(
            unknown[0].note.contains("could not be read"),
            "{}",
            unknown[0].note
        );
    }

    #[test]
    fn the_insert_route_pays_voicemeeters_two_buffers_and_keeps_its_reservation() {
        let vm = VoicemeeterBuffers {
            frames: 256,
            a1_device: Some("Audio Interface Out (2- HD-II)".into()),
        };
        let rs = declared(
            48_000,
            128,
            Some(144),
            Some(periods(144, Some(336))),
            Some(&vm),
        );
        let insert = rs.iter().find(|r| r.host.contains("Insert")).unwrap();
        assert_eq!(insert.terms.input_period_frames, 256);
        assert_eq!(
            insert.terms.cushion_frames, 0,
            "one callback, nothing queued between streams"
        );
        assert!(
            (insert.terms.declared_ms - 10.667).abs() < 0.01,
            "{:?}",
            insert.terms
        );
        assert_eq!(insert.source, Source::Voicemeeter);
        assert!(insert.note.contains("not documented"), "{}", insert.note);
        // Without a running Voicemeeter the route is absent rather than guessed.
        let rs = declared(48_000, 128, Some(144), Some(periods(144, Some(336))), None);
        assert!(rs.iter().all(|r| !r.host.contains("Insert")));
    }

    #[test]
    fn the_asio_row_is_named_an_assumption_and_never_a_measurement() {
        let rs = declared(48_000, 64, None, None, None);
        let asio = rs.iter().find(|r| r.host == "ASIO").unwrap();
        assert_eq!(asio.source, Source::Assumed);
        assert!((asio.terms.declared_ms - 4.0).abs() < 0.01);
        assert!(asio.note.contains("not readable"), "{}", asio.note);
        assert!(
            rs.iter().all(|r| r.measured_ms.is_none()),
            "measured figures need a loopback"
        );
    }

    #[test]
    fn a_zero_rate_does_not_divide() {
        let rs = declared(0, 128, None, None, None);
        assert!(rs.iter().all(|r| r.terms.declared_ms == 0.0));
    }

    #[test]
    fn the_json_rounds_the_milliseconds_and_never_claims_a_measurement() {
        let vm = VoicemeeterBuffers {
            frames: 256,
            a1_device: Some("Audio Interface Out (2- HD-II)".into()),
        };
        let rs = declared(
            48_000,
            128,
            Some(144),
            Some(periods(144, Some(480))),
            Some(&vm),
        );
        // 10.67 ms must not serialise as 10.670000076293945.
        let insert = rs
            .iter()
            .find(|r| r.host.contains("Insert"))
            .unwrap()
            .to_json();
        assert_eq!(insert["terms"]["declared_ms"], serde_json::json!(10.67));
        assert_eq!(insert["source"], serde_json::json!("voicemeeter"));
        assert_eq!(insert["terms"]["cushion_frames"], serde_json::json!(0));
        for r in &rs {
            let j = r.to_json();
            assert!(j["measured_ms"].is_null(), "{j}");
            assert!(j["note"].as_str().is_some_and(|n| !n.is_empty()), "{j}");
        }
    }
}
