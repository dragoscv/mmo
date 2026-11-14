//! Headless MixAI Live engine.
//!
//!   mixai-live-engine devices [--host ASIO]
//!   mixai-live-engine periods --device <id|name> [--rate 48000]     (Windows)
//!   mixai-live-engine run --input <id|name> --output <id|name> --preset "Natural Vocal" [--buffer 128]
//!       [--host "WASAPI Exclusive" | "WASAPI Low Latency" | ASIO]
//!   mixai-live-engine latency --input <..> --output <..>     (needs a loopback)
//!   mixai-live-engine checkup --input <..> --output <..>     (read-only system checkup)
//!   mixai-live-engine voicemeeter [--save f.xml] [--buffer wdm=160] [--load f.xml]
//!   mixai-live-engine render --in voice.wav --out processed.wav --preset "Pop Polish"
//!   mixai-live-engine serve --input <..> --output <..> [--lan] [--port 17920] [--data-dir D] [--no-midi]
//!   mixai-live-engine midi-ports

use clap::{Parser, Subcommand};
use live_engine::checkup::{self, EndpointLevel};
use live_engine::{Buses, Core, IoConfig, ProbeState, Session, Store, io, voicemeeter};
use live_remote::{EngineHost, HostConfig};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

mod midi_in;
mod routes;

#[derive(Parser)]
#[command(
    name = "mixai-live-engine",
    version,
    about = "MixAI Live realtime vocal engine"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(clap::Args, Clone)]
struct DevArgs {
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    input: Option<String>,
    #[arg(long)]
    output: Option<String>,
    #[arg(long, default_value_t = 48_000)]
    rate: u32,
    #[arg(long, default_value_t = 128)]
    buffer: u32,
    /// Input channels, comma separated, 0-based (e.g. "0" or "0,1").
    #[arg(long, default_value = "0")]
    in_ch: String,
    /// Main output pair, e.g. "0,1".
    #[arg(long, default_value = "0,1")]
    main: String,
    /// Monitor output pair, e.g. "2,3".
    #[arg(long)]
    monitor: Option<String>,
}

#[derive(Subcommand)]
enum Cmd {
    /// List hosts and devices as JSON.
    Devices {
        #[arg(long)]
        host: Option<String>,
    },
    /// Smallest exclusive / shared periods a Windows device offers, as JSON.
    Periods {
        #[arg(long)]
        device: String,
        #[arg(long, default_value_t = 48_000)]
        rate: u32,
    },
    /// Compare the routes this machine offers on what each DECLARES (no loopback needed).
    Routes {
        #[command(flatten)]
        dev: DevArgs,
    },
    /// Process live until Ctrl+C (or --seconds), printing meters every second.
    Run {
        #[command(flatten)]
        dev: DevArgs,
        #[arg(long, default_value = "Natural Vocal")]
        preset: String,
        #[arg(long)]
        seconds: Option<u64>,
    },
    /// Measure the real round trip with a click train (route output back to input first).
    Latency {
        #[command(flatten)]
        dev: DevArgs,
    },
    /// Read-only: things outside the engine that add delay or break low buffers, as JSON.
    Checkup {
        #[command(flatten)]
        dev: DevArgs,
    },
    /// What the local Voicemeeter runs, as JSON. The options change Voicemeeter: `--save`
    /// writes its configuration to a file, `--buffer` needs `--save` in the same call.
    Voicemeeter {
        /// Save Voicemeeter's whole configuration to this file first.
        #[arg(long)]
        save: Option<PathBuf>,
        /// Set a buffer size and restart Voicemeeter's audio, e.g. `wdm=160` (mme, wdm, ks, asio).
        #[arg(long, requires = "save", conflicts_with = "load")]
        buffer: Option<String>,
        /// Load a configuration saved with `--save` (Voicemeeter restarts its audio).
        #[arg(long, conflicts_with = "save")]
        load: Option<PathBuf>,
    },
    /// Offline: process a WAV file through a preset (CI / A-B listening / benchmarks).
    Render {
        #[arg(long = "in")]
        input: String,
        #[arg(long = "out")]
        output: String,
        #[arg(long, default_value = "Natural Vocal")]
        preset: String,
        #[arg(long, default_value_t = 128)]
        block: usize,
    },
    /// List factory presets as JSON.
    Presets,
    /// List MIDI input ports as JSON.
    MidiPorts,
    /// Run the engine with the control server (desktop UI on loopback; phones with --lan).
    Serve {
        #[command(flatten)]
        dev: DevArgs,
        #[arg(long, default_value = "Natural Vocal")]
        preset: String,
        /// Listen on every interface and announce over mDNS (phones/watches).
        #[arg(long)]
        lan: bool,
        /// Also accept OSC over UDP on `port + 1`. Every address must start with an OSC key
        /// (printed in the ready line): `/<key>/live/...`.
        #[arg(long)]
        osc: bool,
        #[arg(long, default_value_t = live_remote::DEFAULT_PORT)]
        port: u16,
        #[arg(long, default_value = "MixAI Live")]
        name: String,
        /// Exit after N seconds (tests).
        #[arg(long)]
        seconds: Option<u64>,
        /// Where user presets, the setlist and MIDI bindings are stored (default: per-user app data).
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// Keep everything in memory (tests, kiosk).
        #[arg(long)]
        no_store: bool,
        /// Do not open MIDI inputs.
        #[arg(long)]
        no_midi: bool,
    },
}

