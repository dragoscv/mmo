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
| [`periods`](#periods) | Smallest exclusive / shared periods a Windows device offers, as JSON |
| [`presets`](#presets) | List factory presets as JSON |
| [`run`](#run) | Process live until Ctrl+C (or `--seconds`), printing meters every second |
| [`latency`](#latency) | Measure the real round trip with a click train (needs a loopback) |
| [`checkup`](#checkup) | Read-only: what outside the engine adds delay or breaks low buffers, as JSON |
| [`routes`](#routes) | Compare the routes on what each DECLARES (no loopback needed), as JSON |
| [`voicemeeter`](#voicemeeter) | What the local Voicemeeter runs; `--save` / `--buffer` / `--load` change it |
| [`render`](#render) | Process a WAV file offline through a preset |
| [`serve`](#serve) | Run the engine with the control server (desktop UI, web remote, phones) |
| `midi-ports` | List MIDI input port names as JSON (what `serve` will open; see [MIDI control](midi.md)) |

Errors print `error: <message>` on stderr and exit with code 1.

## Device options

Shared by `run`, `latency` and `serve`:

| Flag | Default | Meaning |
|---|---|---|
| `--host <name>` | system default | `WASAPI`, `WASAPI Exclusive`, `WASAPI Low Latency` ([Windows hosts](latency.md#windows)), `ASIO` (feature), `CoreAudio`, `ALSA`, `JACK` (feature)… case-insensitive; `Voicemeeter Insert` runs the engine inside Voicemeeter's own callback (see [voicemeeter](#voicemeeter)) |
| `--input <id\|name>` | default input | device id or exact name from `devices` |
| `--output <id\|name>` | default output | device id or exact name from `devices` |
| `--rate <Hz>` | `48000` | sample rate for both streams |
| `--buffer <frames>` | `128` | requested period, clamped to 16–4096 ([buffer table](latency.md#buffer-sizes-at-48-khz)) |
| `--in-ch <list>` | `0` | input channels, 0-based, comma separated: `0` = mono mic (sent to L and R), `0,1` = stereo |
| `--main <pair>` | `0,1` | output channel pair of the main (FOH / stream) bus; a single number uses it for both sides |
| `--monitor <pair>` | none | output channel pair of the in-ear monitor bus, e.g. `2,3` |

The output device must have enough channels for every routed pair (`output has N channels, routing needs M`).
The cpal hosts use `f32` streams and reject a device without an `f32` format. The two native WASAPI hosts
(`WASAPI Exclusive`, `WASAPI Low Latency`) convert to whatever the driver takes (f32, i32, i24 in 32, packed
i24, i16) and say which in `info.notes`, together with the period the driver really runs.

## devices

```text
mixai-live-engine devices [--host <name>]
```

Prints `{"hosts": [...], "devices": [DeviceInfo...]}` sorted by name. `DeviceInfo` fields: `id`, `name`,
`host`, `input_channels`, `output_channels`, `default_rate`, `is_default_input`, `is_default_output`,
`voicemeeter` (name looks like a Voicemeeter / VB-Audio endpoint), `virtual_cable` (VB-Cable, VirtualDrivers,
BlackHole, "loopback"…).

## periods

```text
mixai-live-engine periods --device <id|name> [--rate <Hz>]
```

Windows only. Prints the period limits of one endpoint (capture or playback, by name or id), or `null` when
the driver gives no answer (and on other systems).

```json
{ "device": "Audio Interface Out (2- HD-II)", "exclusive_min": 144, "shared_min": 336, "shared_default": 480, "shared_rate": 48000 }
```

`exclusive_min` is the smallest buffer `WASAPI Exclusive` can run, in frames at `--rate` (default 48000).
`shared_min` is the smallest `WASAPI Low Latency` can run and `shared_default` what plain `WASAPI` runs at;
both are frames at `shared_rate`, the rate of the Windows mixer on that device, and all three shared fields
are `null` when the driver has no low-latency shared mode. The example is the reference rig (HD-II on the
Microsoft class driver, 2026-11-10).

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
{ "round_trip_ms": 7.9, "nominal_ms": 4.0, "chain_latency_samples": 0, "monitor_chain_latency_samples": 0, "in_peak_db": -3.1, "info": { "host": "ASIO", "...": "..." } }
```

The engine output is muted during the probe, so only the clicks are played (through a loopback the dry signal
would feed back). `in_peak_db` is the loudest input sample seen during the probe. Fails with
`no click came back (loudest input during the probe: <x> dBFS): route the output to the input ...` without a
loopback, `latency probe timed out (loudest input: <x> dBFS)` after 10 s, or `audio stream stopped: <reason>`
when a device stops delivering. The level tells the cases apart: a click needs to arrive above about
−34 dBFS (0.02 of full scale) to count; `-180.0` means the input is digitally silent.

## checkup

```text
mixai-live-engine checkup [device options]
```

Windows only, read-only: what outside the engine adds delay or breaks small buffers, as JSON. With `--input` /
`--output` it looks at those devices, without them at the system default pair.

```json
{
  "items": [
    { "id": "endpoint_volume", "status": "ok", "device": "output", "value": "0.0",
      "detail": "Windows volume of the output \"Audio Interface Out (2- HD-II)\" is 0.0 dB (slider at 100 %)." },
    { "id": "exclusive_allowed", "status": "ok", "device": "output", "value": "allowed", "detail": "…" },
    { "id": "voicemeeter_owns_device", "status": "warn", "device": "output", "value": "a1",
      "detail": "Voicemeeter holds this device as its A1 output" }
  ]
}
```

`items` ids are stable: `exclusive_allowed`, `enhancements`, `sample_rate`, `endpoint_volume`, `output_kind`,
`power_plan`, `voicemeeter_owns_device`. `status` is `ok`, `warn`, `fail` or `unknown` (could not be read on
this system); `value` is the machine-readable reading per id and `detail` the sentence shown to a person.
`voicemeeter_owns_device` is the one finding that is not a Windows setting: an interface held by Voicemeeter
cannot be opened exclusively by the engine.

## routes

```text
mixai-live-engine routes [device options]
```

The routes this machine offers, compared on what each one **declares** — no cable, no measurement. Each row
carries where its figure comes from (`source`: `device` = read from the driver's period limits, `voicemeeter` =
read from Voicemeeter's configuration, `assumed` = the request, because the driver's real buffer cannot be read
without opening it), its three buffer terms and their sum, and the endpoint's period limits when they were read.
`measured_ms` is always null: a measured round trip comes from [`latency`](#latency) through a real loopback.

```json
{ "requested": { "rate": 48000, "buffer_frames": 128 },
  "routes": [ { "host": "WASAPI Exclusive", "terms": { "input_period_frames": 144, "cushion_frames": 144,
                 "output_period_frames": 144, "declared_ms": 9.0 }, "source": "device",
                 "note": "the device's minimum is 144 frames, so a request of 128 runs at 144" } ],
  "measured": "none: a round trip needs a loopback, run `latency` for that" }
```

See [latency.md](latency.md#choosing-a-route-routes) for the full table on the reference rig and how to read it.

## voicemeeter

```text
mixai-live-engine voicemeeter [--save <file.xml>] [--buffer <driver>=<frames>] [--load <file.xml>]
```

Windows only, read-only without flags: what the local Voicemeeter runs, as JSON.

```json
{
  "installed": true, "running": true, "kind": "potato", "version": "3.1.2.2", "sample_rate": 48000,
  "buffer_wdm": 256, "a1_device": "Audio Interface Out (2- HD-II)", "insert_channels": 34,
  "strips": [
    { "index": 4, "kind": "hardware", "label": "Q-28 (L mixer, R DJI)",
      "device": "Audio Interface IN (2- HD-II)", "channels": [8, 9], "a1": true, "b1": false }
  ]
}
```

`channels` are the insert-buffer channels of that strip (what `--in-ch` and `--main` take on the
`Voicemeeter Insert` host). The options change Voicemeeter, so `--save` is worth doing first:

- `--save <file.xml>`: Voicemeeter writes its whole configuration there (verified: the file is there, big
  enough, newer than before the request).
- `--buffer wdm=160`: set a buffer size (`mme` / `wdm` / `ks` / `asio`, 64…2048 frames) and restart
  Voicemeeter's audio; needs `--save` in the same call, and reads the value back before returning.
- `--load <file.xml>`: load a configuration saved with `--save`; Voicemeeter restarts its audio (a short
  dropout for everything that plays through it).

When using `--host "Voicemeeter Insert"` with `run`, `latency`, or `serve`, the engine runs inside Voicemeeter's
own audio callback (via the Voicemeeter Remote / Insert API). Hardware `--input` and `--output` options are omitted;
`--in-ch` routes from Voicemeeter insert channels, and `--main` / `--monitor` route back to insert return channels.

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
mixai-live-engine serve [device options] [--preset <name>] [--lan] [--osc] [--port <n>] [--name <text>]
                        [--seconds <n>] [--data-dir <dir>] [--no-store] [--no-midi]
```

| Flag | Default | Meaning |
|---|---|---|
| `--preset` | `Natural Vocal` | preset loaded at start |
| `--lan` | off | bind `0.0.0.0` (instead of `127.0.0.1`) and announce `_mixai-live._tcp` over mDNS |
| `--osc` | off | also accept OSC over UDP on `port + 1` (or a free port if taken); every address needs an OSC key ([protocol](remote-protocol.md#osc-address-space)) |
| `--port` | `17920` | HTTP/WebSocket port |
| `--name` | `MixAI Live` | engine name in `hello`, mDNS and the remote page |
| `--seconds` | none | exit after N seconds (tests) |
| `--data-dir` | per-user app data | where user presets, the last setlist and `midi.json` are kept ([presets](presets.md#storage)) |
| `--no-store` | off | keep presets/setlist/MIDI map in memory only (tests, kiosk) |
| `--no-midi` | off | do not open MIDI inputs (by default every input port is opened; [MIDI control](midi.md)) |

On start it prints **one `ready` JSON line** on stdout — the contract for the desktop shell and scripts:

```json
{
  "event": "ready",
  "port": 17920,
  "osc_port": null,
  "osc_performer_key": null,
  "osc_controller_key": null,
  "controller_url": "http://192.168.1.20:17920/?t=<controller token>",
  "performer_url": "http://192.168.1.20:17920/?t=<performer token>",
  "viewer_url": "http://192.168.1.20:17920/?t=<viewer token>",
  "info": { "host": "WASAPI", "input": "...", "output": "...", "sample_rate": 48000, "buffer_frames": 128, "...": "..." }
}
```

(printed on one line; shown wrapped here). With `--osc` the three `osc_*` fields hold the UDP port and the two
OSC keys; treat the keys as secrets too. Without `--lan` the URLs use `127.0.0.1`; with `--lan` they use the
machine's LAN address. Tokens are random per run; treat the URLs as secrets (anyone with the controller URL can
change the chain). Open a URL in a browser for the web remote page, or turn it into a QR code for phones. A
failed mDNS announcement is reported on stderr and pairing by URL/QR still works.

The control loop then runs every 5 ms (controls → session → engine commands, state and meters to clients);
see [architecture](architecture.md#control-flow) and the [remote protocol](remote-protocol.md).

```powershell
mixai-live-engine serve --input "Audio Interface IN (2- HD-II)" --output "Audio Interface Out (2- HD-II)" --monitor 2,3 --lan
```
