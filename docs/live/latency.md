# MixAI Live — latency guide

What decides the delay between singing and hearing yourself, how to get it as low as possible on each OS, and
how to measure the real figure. Applies to `mixai-live-engine` as implemented today ([CLI](cli.md)).

## Where the latency comes from

```text
mic → ADC → driver input buffer → input ring (1 block) → output callback: chain → driver output buffer → DAC → ear
```

| Part | Size | Who controls it |
|---|---|---|
| Converters (ADC + DAC) | ~0.5–1.5 ms total, fixed by the interface | hardware |
| Driver/OS buffering + safety offsets | from 0 (good ASIO/CoreAudio drivers) to 10+ ms (WASAPI shared) | driver, host API |
| Input period | `--buffer` frames | you |
| Input ring target | one more `--buffer` block (absorbs callback jitter) | engine |
| Output period | `--buffer` frames | you |
| Chain latency | 0 for most effects; 256 samples per `autotune`/`harmonizer` | preset ([effects](effects.md)) |

The engine reports `nominal_latency_ms` = 3 × buffer ÷ rate (the three buffer terms above). The **real** round
trip is always larger; measure it with the probe below — the engine never reports driver figures as the
latency. The ADR-0015 target is ≤ 6 ms round trip at 64 frames on a good driver.

The native WASAPI hosts report the periods the driver really runs: nominal = (input period + ring target +
output period) ÷ rate, where the ring target is the larger of the two periods. With one interface for input
and output the periods are equal and this is again 3 periods. With unequal periods (two devices) the ring
holds up to `input − output` frames more, and a start can count one xrun before the phase settles.

### Buffer sizes at 48 kHz

| `--buffer` | One period | Engine nominal (3 periods) | + one pitch effect | Typical use |
|---|---|---|---|---|
| 32 | 0.67 ms | 2.0 ms | 7.3 ms | ASIO/CoreAudio with a strong CPU, few effects |
| 64 | 1.33 ms | 4.0 ms | 9.3 ms | in-ear target on ASIO/CoreAudio/JACK |
| 128 (default) | 2.67 ms | 8.0 ms | 13.3 ms | safe default, most interfaces |
| 256 | 5.33 ms | 16.0 ms | 21.3 ms | weak CPU, Bluetooth-free laptops, streaming only |
| 512 | 10.67 ms | 32.0 ms | 37.3 ms | not for monitoring |

Accepted range: 16–4096 frames. Some drivers ignore the requested size and call with larger periods; the engine
copes (scratch buffers are sized for 8 × the request, at least 2048 frames) but the latency follows the driver.
Use 48 kHz unless your interface runs better at 96 kHz (half the time per frame at the same buffer size, double
the CPU per second). Watch `dsp_load_max` and `xruns`/`driver_xruns` in the `run` output: lower the buffer until
xruns appear, then go one step up.

## Measure the real round trip

`mixai-live-engine latency` plays a click train and listens for it on the input
(`live-engine/src/latency.rs`):

1. 100 ms of silence measures the noise floor; the detection threshold is max(4 × noise peak, 0.02).
2. Five 2-sample clicks (+0.9 / −0.9, broadband) are sent 400 ms apart on **both** the main and monitor outputs.
3. For each click the first input sample above the threshold within 350 ms is the arrival.
4. The **median** of the detected clicks is reported; at least 3 of 5 must come back, else it fails.
5. Everything runs inside the audio callback (no allocation); the CLI waits 500 ms for the streams to settle
  and gives up after 10 s. The CLI mutes the engine output for the measurement, so only the clicks are played.

You need a loopback from the output back to the input — any of:

- **Cable**: interface output 1 → interface input 1 (turn the monitor/direct-monitor knob down first).
- **Acoustic**: speaker → microphone (measures the room too; keep the level moderate).
- **Voicemeeter** (Windows, measures the Voicemeeter path): engine output `Voicemeeter In 5`, route that strip
  to bus **B1** only, engine input `Voicemeeter Out B1`.

```powershell
mixai-live-engine latency --input "Audio Interface IN (2- HD-II)" --output "Audio Interface Out (2- HD-II)" --buffer 64
# Voicemeeter path
mixai-live-engine latency --input "Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)" --output "Voicemeeter In 5 (VB-Audio Voicemeeter VAIO)"
```

Output (JSON): `round_trip_ms` (measured), `nominal_ms`, `chain_latency_samples` (0: the probe runs before the
chain and the latency command loads no preset), `in_peak_db` (loudest input during the probe) and `info`
(devices, rate, buffer, notes). Failure says
`no click came back (loudest input during the probe: <x> dBFS): route the output to the input ...`; a level
below about −34 dBFS means the click did not arrive at a usable level. Over the [remote protocol](remote-protocol.md) a
controller sends `latency_probe` and reads `meters.latency_probe` (`{"done_ms": x}` or `"failed"`).

## Windows

| Host | Latency | How |
|---|---|---|
| **ASIO** | lowest (interface driver, often 32–64 frames stable) | build with `--features asio`, run with `--host ASIO` |
| **WASAPI Exclusive** | lowest without ASIO: the engine owns the endpoint, no Windows mixer, buffer = one device period | `--host "WASAPI Exclusive"`; fails with `the device is in use by another application` while anything else (Voicemeeter, a browser) holds the device |
| WASAPI Low Latency | shared mode at the smallest engine period the driver offers (`IAudioClient3`); other apps keep the device | `--host "WASAPI Low Latency"`; the device must already run at `--rate` |
| WASAPI (default) | highest: shared mode at the default engine period (usually 10 ms) | default host, nothing to configure |