fn pair(s: &str) -> Result<[u16; 2], String> {
    let v: Vec<u16> = s
        .split(',')
        .map(|x| x.trim().parse::<u16>().map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    match v.as_slice() {
        [a, b] => Ok([*a, *b]),
        [a] => Ok([*a, *a]),
        _ => Err(format!("expected a channel pair, got `{s}`")),
    }
}

/// `wdm=160` → ("wdm", 160).
fn buffer_arg(s: &str) -> Result<(String, u32), String> {
    let (driver, frames) = s
        .split_once('=')
        .ok_or_else(|| format!("expected <driver>=<frames>, got `{s}`"))?;
    let driver = driver.trim().to_ascii_lowercase();
    if !["mme", "wdm", "ks", "asio"].contains(&driver.as_str()) {
        return Err(format!(
            "unknown driver type `{driver}` (mme, wdm, ks, asio)"
        ));
    }
    let frames: u32 = frames
        .trim()
        .parse()
        .map_err(|_| format!("`{frames}` is not a buffer size"))?;
    if !(64..=2048).contains(&frames) {
        return Err(format!("buffer {frames} is outside 64..2048 frames"));
    }
    Ok((driver, frames))
}

/// The click must come back above this level to count (0.02 of full scale, see `latency.rs`).
const CLICK_FLOOR_DB: f32 = -34.0;

/// Which part of the loop failed, from what the probe run saw: the loudest sample the engine
/// wrote to the main bus, the loudest input sample, and the Windows level of the output device.
fn probe_diagnosis(out_peak_db: f32, in_peak_db: f32, output: Option<EndpointLevel>) -> String {
    if out_peak_db < -6.0 {
        return format!(
            "the engine did not write the click to its output (loudest output sample {out_peak_db:.1} dBFS)"
        );
    }
    if let Some(l) = output {
        if l.muted {
            return "the click left the engine, but Windows has the output device muted".into();
        }
        if l.volume_db < -20.0 {
            return format!(
                "the click left the engine, but the Windows volume of the output device is at {:.0} dB",
                l.volume_db
            );
        }
    }
    if in_peak_db <= -120.0 {
        return "the click left the engine; the input is digitally silent (wrong input device or channel, or the device is muted)".into();
    }
    format!(
        "the click left the engine at {out_peak_db:.1} dBFS; the input is alive but nothing above {CLICK_FLOOR_DB:.0} dBFS came back: check the cable or speaker, the output pair (--main), the input channel (--in-ch) and the output level"
    )
}

fn io_config(d: &DevArgs) -> Result<IoConfig, String> {
    Ok(IoConfig {
        host: d.host.clone(),
        input: d.input.clone(),
        output: d.output.clone(),
        sample_rate: d.rate,
        buffer_frames: d.buffer,
        input_channels: d
            .in_ch
            .split(',')
            .map(|x| x.trim().parse::<u16>().map_err(|e| e.to_string()))
            .collect::<Result<_, _>>()?,
        main_channels: pair(&d.main)?,
        monitor_channels: d.monitor.as_deref().map(pair).transpose()?,
    })
}

fn main() {
    let cli = Cli::parse();
    if let Err(e) = run(cli) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.cmd {
        Cmd::Devices { host } => {
            let devices = io::list_devices(host.as_deref()).map_err(|e| e.to_string())?;
            let out = serde_json::json!({ "hosts": io::hosts(), "devices": devices });
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        }
        Cmd::Periods { device, rate } => {
            let p = io::device_periods(&device, rate).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default());
        }
        Cmd::Routes { dev } => {
            let cfg = io_config(&dev)?;
            let routes = routes::collect(&cfg);
            let out = serde_json::json!({
                "requested": { "rate": cfg.sample_rate, "buffer_frames": cfg.buffer_frames },
                "routes": routes.iter().map(routes::Route::to_json).collect::<Vec<_>>(),
                "measured": "none: a round trip needs a loopback, run `latency` for that",
            });
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
        }
        Cmd::Presets => {
            println!(
                "{}",
                serde_json::to_string_pretty(&live_engine::factory()).unwrap_or_default()
            );
        }
        Cmd::MidiPorts => {
            println!(
                "{}",
                serde_json::to_string_pretty(&midi_in::port_names()).unwrap_or_default()
            );
        }
        Cmd::Run {
            dev,
            preset,
            seconds,
        } => {
            let cfg = io_config(&dev)?;
            let mut running = io::start(&cfg).map_err(|e| e.to_string())?;
            let mut session = Session::new(
                cfg.sample_rate as f32,
                running.info.buffer_frames as usize * 8,
            );
            let cmd = session.load_preset(&preset).map_err(|e| e.to_string())?;
            running.send(cmd).map_err(|_| "command ring full")?;
            eprintln!(
                "{}",
                serde_json::to_string(&running.info).unwrap_or_default()
            );
            let start = Instant::now();
            let mut last = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(20));
                let m = running.poll();
                if !running.alive() {
                    return Err(format!(
                        "audio stream stopped: {}",
                        running
                            .last_error()
                            .unwrap_or_else(|| "unknown driver error".into())
                    ));
                }
                if last.elapsed() >= Duration::from_secs(1)
                    && let Some(m) = m
                {
                    last = Instant::now();
                    println!(
                        "{}",
                        serde_json::json!({
                            "in_peak_db": live_dsp::lin_to_db(m.in_peak),
                            "out_peak_db": live_dsp::lin_to_db(m.out_peak[0].max(m.out_peak[1])),
                            "dsp_load": m.dsp_load,
                            "dsp_load_max": m.dsp_load_max,
                            "xruns": m.xruns,
                            "driver_xruns": running.driver_xruns(),
                            "note": m.tune.map(|t| t.target),
                        })
                    );
                }
                if seconds.is_some_and(|s| start.elapsed() >= Duration::from_secs(s)) {
                    break;
                }
            }
        }
        Cmd::Latency { dev } => {
            let cfg = io_config(&dev)?;
            // Read before the stream opens: an exclusive stream may hide the endpoint.
            let in_level = checkup::endpoint_level(cfg.input.as_deref(), true);
            let out_level = checkup::endpoint_level(cfg.output.as_deref(), false);
            let mut running = io::start(&cfg).map_err(|e| e.to_string())?;
            // Only the click may reach the output: through a loopback the dry path would feed back.
            running
                .send(live_engine::Command::Mute(true))
                .map_err(|_| "command ring full")?;
            std::thread::sleep(Duration::from_millis(500));
            running
                .send(live_engine::Command::StartLatencyProbe)
                .map_err(|_| "command ring full")?;
            let t0 = Instant::now();
            let (mut in_peak, mut out_peak) = (0.0f32, 0.0f32);
            loop {
                std::thread::sleep(Duration::from_millis(50));
                if !running.alive() {
                    return Err(format!(
                        "audio stream stopped: {}",
                        running
                            .last_error()
                            .unwrap_or_else(|| "unknown driver error".into())
                    ));
                }
                // Every meter frame counts: the click lands in exactly one of them.
                while let Ok(m) = running.meters.pop() {
                    // Frames from before the probe started (start-up thumps) do not count.
                    if m.latency_probe != ProbeState::Idle {
                        in_peak = in_peak.max(m.in_peak);
                        out_peak = out_peak.max(m.out_peak[0].max(m.out_peak[1]));
                    }
                    match m.latency_probe {
                        ProbeState::Done(ms) => {
                            let out = serde_json::json!({
                                "round_trip_ms": ms,
                                "nominal_ms": running.info.nominal_latency_ms,
                                "chain_latency_samples": m.chain_latency_samples,
                                // Equal to the main chain while "tuned only for the audience" is off.
                                "monitor_chain_latency_samples": m.monitor_chain_latency_samples,
                                "in_peak_db": live_dsp::lin_to_db(in_peak),
                                "out_peak_db": live_dsp::lin_to_db(out_peak),
                                "xruns": m.xruns,
                                "driver_xruns": running.driver_xruns(),
                                "input_level": in_level,
                                "output_level": out_level,
                                "info": running.info,
                            });
                            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
                            return Ok(());
                        }
                        ProbeState::Failed => {
                            let (i, o) =
                                (live_dsp::lin_to_db(in_peak), live_dsp::lin_to_db(out_peak));
                            return Err(format!(
                                "no click came back (loudest input during the probe: {i:.1} dBFS): {}. Route the output to the input (cable, Voicemeeter strip, or speaker → mic) and retry",
                                probe_diagnosis(o, i, out_level)
                            ));
                        }
                        _ => {}
                    }
                }
                if t0.elapsed() > Duration::from_secs(10) {
                    return Err(format!(
                        "latency probe timed out (loudest input: {:.1} dBFS, loudest output: {:.1} dBFS)",
                        live_dsp::lin_to_db(in_peak),
                        live_dsp::lin_to_db(out_peak)
                    ));
                }
            }
        }
        Cmd::Checkup { dev } => {
            let report = checkup::run(&io_config(&dev)?);
            println!(
                "{}",
                serde_json::to_string_pretty(&report).unwrap_or_default()
            );
        }
        Cmd::Voicemeeter { save, buffer, load } => {
            // Parse before anything is changed.
            let buffer = buffer.as_deref().map(buffer_arg).transpose()?;
            if let Some(path) = &save {
                voicemeeter::save_snapshot(path)?;
            }
            if let Some((driver, frames)) = &buffer {
                voicemeeter::set_buffer(driver, *frames)?;
            }
            if let Some(path) = &load {
                voicemeeter::load_snapshot(path)?;
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&voicemeeter::info()).unwrap_or_default()
            );
        }
        Cmd::Render {
            input,
            output,
            preset,
            block,
        } => render(&input, &output, &preset, block)?,
        Cmd::Serve {
            dev,
            preset,
            lan,
            osc,
            port,
            name,
            seconds,
            data_dir,
            no_store,
            no_midi,
        } => {
            let store = (!no_store)
                .then(|| Store::new(data_dir.unwrap_or_else(live_engine::store::default_dir)));
            serve(
                &dev, &preset, lan, osc, port, &name, seconds, store, !no_midi,
            )?
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn serve(
    dev: &DevArgs,
    preset: &str,
    lan: bool,
    osc: bool,
    port: u16,
    name: &str,
    seconds: Option<u64>,
    store: Option<Store>,
    midi: bool,
) -> Result<(), String> {
    let (midi_tx, midi_rx) = mpsc::sync_channel::<Vec<u8>>(1024);
    let inputs = midi.then(|| midi_in::open_all(midi_tx));
    let host = EngineHost::start(HostConfig {
        io: io_config(dev)?,
        preset: preset.into(),
        bind: if lan {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        },
        port,
        name: name.into(),
        announce: lan,
        osc,
        store,
        start_muted: false,
        midi: inputs.as_ref().map(|i| (i.names(), midi_rx)),
    })
    .map_err(|e| e.to_string())?;
    let r = host.ready();
    for w in &r.warnings {
        eprintln!("{w}");
    }
    // One JSON line for the desktop shell / scripts: where to connect and with which tokens.
    println!(
        "{}",
        serde_json::json!({
            "event": "ready",
            "port": r.port,
            "osc_port": r.osc_port,
            "osc_performer_key": r.osc_performer_key,
            "osc_controller_key": r.osc_controller_key,
            "controller_url": r.controller_url,
            "performer_url": r.performer_url,
            "viewer_url": r.viewer_url,
            "info": r.info,
        })
    );
    let start = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        if !host.alive() {
            return Err(host.error().unwrap_or_else(|| "engine stopped".into()));
        }
        if seconds.is_some_and(|s| start.elapsed() >= Duration::from_secs(s)) {
            return Ok(());
        }
    }
}

