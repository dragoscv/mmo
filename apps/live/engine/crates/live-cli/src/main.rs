//! Headless MixAI Live engine.
//!
//!   mixai-live-engine devices [--host ASIO]
//!   mixai-live-engine run --input <id|name> --output <id|name> --preset "Natural Vocal" [--buffer 128]
//!   mixai-live-engine latency --input <..> --output <..>     (needs a loopback)
//!   mixai-live-engine render --in voice.wav --out processed.wav --preset "Pop Polish"
//!   mixai-live-engine serve --input <..> --output <..> [--lan] [--port 17920]   (desktop UI + phones)

use clap::{Parser, Subcommand};
use live_engine::{Buses, Core, IoConfig, ProbeState, Role, Session, io};
use live_remote::{RemoteConfig, RemoteServer};
use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

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
    /// Run the engine with the control server (desktop UI on loopback; phones with --lan).
    Serve {
        #[command(flatten)]
        dev: DevArgs,
        #[arg(long, default_value = "Natural Vocal")]
        preset: String,
        /// Listen on every interface and announce over mDNS (phones/watches).
        #[arg(long)]
        lan: bool,
        #[arg(long, default_value_t = live_remote::DEFAULT_PORT)]
        port: u16,
        #[arg(long, default_value = "MixAI Live")]
        name: String,
        /// Exit after N seconds (tests).
        #[arg(long)]
        seconds: Option<u64>,
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
        Cmd::Presets => {
            println!(
                "{}",
                serde_json::to_string_pretty(&live_engine::factory()).unwrap_or_default()
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
            let mut running = io::start(&cfg).map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_millis(500));
            running
                .send(live_engine::Command::StartLatencyProbe)
                .map_err(|_| "command ring full")?;
            let t0 = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(50));
                if let Some(m) = running.poll() {
                    match m.latency_probe {
                        ProbeState::Done(ms) => {
                            let out = serde_json::json!({
                                "round_trip_ms": ms,
                                "nominal_ms": running.info.nominal_latency_ms,
                                "chain_latency_samples": m.chain_latency_samples,
                                "info": running.info,
                            });
                            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
                            return Ok(());
                        }
                        ProbeState::Failed => {
                            return Err("no click came back: route the output to the input (cable, Voicemeeter strip, or speaker → mic) and retry".into());
                        }
                        _ => {}
                    }
                }
                if t0.elapsed() > Duration::from_secs(10) {
                    return Err("latency probe timed out".into());
                }
            }
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
            port,
            name,
            seconds,
        } => serve(&dev, &preset, lan, port, &name, seconds)?,
    }
    Ok(())
}

fn serve(
    dev: &DevArgs,
    preset: &str,
    lan: bool,
    port: u16,
    name: &str,
    seconds: Option<u64>,
) -> Result<(), String> {
    let cfg = io_config(dev)?;
    let mut running = io::start(&cfg).map_err(|e| e.to_string())?;
    let mut session = Session::new(
        cfg.sample_rate as f32,
        running.info.buffer_frames as usize * 8,
    );
    let first = session.load_preset(preset).map_err(|e| e.to_string())?;
    running.send(first).map_err(|_| "command ring full")?;
    let bind = if lan {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let server = RemoteServer::start(RemoteConfig {
        bind,
        port,
        osc: true,
        engine_name: name.into(),
    })
    .map_err(|e| format!("control server on port {port}: {e}"))?;
    server.set_hello(serde_json::json!({
        "sample_rate": running.info.sample_rate,
        "buffer_frames": running.info.buffer_frames,
        "devices": running.info,
    }));
    let host = if lan {
        live_remote::lan_ip()
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    let _mdns = if lan {
        match live_remote::discovery::Announcer::start(name, host, server.port(), server.osc_port())
        {
            Ok(a) => Some(a),
            Err(e) => {
                eprintln!("mDNS announcement failed ({e}); pairing by QR still works");
                None
            }
        }
    } else {
        None
    };
    // One JSON line for the desktop shell / scripts: where to connect and with which tokens.
    println!(
        "{}",
        serde_json::json!({
            "event": "ready",
            "port": server.port(),
            "osc_port": server.osc_port(),
            "controller_url": server.pairing_url(Role::Controller, host),
            "performer_url": server.pairing_url(Role::Performer, host),
            "viewer_url": server.pairing_url(Role::Viewer, host),
            "info": running.info,
        })
    );
    let start = Instant::now();
    let mut last_rev = u64::MAX;
    let mut pending: Vec<live_engine::Command> = Vec::new();
    loop {
        std::thread::sleep(Duration::from_millis(5));
        // Commands that did not fit last tick go first (ring full = engine stalled briefly).
        let mut retry = Vec::new();
        for c in pending.drain(..) {
            if let Err(c) = running.send(c) {
                retry.push(c);
            }
        }
        pending = retry;
        let mut replies = Vec::new();
        for inc in server.drain() {
            match session.apply_control(inc.control, Instant::now()) {
                Ok(cmds) => {
                    for c in cmds {
                        if let Err(c) = running.send(c) {
                            pending.push(c);
                        }
                    }
                    replies.push((inc.conn, inc.id, Ok(())));
                }
                Err(e) => replies.push((
                    inc.conn,
                    inc.id,
                    Err((live_remote::server_error_code(&e), e.to_string())),
                )),
            }
        }
        // State first, then acks: a client seeing `ack` already has the new state.
        if session.revision != last_rev {
            last_rev = session.revision;
            server.publish_state(&session.state());
        }
        for (conn, id, r) in replies {
            server.reply(conn, id, r);
        }
        if let Some(m) = running.poll() {
            server.publish_meters(live_remote::meters_json(&m));
        }
        if !running.alive() {
            return Err(format!(
                "audio stream stopped: {}",
                running
                    .last_error()
                    .unwrap_or_else(|| "unknown driver error".into())
            ));
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