`mixai-live-engine periods --device <name>` prints the three period limits of a device ([CLI](cli.md#periods)).
A `--buffer` below the device minimum is raised to it; `info.notes` says which period and sample format the
driver really runs.

- **ASIO build**: `cargo build --release --manifest-path apps/live/engine/Cargo.toml -p live-cli --features asio`.
  cpal's ASIO backend needs the Steinberg ASIO SDK (see cpal's ASIO setup notes: `CPAL_ASIO_DIR`, LLVM/clang
  for bindgen). **Licence**: the ASIO SDK is dual GPLv3 / proprietary Steinberg licence, which is why it is an
  opt-in feature (ADR-0015 §8). A binary built with it may only be redistributed under the Steinberg licence
  agreement or GPLv3 terms; the default build contains no ASIO code.
- ASIO drivers usually expose one device for input and output: pass the same device to `--input` and `--output`
  (no clock drift). With two different devices the engine corrects drift by dropping frames and says so in
  `info.notes`.
- Use the interface's own ASIO driver, not ASIO4ALL/FlexASIO on top of WASAPI, when latency matters.
- Set the Windows power plan to High/Ultimate performance; disable USB selective suspend for the interface.
- Realtime thread priority: cpal requests it; a refusal is logged as `realtime priority denied` and the stream
  keeps running. The two native WASAPI hosts run one audio thread registered with MMCSS "Pro Audio"
  (`info.notes` says `MMCSS Pro Audio`, or that Windows refused it); streams of the default `WASAPI` host are
  registered on their first callback.

## macOS

- CoreAudio is the default and only host; good interfaces run 32–64 frames.
- Prefer one device for input and output. For separate devices create an **Aggregate Device** in Audio MIDI
  Setup with drift correction on the non-clock device — better than the engine's frame dropping.
- Running from Terminal: macOS asks for microphone permission for the terminal app; without it the input is
  silent and the latency probe fails.

## Linux

| Host | Build | Notes |
|---|---|---|
| ALSA (default) | default build (needs `libasound2-dev` + `pkg-config`) | use `hw:` devices for the lowest latency; `default`/`pulse` add buffering |
| PipeWire | `--features pipewire` (needs the PipeWire dev package) | set the graph quantum, e.g. `pw-metadata -n settings 0 clock.force-quantum 64` |
| JACK | `--features jack` (needs the JACK dev package) | run with `--host JACK`; works through `pipewire-jack` too |

Give the user realtime scheduling (rtkit, or an `@audio - rtprio 95` limit), use a low-latency or `PREEMPT_RT`
kernel for 32–64 frames, and set the CPU governor to `performance`.

## Streaming, OBS and Voicemeeter

Today the engine opens **one** input device and **one** output device; `--main` and `--monitor` are channel
pairs of that output device. Virtual devices of our own (VirtualDrivers on Windows, an AudioServerPlugIn on
macOS, PipeWire nodes) and Voicemeeter Remote API control are planned (WP21-12).

### Without Voicemeeter

- **Stage / in-ear only**: input = interface mic, output = the same interface;
  `--main 0,1` → PA outputs, `--monitor 2,3` → headphone/in-ear outputs (4-output interfaces). Lowest latency.
- **Streaming on the same PC**: OBS captures the interface outputs if the driver exposes a loopback channel, or
  set `--output` to a virtual cable (VB-Cable, VirtualDrivers, BlackHole) and pick that cable in OBS — but then
  you monitor through the cable path (higher latency), so keep the interface's direct monitoring for your ear.
- **macOS**: an Aggregate Device of interface + BlackHole 16ch lets one output device carry both:
  `--main` → BlackHole channels (OBS), `--monitor` → interface channels (ear).

### With Voicemeeter (Windows)

Voicemeeter adds its own buffering (set its buffering to the interface's ASIO driver for the lowest figure).

1. Engine `--input` = the interface (or `Voicemeeter Out Bx` if Voicemeeter already owns the mic).
2. Engine `--output` = a Voicemeeter virtual input strip, e.g. `Voicemeeter In 5` (2 channels: main only — the
   monitor bus needs a device with ≥ 4 channels).
3. In Voicemeeter route that strip to **A1** (your headphones/interface) for monitoring and **B1** for OBS;
   in OBS add an audio input capture of `Voicemeeter Out B1`.
4. Measure the path with the Voicemeeter loopback above. The devices list marks Voicemeeter endpoints with
   `"voicemeeter": true` and virtual cables with `"virtual_cable": true`.

Measured on the reference rig (HD-II interface → Voicemeeter In 5, WASAPI, 128 frames): DSP load 1.3 % average
with "Natural Vocal".

Driver-reported periods on the same rig (HD-II on the Microsoft `usbaudio2` class driver, 48 kHz, input and
output alike): exclusive minimum **144 frames (3 ms)**, shared low-latency minimum **336 (7 ms)**, shared
default **480 (10 ms)**. By these figures a request of 64 or 128 frames is raised to at least 144 on this
interface. The loopback round trip is **not measured yet**: the probe run of 2026-11-10 got no click back on
any of the three WASAPI hosts (cause not established: no loopback cable, or the wrong input channel / gain),
so the native hosts have opened this interface but have not yet been shown to pass audio through it. The
figure stays open in the tracker (WP21-03).
