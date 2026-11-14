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
| Chain latency | 0 for most effects; 256 samples per `autotune`/`harmonizer`, and the `autotune` `fast` choice takes it to 1 sample for notes from 187.5 Hz up (`auto`, the default) | preset ([effects](effects.md)) |

The engine reports `nominal_latency_ms` = 3 × buffer ÷ rate (the three buffer terms above). The **real** round
trip is always larger; measure it with the probe below — the engine never reports driver figures as the
latency. The ADR-0015 target is ≤ 6 ms round trip at 64 frames on a good driver.

The desktop setup step shows both side by side as a **latency budget**: each stage the engine controls (input
period, the frames queued between input and output, output period, the effect chain — separately for the
audience's path and the ears') next to the measured round trip, with the difference labelled *driver, OS and
routing*. The declared side is a sum of what the engine sets; the measured side is what came back. Read them
that way: a small declared figure with a large measured one means the delay is outside the engine.

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

### Choosing a route: `routes`

`mixai-live-engine routes [device options]` compares the routes on what each one **declares**, which needs no
cable and no measurement: every figure is either read from a driver (the endpoint's period limits) or from a
setting (the buffer, Voicemeeter's own buffer sizes), and each row says which of the two it is (`source`:
`device`, `voicemeeter`, `assumed`). Run on the reference rig on 2026-11-14, `--buffer 128`:

| Route | Declared | Where the figure comes from |
|---|---:|---|
| WASAPI Exclusive | 9.00 ms | the device's own minimum: 128 was asked, the driver runs 144 × 3 |
| WASAPI (shared) | 30.00 ms | the Windows mixer's default period (480 × 3); the mixer adds buffering this does not count |
| Voicemeeter Insert | 10.67 ms | Voicemeeter's buffer twice (256 input + 256 A1), nothing queued between streams |
| ASIO | 8.00 ms | the request (128 × 3): an ASIO driver's real buffer is not readable without opening it |

Read it as a chooser, not as the answer: the *measured* figure for a route comes from `latency` through a real
loopback, and only that one is the truth about it. On the run above the exclusive route is the cheapest
declared path, and the insert route costs more than ASIO only because Voicemeeter runs at 256 frames; a smaller
Voicemeeter buffer (`voicemeeter --save --buffer wdm=160`) moves that row down.

- **ASIO build**: `cargo build --release --manifest-path apps/live/engine/Cargo.toml -p live-cli --features asio`.
  cpal's ASIO backend needs the Steinberg ASIO SDK (see cpal's ASIO setup notes: `CPAL_ASIO_DIR`, LLVM/clang
  for bindgen). **Licence**: the ASIO SDK is dual GPLv3 / proprietary Steinberg licence, which is why it is an
  opt-in feature (ADR-0015 §8). A binary built with it may only be redistributed under the Steinberg licence
  agreement or GPLv3 terms; the default build contains no ASIO code.
  - **Built and verified on this PC on 2026-11-13** (checked against `cpal 0.18.2` / `asio-sys 0.4.0` in the
    local cargo registry; the SDK is not in the repository and cannot be — it lives at `E:\asio\ASIOSDK`):
   1. Download the SDK from <https://www.steinberg.net/asiosdk> and accept its licence there. That download is
     the acceptance; `asio-sys` would otherwise do it by itself into the temp folder when `CPAL_ASIO_DIR` is
     unset, which is a decision to take deliberately, not by accident.
   2. Unzip it and set `CPAL_ASIO_DIR` to the folder that **directly contains** `common\` and `host\` (the
     `ASIOSDK2.x` root, not its parent: `asio-sys/build.rs` pushes `common`, `host` and `host/pc` onto it and
     looks for `asio.h`, `asiosys.h`, `asiodrivers.h` under them).
   3. Tools: a C++ compiler for the SDK's own sources (the MSVC toolchain this repo already builds with) and
     `libclang` for bindgen — LLVM is installed here (`C:\Program Files\LLVM\bin\libclang.dll`) and `clang`
     is on PATH; if bindgen cannot find it, set `LIBCLANG_PATH` to that `bin` folder.
   4. ```powershell
     $env:CPAL_ASIO_DIR = 'E:\asio\ASIOSDK'
     pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\run-build.ps1" -Command 'cargo build --release -p live-cli --features asio --manifest-path apps/live/engine/Cargo.toml'
     ```
     (took 1 m 41 s on this machine, incremental 50 s.)
   5. Name the device: `mixai-live-engine devices --host ASIO`. **What this machine has** (2026-11-13): seven
     ASIO devices, and the host's *default* one is `ASIO4ALL v2`, which answers no f32 format — the engine now
     says so instead of "device offers no f32 stream format":

     | ASIO device | in / out | note |
     |---|---:|---|
    | `Voicemeeter Potato Insert Vi...` | 34 / 34 | Voicemeeter's own ASIO face of the insert point the Remote-API host uses; the driver's name really ends in an ellipsis (see below) |
     | `Voicemeeter Insert Virtual ASIO` | 22 / 22 | same, standard/Banana layout |
     | `Voicemeeter Virtual ASIO` / `AUX` / `VAIO3` | 8 / 8 | the virtual buses |
     | `ASIO4ALL v2`, `FL Studio ASIO` | 2 / 2 | wrappers over WASAPI, not the interface's own driver |

   6. Run it with the interface's own driver on both sides (same device for input and output, no drift):
     `mixai-live-engine latency --host ASIO --input "<device>" --output "<device>" --buffer 64`.
     A direct test on this rig is worth it: `Voicemeeter Potato Insert Vi...` is the ASIO route to the same
     insert point the Remote-API host uses, so the two can be measured against each other.
     - **The ellipsis is part of the name.** ASIO gives a driver 32 characters for it and VB-Audio's full name
       ("Voicemeeter Potato Insert Virtual ASIO", 38) does not fit, so the driver reports `Voicemeeter Potato
       Insert Vi...` and that is the string `--input` has to match — a truncation of your own making is
       rejected with `device not found`. Copy the name from `devices --host ASIO` (measure every route in one
       go below prints the available names when the one you passed is not there).
     - **The buffer is the driver's, not yours.** The insert driver accepts one period only, 256 frames; ask
       for the WASAPI 128 and the probe fails with `Buffer size 128 is not in the supported range 256..=256`.
   7. Do not ship the binary (or a beta) before both signatures are on the agreement; the repository stores no
     SDK file, so CI cannot build this tier at all.
  - **Before any ASIO build leaves this PC** (decided 2026-11-12, tracker WP21-27; terms as read on Steinberg's
    pinned "ASIO SDK Proprietary Licensing FAQ" of 2026-10-21 — the agreement PDF and the ASIO Usage Guidelines
    are the binding texts and were not read here):
    1. A closed-source product that talks to ASIO drivers needs the proprietary agreement, hosts included. It is
      royalty-free (no application, yearly, per-product or per-unit fee) and one agreement covers every product
      of the licensee.
    2. The licensee is the legal person or company responsible for the product; an individual may sign in their
      own name. Send the completed, signed PDF (an electronic signature is accepted) to
      `sdklicenseagreements@steinberg.de`. Steinberg countersigns and sends it back; they ask not to enquire
      within the first 30 days.
    3. Development and internal tests may start at once. **No external distribution, a free beta included, before
      both sides have signed.**
    4. The app, its documentation and the product page must carry "ASIO is a registered trademark of Steinberg
      Media Technologies GmbH" and use the ASIO Compatible logo as the Usage Guidelines say (the artwork is in
      the SDK package). "ASIO" may not be part of a product or company name.
    5. The SDK itself is never redistributed; the repository holds no SDK file.
  ### Measuring every route in one go

  `scripts/live-measure-routes.ps1` runs `latency` once per route, keeps every answer and every failure
  verbatim, and writes a comparison next to the raw output:

  ```powershell
  pwsh -NoProfile -File scripts/live-measure-routes.ps1 -ResultsDir .copilot-tmp/live/measured -Tag first-run
  ```

  | | |
  |---|---|
  | `-Routes` | `exclusive,shared,insert,asio` (default) — ONE comma-separated string |
  | `-In` / `-Out` | the interface's capture and render endpoint (defaults are this rig's HD-II) |
  | `-InCh` / `-DirectInCh` | the input channel for the insert route (8: the mic is the left channel of strip 4) and for the direct routes (0: the interface has two channels, Voicemeeter's insert space has 34) |
  | `-Buffer` / `-AsioBuffer` | 128 for WASAPI and Voicemeeter, 256 for ASIO (that driver's only period) |
  | `-AsioDevice` | the exact driver name, ellipsis included |
  | `-ResultsDir` / `-Tag` | where the run lands: `<ResultsDir>/<Tag>/{comparison.md,raw.log,declared.json}` |

  It changes nothing — no setting, no buffer, no Voicemeeter configuration — but it does open the audio devices,
  so the Live engine must not be running. The file opens with a **Preconditions** block: whether Voicemeeter is
  running and which device is on bus A1 (while Voicemeeter holds the interface as A1, `exclusive` and `shared`
  cannot open it — measure those with Voicemeeter closed, and `insert` with it running), whether the binary was
  built with ASIO and whether the named device exists, and the reminder that every probe needs a loopback. Each
  row is either a measured round trip or the engine's own sentence about why the loop failed, so a table full of
  failures is still a correct run: on 2026-11-14 it reported `exclusive` = the device in use by Voicemeeter,
  `shared` = the mixer's client would not initialise, and `insert`/`asio` = no click came back (no loopback
  attached) — the declared column being filled in for all four from `routes`.

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

**The route below is a stream route, not a monitoring route.** An application that plays into a Voicemeeter
virtual input (`Voicemeeter Input`, `AUX`, `VAIO3`, `In 1`–`In 5`) goes through the internal buffer of that
virtual device before it reaches the Voicemeeter mix. VB-Audio recommends 4096–7168 samples for that buffer
(the range they document for their virtual cable; a figure for Voicemeeter's own inputs was not found),
which is 85–149 ms at 48 kHz (calculated from that recommendation; not measured on the reference rig).
Hearing yourself through `engine → Voicemeeter In 5 → A1` therefore carries that delay on top of the
interface. Use it to feed OBS; monitor another way:

- **Decided 2026-11-12, not built yet (tracker WP21-25):** the engine runs *inside* Voicemeeter's own audio
  callback on the microphone strip (Voicemeeter Remote API, input insert). The voice then stays in Voicemeeter's
  main stream: input buffer + A1 buffer, 2 × 256 frames = 10.7 ms at today's Voicemeeter setting, 6.0–6.7 ms
  if Voicemeeter runs at 144–160 frames (calculated; converter and USB delay come on top). Unproven until
  measured: that the callback adds no buffer of its own, and that Voicemeeter is stable below 256 frames on
  a class-compliant interface.
- **`WASAPI Exclusive` on the interface** (built): no Voicemeeter in the voice path, but Voicemeeter must give
  up the interface, and a copy for the stream needs a second output device (planned, after the insert).

The stream route:

1. Engine `--input` = the interface (or `Voicemeeter Out Bx` if Voicemeeter already owns the mic).
2. Engine `--output` = a Voicemeeter virtual input strip, e.g. `Voicemeeter In 5` (2 channels: main only — the
   monitor bus needs a device with ≥ 4 channels).
3. In Voicemeeter route that strip to **B1** for OBS (add an audio input capture of `Voicemeeter Out B1`);
   do not use A1 of this strip as your monitor, see above.
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
