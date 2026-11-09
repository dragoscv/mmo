# MixAI Live — `mixai-live-engine` CLI

The headless engine binary (crate `live-cli`, `apps/live/engine/crates/live-cli/src/main.rs`). It runs the
same engine the desktop app will use, so it works on a headless stage PC, in scripts and in CI.

```powershell
# build (from the repo root, queued through the shared build lock)
pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'cargo build --release --manifest-path apps/live/engine/Cargo.toml -p live-cli'
# binary: apps/live/engine/target/release/mixai-live-engine(.exe)
```

Build features (forwarded to cpal): `asio` (Windows ASIO, needs the Steinberg SDK — licence note in
[latency.md](latency.md#windows)), `pipewire`, `jack` (Linux).

| Subcommand | Does |
|---|---|
| [`devices`](#devices) | List audio hosts and devices as JSON |
| [`presets`](#presets) | List factory presets as JSON |
| [`run`](#run) | Process live until Ctrl+C (or `--seconds`), printing meters every second |
| [`latency`](#latency) | Measure the real round trip with a click train (needs a loopback) |
| [`render`](#render) | Process a WAV file offline through a preset |
| [`serve`](#serve) | Run the engine with the control server (desktop UI, web remote, phones) |

Errors print `error: <message>` on stderr and exit with code 1.

## Device options

Shared by `run`, `latency` and `serve`:

| Flag | Default | Meaning |
|---|---|---|
| `--host <name>` | system default | cpal host: `WASAPI`, `ASIO` (feature), `CoreAudio`, `ALSA`, `JACK` (feature)… case-insensitive |
| `--input <id\|name>` | default input | device id or exact name from `devices` |
| `--output <id\|name>` | default output | device id or exact name from `devices` |
| `--rate <Hz>` | `48000` | sample rate for both streams |
| `--buffer <frames>` | `128` | requested period, clamped to 16–4096 ([buffer table](latency.md#buffer-sizes-at-48-khz)) |
| `--in-ch <list>` | `0` | input channels, 0-based, comma separated: `0` = mono mic (sent to L and R), `0,1` = stereo |
| `--main <pair>` | `0,1` | output channel pair of the main (FOH / stream) bus; a single number uses it for both sides |
| `--monitor <pair>` | none | output channel pair of the in-ear monitor bus, e.g. `2,3` |

The output device must have enough channels for every routed pair (`output has N channels, routing needs M`).
The streams use `f32` samples; a device without an `f32` format is rejected.

## devices

```text
mixai-live-engine devices [--host <name>]
```

Prints `{"hosts": [...], "devices": [DeviceInfo...]}` sorted by name. `DeviceInfo` fields: `id`, `name`,
`host`, `input_channels`, `output_channels`, `default_rate`, `is_default_input`, `is_default_output`,
`voicemeeter` (name looks like a Voicemeeter / VB-Audio endpoint), `virtual_cable` (VB-Cable, VirtualDrivers,
BlackHole, "loopback"…).

## presets

```text
mixai-live-engine presets
```

Prints the factory presets as a JSON array in the [preset format](presets.md).

## run

```text
mixai-live-engine run [device options] [--preset <name>] [--seconds <n>]
```

Loads `--preset` (default `Natural Vocal`), prints the running stream info (`RunningInfo` JSON: host, devices,
rate, buffer, channel counts, `nominal_latency_ms`, notes) on **stderr**, then one JSON line per second on
stdout:

```json
{"in_peak_db":-23.4,"out_peak_db":-18.9,"dsp_load":0.013,"dsp_load_max":0.04,"xruns":0,"driver_xruns":0,"note":57}
```

`note` is the pitch-correction target MIDI note (`-1` idle) or `null` without a pitch effect. Stops on Ctrl+C,
after `--seconds`, or with `error: audio stream stopped: <driver message>` when the device fails.

```powershell
mixai-live-engine run --input "Audio Interface IN (2- HD-II)" --output "Audio Interface Out (2- HD-II)" --buffer 64 --preset "Pop Polish"
```

## latency

```text
mixai-live-engine latency [device options]
```

Runs the click-train probe described in [latency.md](latency.md#measure-the-real-round-trip) and prints:

```json
{ "round_trip_ms": 7.9, "nominal_ms": 4.0, "chain_latency_samples": 0, "info": { "host": "ASIO", "...": "..." } }
```

Fails with `no click came back: route the output to the input ...` without a loopback, or
`latency probe timed out` after 10 s.

## render

```text
mixai-live-engine render --in <file.wav> --out <file.wav> [--preset <name>] [--block <frames>]
```

Offline processing for A/B listening, regression checks and benchmarks. Input: 16-bit PCM or 32-bit float WAV,
mono or stereo (mono is processed as L = R). Output: 32-bit float stereo WAV of the **main** bus at the input
rate. `--block` (default 128, clamped 16–4096) is the processing block. Prints:

```json
{"audio_s":12.0,"cpu_s":0.21,"realtime_x":57.1,"preset":"Natural Vocal"}
```

## serve

```text
mixai-live-engine serve [device options] [--preset <name>] [--lan] [--port <n>] [--name <text>] [--seconds <n>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--preset` | `Natural Vocal` | preset loaded at start |
| `--lan` | off | bind `0.0.0.0` (instead of `127.0.0.1`) and announce `_mixai-live._tcp` over mDNS |
| `--port` | `17920` | HTTP/WebSocket port; OSC listens on `port + 1` (or a free port if taken) |
| `--name` | `MixAI Live` | engine name in `hello`, mDNS and the remote page |
| `--seconds` | none | exit after N seconds (tests) |

On start it prints **one `ready` JSON line** on stdout — the contract for the desktop shell and scripts:

```json
{
  "event": "ready",
  "port": 17920,
  "osc_port": 17921,
  "controller_url": "http://192.168.1.20:17920/?t=<controller token>",
  "performer_url": "http://192.168.1.20:17920/?t=<performer token>",
  "viewer_url": "http://192.168.1.20:17920/?t=<viewer token>",
  "info": { "host": "WASAPI", "input": "...", "output": "...", "sample_rate": 48000, "buffer_frames": 128, "...": "..." }
}
```

(printed on one line; shown wrapped here). Without `--lan` the URLs use `127.0.0.1`; with `--lan` they use the
machine's LAN address. Tokens are random per run; treat the URLs as secrets (anyone with the controller URL can
change the chain). Open a URL in a browser for the web remote page, or turn it into a QR code for phones. A
failed mDNS announcement is reported on stderr and pairing by URL/QR still works.

The control loop then runs every 5 ms (controls → session → engine commands, state and meters to clients);
see [architecture](architecture.md#control-flow) and the [remote protocol](remote-protocol.md).

```powershell
mixai-live-engine serve --input "Audio Interface IN (2- HD-II)" --output "Audio Interface Out (2- HD-II)" --monitor 2,3 --lan
```