/// Minimal WAV I/O (16-bit PCM / 32-bit float, mono or stereo) to keep the binary dependency-light.
fn render(input: &str, output: &str, preset: &str, block: usize) -> Result<(), String> {
    let (rate, ch, samples) = wav::read(input)?;
    let block = block.clamp(16, 4096);
    let mut session = Session::new(rate as f32, block);
    let mut core = Core::new(rate as f32, block);
    let cmd = session.load_preset(preset).map_err(|e| e.to_string())?;
    core.apply(cmd, &mut |_g| {});
    let frames = samples.len() / ch as usize;
    let mut out = vec![0.0f32; frames * 2];
    let (mut il, mut ir) = (vec![0.0; block], vec![0.0; block]);
    let (mut ml, mut mr, mut ol, mut or) = (
        vec![0.0; block],
        vec![0.0; block],
        vec![0.0; block],
        vec![0.0; block],
    );
    let t0 = Instant::now();
    let mut f = 0;
    while f < frames {
        let n = block.min(frames - f);
        for k in 0..n {
            let base = (f + k) * ch as usize;
            il[k] = samples[base];
            ir[k] = samples[base + (ch as usize - 1)];
        }
        core.render(
            &il[..n],
            &ir[..n],
            Buses {
                main_l: &mut ml[..n],
                main_r: &mut mr[..n],
                mon_l: &mut ol[..n],
                mon_r: &mut or[..n],
            },
        );
        for k in 0..n {
            out[(f + k) * 2] = ml[k];
            out[(f + k) * 2 + 1] = mr[k];
        }
        f += n;
    }
    let secs = t0.elapsed().as_secs_f64();
    wav::write_f32(output, rate, 2, &out)?;
    let audio = frames as f64 / rate as f64;
    println!(
        "{}",
        serde_json::json!({ "audio_s": audio, "cpu_s": secs, "realtime_x": audio / secs.max(1e-9), "preset": preset })
    );
    Ok(())
}

mod wav {
    use std::fs;

    pub fn read(path: &str) -> Result<(u32, u16, Vec<f32>), String> {
        let b = fs::read(path).map_err(|e| format!("{path}: {e}"))?;
        if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
            return Err(format!("{path}: not a WAV file"));
        }
        let (mut fmt, mut data) = (None, None);
        let mut p = 12;
        while p + 8 <= b.len() {
            let id = &b[p..p + 4];
            let len = u32::from_le_bytes([b[p + 4], b[p + 5], b[p + 6], b[p + 7]]) as usize;
            let body = p + 8;
            let end = (body + len).min(b.len());
            if id == b"fmt " {
                fmt = Some(&b[body..end]);
            } else if id == b"data" {
                data = Some(&b[body..end]);
            }
            p = body + len + (len & 1);
        }
        let fmt = fmt.ok_or("missing fmt chunk")?;
        let data = data.ok_or("missing data chunk")?;
        let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
        let ch = u16::from_le_bytes([fmt[2], fmt[3]]);
        let rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
        let bits = u16::from_le_bytes([fmt[14], fmt[15]]);
        if ch == 0 || ch > 2 {
            return Err(format!("{ch} channels not supported (mono or stereo)"));
        }
        let samples = match (tag, bits) {
            (1, 16) | (0xFFFE, 16) => data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
                .collect(),
            (3, 32) | (0xFFFE, 32) => data
                .as_chunks::<4>()
                .0
                .iter()
                .map(|c| f32::from_le_bytes(*c))
                .collect(),
            _ => return Err(format!("unsupported WAV format tag {tag} / {bits} bit")),
        };
        Ok((rate, ch, samples))
    }

    pub fn write_f32(path: &str, rate: u32, ch: u16, s: &[f32]) -> Result<(), String> {
        let data_len = (s.len() * 4) as u32;
        let mut b = Vec::with_capacity(44 + data_len as usize);
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&3u16.to_le_bytes());
        b.extend_from_slice(&ch.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * ch as u32 * 4).to_le_bytes());
        b.extend_from_slice(&(ch * 4).to_le_bytes());
        b.extend_from_slice(&32u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        for x in s {
            b.extend_from_slice(&x.to_le_bytes());
        }
        fs::write(path, b).map_err(|e| format!("{path}: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(volume_db: f32, muted: bool) -> Option<EndpointLevel> {
        Some(EndpointLevel {
            volume: 10f32.powf(volume_db / 20.0),
            volume_db,
            muted,
        })
    }

    /// Each cause gets its own sentence, in the order the signal travels: engine output,
    /// Windows mute, Windows volume, dead input, and only then "check the loop".
    #[test]
    fn probe_diagnosis_names_the_first_broken_stage() {
        let d = probe_diagnosis(-60.0, -45.0, level(0.0, false));
        assert!(d.contains("did not write the click"), "{d}");
        // A muted output wins over everything after it, even with a dead input.
        let d = probe_diagnosis(-1.0, -180.0, level(0.0, true));
        assert!(
            d.contains("muted") && !d.contains("digitally silent"),
            "{d}"
        );
        let d = probe_diagnosis(-1.0, -45.0, level(-40.0, false));
        assert!(d.contains("-40 dB"), "{d}");
        let d = probe_diagnosis(-1.0, -180.0, level(0.0, false));
        assert!(d.contains("digitally silent"), "{d}");
        // The run of 2026-11-10: click out at -1 dBFS, input alive at -45, nothing came back.
        let d = probe_diagnosis(-1.0, -45.0, level(0.0, false));
        assert!(d.contains("input is alive") && d.contains("--in-ch"), "{d}");
        // No level readable (other systems): the Windows branches are skipped, not guessed.
        let d = probe_diagnosis(-1.0, -45.0, None);
        assert!(d.contains("input is alive"), "{d}");
    }

    #[test]
    fn buffer_arg_accepts_only_known_drivers_and_sane_sizes() {
        assert_eq!(buffer_arg("wdm=160"), Ok(("wdm".into(), 160)));
        assert_eq!(buffer_arg(" KS = 144 "), Ok(("ks".into(), 144)));
        for bad in [
            "160", "wdm", "usb=160", "wdm=abc", "wdm=32", "wdm=4096", "wdm=-1",
        ] {
            assert!(buffer_arg(bad).is_err(), "`{bad}` must be refused");
        }
    }
}
