# MixAI Decks — controller mapping format v1

Crate: `apps/mixai/src-tauri/crates/decks-mapping` (MIT OR Apache-2.0). ADR-0014 (D66), tracker WP19-12.

The crate turns raw controller bytes into a fixed action vocabulary and engine state back into
LED / meter MIDI. It is pure Rust, single-threaded and timestamp-driven; the host owns ports
and threads.

```text
MIDI / BLE bytes ─► StreamParser / BleMidiDecoder ─► MappingEngine::on_midi ─► Vec<Action>
                                                          │ script hook (rhai, sandboxed)
engine state ─► FeedbackProvider ─► MappingEngine::feedback ─► Vec<MidiOut> (LEDs, meters)
ClockGenerator::poll(now) ─► F8/FA/FB/FC/F2      ClockFollower ◄─ incoming F8/FA/FC/F2
```

## Licence and provenance rule

Mappings are derived **only** from manufacturers' published MIDI documentation. Mixxx mapping
files (GPL-2.0+) and other GPL controller scripts are never read or copied (ADR-0014). Every
built-in profile lists its sources in `sources`:

| Profile | Sources |
|---|---|
| Pioneer DDJ-FLX4 (rekordbox and Serato layouts) | AlphaTheta, *DDJ-FLX4 List of MIDI messages* Ver 1.0 — <https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/DDJ-FLX4_MIDI_message_List_E1.pdf> (index: <https://support.alphatheta.com/en-US/articles/12294087060377>); *DDJ-FLX4 Operating Instructions* (rekordbox / Serato button functions, pad-mode tables) — <https://downloads.support.alphatheta.com/manuals/dj-controllers/DDJ-FLX4/DDJ-FLX4_DRI1804A_manual.pdf>; Serato, *Pioneer DJ DDJ-FLX4 Quickstart Guide* — <https://support.serato.com/hc/en-us/articles/17935362399887-Pioneer-DJ-DDJ-FLX4-Quickstart-Guide> |
| Novation Circuit Tracks | Novation, *Circuit Tracks Programmer's Reference Guide* v3 — downloads page <https://downloads.novationmusic.com/novation/circuit/circuit-tracks> (stable mirror of the same PDF: <https://github.com/Sound-Research/Novation-Circuit-Tracks/blob/main/circuit_tracks_programmer_s_reference_guide_v3.pdf>) |
| Generic MIDI keyboard, generic 2-deck | MixAI conventions (no vendor data) |

MMA SysEx manufacturer ids used for identity matching: Pioneer `00 40 05`, Focusrite/Novation
`00 20 29`. USB vendor ids: Pioneer DJ / AlphaTheta `0x2B73`, Focusrite-Novation `0x1235`.

## Document structure

A mapping is one JSON object (`MappingFile`). Conventions:

* MIDI channels are **1-based** (1–16), as printed in manufacturers' tables; absent = omni.
* Decks, mixer channels, FX units, sampler slots and hot-cue slots are **0-based**.
* Runtime-filled action fields (`value`, `delta`, `pressed`, `velocity`, `note`, `index`,
  `on`) may be omitted; the engine fills them from the control.

| Field | Meaning |
|---|---|
| `version` | `1` |
| `id`, `name`, `vendor`, `description` | identity |
| `sources` | URLs of the documents the mapping was derived from |
| `device` | recognition: `name_regex`, `usb[{vendor_id, product_id?}]`, `sysex_identity{manufacturer, family?, member?}`, `priority`, `fallback` |
| `inputs[]` | physical controls: `id`, `channel?`, `type` + fields (below) |
| `modifiers[]` | shift layers: `id`, `input?` (absent = virtual, host sets it), `toggle` |
| `deck_layers[]` | deck switching: `side`, `decks[]`, `input?` (each press advances) |
| `bindings[]` | `input`, `action`, `when{modifiers[], exact, pad_mode?}`, `trigger`, `transform{curve, range, invert, scale}`, `soft_takeover`, `side?`, `scale_lock?` |
| `outputs[]` | feedback: `id`, `channel`, `message` (`note`/`cc`), `number`, `source`, `side?`, `type` (`led{on,off}` / `colour{off}` / `meter{min,max}`) |
| `clock` | `{receive, send}` — follow incoming MIDI clock / send clock |
| `groove` | `{channels[], quantize_ticks (96 PPQ), bars}` — groove-lane recording |
| `script` | `{source, max_operations?, max_millis?}` — sandboxed rhai |

### Device matching

`DeviceMatch::score(&DeviceInfo)`; the highest score wins (`profiles::detect`). Strong rules:
name regex (+100), exact USB vendor+product (+300), identity reply with family (+300). Weak
rules (USB vendor only, identity manufacturer only) count only when the name regex also
matched, so a Novation Launchpad is not mistaken for a Circuit Tracks. `fallback: true`
profiles match anything at the lowest score. Send `format::IDENTITY_REQUEST`
(`F0 7E 7F 06 01 F7`) on connect and pass the reply in `DeviceInfo::identity_reply`.

### Input types

| `type` | Fields | Event |
|---|---|---|
| `note` | `note` | press (velocity > 0) / release (Note Off or velocity 0) |
| `note_range` | `first`, `last` | as `note`; the note is passed to `sampler.note`, and `note - first` is added to `slot` of `sampler.trigger` / `deck.hot_cue` |
| `cc` | `cc`, `relative?` | absolute 0..1, or relative delta with `two_complement` (`0x01` +1, `0x7F` −1), `sign_magnitude` (`0x41` −1), `offset64` (`0x41` +1, `0x3F` −1) |
| `cc14` | `msb`, `lsb` | 14-bit absolute; emitted when the LSB arrives (MIDI 1.0 order MSB then LSB) |
| `jog` | `cc`, `encoding` | relative; a `jog_scratch` binding becomes `jog_bend` while the deck's jog is not touched (`jog_touch` action) |
| `nrpn` | `param`, `high_res` | CC 99/98 select, CC 6 (+38) data, CC 96/97 increment / decrement |
| `pitch_bend` | — | 14-bit absolute |
| `program_change` | `first`, `last` | `program - first` fills `index` (`sampler.select_pattern`) |
| `sysex` | `pattern` | hex bytes with `??` wildcards, exact length |

### Modifiers, layers, triggers

* Among the bindings of one input whose conditions hold, only those requiring the **most**
  modifiers fire: an unshifted binding keeps working under SHIFT unless a SHIFT-specific
  binding exists. `exact: true` additionally forbids any other held modifier.
* Hardware-shift controllers (the FLX4 sends different notes under SHIFT) need no conditions.
* `side` + `deck_layers`: the action's deck (or mixer channel) is replaced by the deck the
  side currently targets; outputs with `side` follow the same layer.
* `trigger`: `auto` (momentary actions on press + release, value actions always, others on
  press), `press`, `release`, `both`.
* Value-less actions on an absolute control (a CC switch) fire on the 0.5 crossing.

### Value transforms

`curve` (`linear`, `log` = audio taper `(10^(2x)−1)/99`, `exp`, `s_curve` = smoothstep),
`range [min, max]`, `invert`, `scale` (multiplier for relative deltas). A relative encoder bound
to an absolute target accumulates from the engine's last known value (`sync_value`).

### Soft takeover

With `soft_takeover: true` an absolute control is ignored until it comes within 3 % of the
range of the engine's value or crosses it. The host reports engine-side changes with
`MappingEngine::sync_value(&action_with_value)`; values the engine emitted itself are tracked
automatically.

### MIDI learn

`start_learn(Some(target_action))` → touch a control → `poll_learn(now_us)` (gesture ends
after 300 ms of silence, Note On is immediate) → `learned_binding()` → `add_binding(...)`.
Detection: CC *n* together with CC *n*+32 → `cc14`; CC 99/98 + 6 (+38) → `nrpn`; repeated
small steps around 64 / near 0 and 127 / near 1 and 65 → relative encoder
(offset-64 / two's complement / sign-magnitude); otherwise absolute `cc`. Learned absolute
controls get soft takeover.

### Feedback

`feedback(&state)` returns only changed outputs plus script output; `feedback_all` resends
everything (after connect or a deck switch). `FeedbackKey` sources: `playing`,
`cue_indicator`, `sync`, `loop_active`, `hot_cue_set`, `hot_cue_colour`, `pad_mode`,
`vinyl_mode`, `loaded`, `channel_cue`, `vu`, `jog_position`, `fx_on`, `sampler_loaded`,
`sampler_playing`, `master_cue`, `custom{name}`. `led` sends `on`/`off`; `colour` sends the
colour index (0–127) as velocity; `meter` scales a 0..1 level to `min..max` (VU, jog ring).

## Action vocabulary

JSON: `{"<group>": {"type": "<action>", ...fields}}`, snake_case.

| Group | Actions |
|---|---|
| `deck` | `play_pause`, `cue{pressed}`, `cue_goto_start`, `stutter`, `sync`, `sync_off`, `set_tempo_master`, `tempo_range_cycle`, `tempo{value}`, `key_lock`, `key_shift{semitones}`, `jog_touch{pressed}`, `jog_scratch{delta}`, `jog_bend{delta}`, `jog_search{delta}`, `vinyl_mode`, `loop_in{pressed}`, `loop_out{pressed}`, `auto_loop{beats}`, `loop_exit`, `loop_roll{beats,pressed}`, `loop_halve`, `loop_double`, `loop_active_toggle`, `hot_cue{slot,pressed}`, `hot_cue_delete{slot}`, `cue_call{direction}`, `cue_memory_delete`, `cue_memory_save`, `beat_jump{beats}`, `beat_jump_by_size{direction}`, `beat_jump_size{direction}`, `pad_mode{mode}`, `pitch_play{semitones,pressed}`, `censor{pressed}`, `reverse`, `seek{direction,pressed}`, `load_previous` — all with `deck` |
| `mixer` | `volume`, `trim`, `eq{band: low/mid/high}`, `filter`, `send{bus}` (with `channel`, `value`); `crossfader`, `master_volume`, `master_filter`, `master_filter_resonance`, `headphone_mix`, `headphone_level`, `mic_level` (`value`); `headphone_cue{channel}`, `master_cue`, `smart_fader`, `smart_cfx`, `fader_start{channel,start}`, `crossfader_start{channel,start}` |
| `fx` | `toggle{unit}`, `select{unit,direction}`, `beats{unit,direction}`, `level{unit,value}`, `param{unit,index,value}`, `assign{unit,channel,on}`, `pad_fx{deck,page,slot,pressed}`, `tap_tempo{unit}`, `tap_reset{unit}` |
| `library` | `scroll{delta}`, `scroll_fast{delta}`, `focus_next`, `focus_previous`, `load{deck}`, `sort{column: bpm/artist/title/key}`, `zoom_waveform{delta}` |
| `sampler` | `trigger{slot,velocity,pressed}`, `stop{slot}`, `load{slot}`, `note{instrument,note,velocity,pressed}`, `volume{value}`, `bank{direction}`, `select_pattern{index,queued}` |
| `clock` | `start`, `stop`, `continue`, `song_position{sixteenths}`, `tempo{bpm}` (from the follower), `set_mode{mode: internal/master/follow}`, `tap`, `nudge{direction}` |

Pad modes: `hot_cue`, `pad_fx1`, `pad_fx2`, `beat_jump`, `beat_loop`, `sampler`, `keyboard`,
`key_shift`, `pitch_play`, `roll`, `auto_loop`.

## Built-in profiles

### Pioneer DDJ-FLX4 — `pioneer-ddj-flx4-rekordbox`, `pioneer-ddj-flx4-serato`

Channel plan from the official list: deck 1 / 2 = ch 1 / 2; performance pads ch 8 / 10
(SHIFT: ch 9 / 11, pad note = mode offset + pad: hot cue `0x00`, pad FX 1 `0x10`, beat jump
`0x20`, sampler `0x30`, keyboard / pitch play `0x40`, pad FX 2 / roll `0x50`, beat loop /
auto loop `0x60`, key shift `0x70`); Beat FX ch 5 / 6; mixer and browser ch 7; illumination
ch 16. Jogs are offset-64 relative (platter vinyl-on CC `0x22`, vinyl-off `0x23`, wheel side
`0x21`, SHIFT `0x29`, touch note `0x36` / SHIFT `0x67`); browse is two's complement (CC `0x40`,
SHIFT `0x64`); every knob / fader is 14-bit (MSB *n*, LSB *n*+32). LED outputs reuse the
MIDI-OUT column; channel meters are CC `0x02` on ch 1 / 2; "track loaded" is ch 16 notes 0 / 1.

The unit has **no software-mode switch** and one message list for all software, so the two
profiles send identical bytes and differ only in the functions bound (SHIFT+PLAY stutter,
SHIFT+OUT vinyl mode, CUE/LOOP CALL = memory cue call vs. loop ½/2×, SHIFT pad modes Keyboard /
Pad FX 2 / Beat Loop vs. Pitch Play / Roll / Auto Loop, beat-jump pad layouts, sampler slots
1–16 split across decks vs. 1–8 per deck, SHIFT+LOAD sort in Serato). Because MIDI traffic
cannot reveal the mode, `profiles::flx4_layout(&device, preference)` resolves it from an
explicit user preference (or the software a library was imported from), then a port-name
hint, else rekordbox; `detect()` returns the rekordbox layout by default.
Serato Roll and Auto Loop sizes are MixAI defaults (the quickstart does not list them).

### Novation Circuit Tracks — `novation-circuit-tracks`, `novation-circuit-tracks-clock-out`

From the Programmer's Reference Guide: synth 1 / 2 on ch 1 / 2 → `sampler.note` instruments
0 / 1, scale-locked to the playing track's key (`set_track_key`); macro knobs CC 80–87 →
`fx.param` of FX unit 0 / 1 (soft takeover); drums on ch 10, notes 60 / 62 / 64 / 65 →
sampler slots 0–3, or deck 1 hot cues 1–4 while the virtual modifier `drums_to_cues` is set;
project channel 16: programme change 0–63 instant / 64–127 queued → `sampler.select_pattern`,
CC 74 master filter, CC 71 resonance. Realtime: start / stop / continue / clock and song
position pointer. The first profile follows the Circuit's clock (`clock.receive`), the second
sends MixAI's clock to it (`clock.send`, drive `clock_out(now)`). Groove recording covers
ch 1, 2 and 10, 16th-note quantise, 4 bars.

### Generic MIDI keyboard — `generic-midi-keyboard`

Omni. Keys → scale-locked instrument 0 in the track key (`scale_lock(note, key, mode)`, ties
round down: E in C minor → E♭); hold sustain (CC 64) to turn keys 36–51 into sampler slots
0–15; pitch bend → deck 1 tempo ±8 %; mod wheel → FX unit 0 param 0.

### Generic 2-deck fallback — `generic-2-deck`

Matches any device. Per side (ch 1 / 2): notes 0 play, 1 cue, 2 sync, 3 headphone cue, 4–11
hot cues (SHIFT = delete), 12 SHIFT, 13 deck switch (A: 1↔3, B: 2↔4), 14 jog touch; CC 7
volume (log curve), 8 / 9 / 10 EQ, 11 filter, 12 tempo, 16 jog (offset-64, SHIFT = search).
Ch 1: CC 20 crossfader, 21 master, 22 browse (two's complement), notes 20 / 21 load A / B,
22 tap tempo.

## Scripts (rhai sandbox)

Optional `script.source`, compiled once per mapping:

```rhai
fn init() { set_state("presses", 0); }

fn on_midi(ev) {            // ev: #{ port, time, kind, channel, data1, data2, value, bytes }
    if ev.kind == "note_on" && ev.channel == 1 && ev.data1 == 0x0B {
        set_state("presses", get_state("presses") + 1);
        emit(#{ deck: #{ type: "play_pause", deck: 0 } });
        note(1, 0x0B, 127);   // LED, delivered with the next feedback()
        return true;          // consume: skip regular bindings for this event
    }
    false
}
```

API: `emit(action_map)`, `note(ch, note, vel)`, `cc(ch, cc, val)`, `send([bytes])`,
`get_state(key)`, `set_state(key, value)`. Sandbox: no file, network or process API in rhai;
built with `no_module` (no `import`), `eval` disabled, `print` / `debug` swallowed; each call
is limited to `max_operations` (default 100 000) and `max_millis` (default 5 ms, enforced from
the progress callback), call depth 32, strings 4 KiB, arrays 1024, maps 256. A failing call
drops its partial output, is reported through `take_script_errors()`, and the regular bindings
still run.

## MIDI clock

* `ClockGenerator` (master): 24 PPQN from BPM; `start(now, phase)` delays the first tick so the
  downbeat lands on the host beatgrid; `stop`, `resume` (Continue), `set_song_position`
  (16ths); `poll(now)` returns every due event with its exact fractional timestamp (no drift,
  late polls catch up). Verified: 24 ticks per beat at 128 BPM, each within 0.1 ms of ideal.
* `ClockFollower` (slave): window of the last 48 ticks (2 beats), minimax line fit (bounded
  USB jitter → error ~J/n²); resets on gaps > 0.5 s. Verified: converges to 127.9–128.1 BPM
  within 2 beats under ±1 ms jitter. Tracks start / stop / continue / SPP, `song_position()`,
  `beat_phase()`.

## Groove lane

`GrooveRecorder` quantises incoming notes to a grid position (`bar`, `beat`, `tick` at 96 PPQ)
inside an *n*-bar loop (overdub replaces same step + key), records lengths from note-offs, and
serialises as `GroovePattern` JSON. Beat position comes from the clock follower when the
device runs the clock, otherwise from `set_beat_position` (deck beatgrid). `GroovePlayer::poll`
returns note on / off events in `(last poll, now]`, looping.

## Transports

`MidiTransport` (enumerate inputs / outputs, connect in with a callback `(µs, bytes)`, connect
out, send). Implementations: `MemoryTransport` (loopback for tests / headless) and, behind
the `midir` feature, `MidirTransport` over midir 0.11.1 (WinMM / WinRT, CoreMIDI, ALSA / JACK,
Android AMidi).

### BLE MIDI

`ble::BleMidiDecoder` / `BleMidiEncoder` implement the *MIDI over Bluetooth Low Energy* 1.0
packet format (header byte with timestamp bits 12–7, timestamp byte with bits 6–0 before every
status, low-byte wrap increments the high bits, running status with or without timestamp,
SysEx spanning packets and interrupted by realtime). Native layers hand raw GATT
characteristic values (service `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, characteristic
`7772E5DB-3868-4112-A1A9-F2669D106BF3`) to the decoder and feed `on_message`:

| OS | Path |
|---|---|
| Windows | Windows MIDI Services (in-box from Windows 11 24H2/25H2 servicing) exposes BLE MIDI 1.0 devices as regular MIDI endpoints, so midir / WinRT already sees them; raw GATT via `Windows.Devices.Bluetooth.GenericAttributeProfile` only when MIDI Services is unavailable. |
| macOS / iOS | CoreMIDI presents paired BLE MIDI devices as normal endpoints (pairing through `CABTMIDICentralViewController` on iOS, Audio MIDI Setup on macOS); CoreBluetooth + this decoder for apps that manage GATT themselves. |
| Android | `android.media.midi` (`MidiManager.openBluetoothDevice`) / NDK AMidi expose BLE devices as MIDI ports with timestamps already decoded; `BluetoothGatt` notifications + this decoder as the raw fallback. |
| Linux | BlueZ with `--enable-midi` provides an ALSA sequencer port (midir ALSA backend). |

## Limits

* Profiles were transcribed from the documents above and unit-tested against them; not yet
  exercised on physical hardware.
* FLX4 layout auto-detection from traffic is impossible (identical messages); it needs the
  preference / name hint described above.
* NRPN outputs, colour palettes per device and jog-ring displays are supported by the format
  but no built-in profile uses them yet (the FLX4 has single-colour pads, the Circuit Tracks
  pad LEDs are not documented in the Programmer's Guide).
* Script wall-time is checked every 128 operations; a single long native call (e.g. a large
  string build up to the 4 KiB cap) cannot be interrupted mid-call.

## JSON Schema (generated)

Generated from the Rust types by `schemars` (`decks_mapping::json_schema_string()`); the test
`schema_in_docs_is_up_to_date` fails when this block is stale. Regenerate with
`$env:DECKS_MAPPING_BLESS='1'; cargo test -p decks-mapping --test schema`.

<!-- BEGIN GENERATED SCHEMA (cargo test -p decks-mapping --test schema) -->

```json
{
  "$defs": {
    "Action": {
      "description": "One semantic action produced by the mapping engine.",
      "oneOf": [
        {
          "additionalProperties": false,
          "properties": {
            "deck": {
              "$ref": "#/$defs/DeckAction"
            }
          },
          "required": [
            "deck"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "mixer": {
              "$ref": "#/$defs/MixerAction"
            }
          },
          "required": [
            "mixer"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "fx": {
              "$ref": "#/$defs/FxAction"
            }
          },
          "required": [
            "fx"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "library": {
              "$ref": "#/$defs/LibraryAction"
            }
          },
          "required": [
            "library"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "sampler": {
              "$ref": "#/$defs/SamplerAction"
            }
          },
          "required": [
            "sampler"
          ],
          "type": "object"
        },
        {
          "additionalProperties": false,
          "properties": {
            "clock": {
              "$ref": "#/$defs/ClockAction"
            }
          },
          "required": [
            "clock"
          ],
          "type": "object"
        }
      ]
    },
    "Binding": {
      "description": "Input → action.",
      "properties": {
        "action": {
          "$ref": "#/$defs/Action"
        },
        "input": {
          "description": "Input id.",
          "type": "string"
        },
        "scale_lock": {
          "anyOf": [
            {
              "$ref": "#/$defs/ScaleLockDef"
            },
            {
              "type": "null"
            }
          ]
        },
        "side": {
          "description": "Physical side; the action's deck is rewritten by the side's deck layer.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "soft_takeover": {
          "description": "Ignore an absolute control until it reaches the engine's current value.",
          "type": "boolean"
        },
        "transform": {
          "$ref": "#/$defs/ValueTransform"
        },
        "trigger": {
          "$ref": "#/$defs/Trigger"
        },
        "when": {
          "$ref": "#/$defs/Condition"
        }
      },
      "required": [
        "input",
        "action"
      ],
      "type": "object"
    },
    "ClockAction": {
      "oneOf": [
        {
          "properties": {
            "type": {
              "const": "start",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "stop",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "continue",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Song Position Pointer (16th notes).",
          "properties": {
            "sixteenths": {
              "default": 0,
              "format": "uint16",
              "maximum": 65535,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "song_position",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Tempo estimate from the clock follower changed.",
          "properties": {
            "bpm": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "tempo",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "mode": {
              "$ref": "#/$defs/ClockMode"
            },
            "type": {
              "const": "set_mode",
              "type": "string"
            }
          },
          "required": [
            "type",
            "mode"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "tap",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "nudge",
              "type": "string"
            }
          },
          "required": [
            "type",
            "direction"
          ],
          "type": "object"
        }
      ]
    },
    "ClockConfig": {
      "description": "MIDI clock behaviour of this device.",
      "properties": {
        "receive": {
          "default": false,
          "description": "Follow incoming clock (device is master / engine is slave).",
          "type": "boolean"
        },
        "send": {
          "default": false,
          "description": "Send clock to the device (engine is master).",
          "type": "boolean"
        }
      },
      "type": "object"
    },
    "ClockMode": {
      "description": "Clock role of the engine relative to external gear.",
      "oneOf": [
        {
          "const": "internal",
          "description": "Engine tempo is internal; no clock is sent.",
          "type": "string"
        },
        {
          "const": "master",
          "description": "Engine sends MIDI clock (master).",
          "type": "string"
        },
        {
          "const": "follow",
          "description": "Engine follows incoming MIDI clock (slave).",
          "type": "string"
        }
      ]
    },
    "Condition": {
      "description": "Binding conditions.\n\nAmong the bindings of one input whose conditions hold, only those requiring the **most**\nmodifiers fire. So an unshifted binding still works while SHIFT is held unless a\nSHIFT-specific binding exists for that input (hardware-shift controllers such as the FLX4\nsend different messages under SHIFT and need no conditions at all).",
      "properties": {
        "exact": {
          "description": "If true, no other modifier may be held.",
          "type": "boolean"
        },
        "modifiers": {
          "description": "Modifiers that must be held.",
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "pad_mode": {
          "anyOf": [
            {
              "$ref": "#/$defs/PadMode"
            },
            {
              "type": "null"
            }
          ],
          "description": "Only when the target deck's pad mode equals this."
        }
      },
      "type": "object"
    },
    "Curve": {
      "description": "Response curve applied to a normalised control value in `0.0..=1.0`.",
      "oneOf": [
        {
          "enum": [
            "linear"
          ],
          "type": "string"
        },
        {
          "const": "log",
          "description": "Audio-taper: `(10^(2x) - 1) / 99` — fine resolution at the bottom (volume faders).",
          "type": "string"
        },
        {
          "const": "exp",
          "description": "Inverse of `log`: fine resolution at the top.",
          "type": "string"
        },
        {
          "const": "s_curve",
          "description": "Smoothstep `3x² - 2x³` — fine resolution around both ends, steep in the middle.",
          "type": "string"
        }
      ]
    },
    "DeckAction": {
      "description": "Per-deck transport, loop, cue, jog and pad actions.",
      "oneOf": [
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "play_pause",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "cue",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Return to the start of the track.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "cue_goto_start",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Jump to the temporary cue and play (Serato SHIFT+PLAY).",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "stutter",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Toggle beat sync.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "sync",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "sync_off",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "set_tempo_master",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "tempo_range_cycle",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Pitch fader, -1.0 (min) ..= 1.0 (max) after the binding's value range.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "tempo",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "key_lock",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "semitones": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "key_shift",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "semitones"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "jog_touch",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Platter rotation while touched (vinyl mode): scratch by `delta` encoder ticks.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "jog_scratch",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Wheel side / untouched rotation: temporary pitch bend.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "jog_bend",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "SHIFT + rotation: fast search / skip.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "jog_search",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "vinyl_mode",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "loop_in",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "loop_out",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "beats": {
              "format": "float",
              "type": "number"
            },
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "auto_loop",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "beats"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loop_exit",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "beats": {
              "format": "float",
              "type": "number"
            },
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "loop_roll",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "beats"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loop_halve",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loop_double",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loop_active_toggle",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "hot_cue",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "hot_cue_delete",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "slot"
          ],
          "type": "object"
        },
        {
          "description": "Call the previous (-1) / next (+1) memory cue or loop.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "cue_call",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "direction"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "cue_memory_delete",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "cue_memory_save",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "beats": {
              "format": "float",
              "type": "number"
            },
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "beat_jump",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "beats"
          ],
          "type": "object"
        },
        {
          "description": "Jump by the deck's current beat-jump size, backwards (-1) / forwards (+1).",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "beat_jump_by_size",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "direction"
          ],
          "type": "object"
        },
        {
          "description": "Halve (-1) / double (+1) the beat-jump size.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "beat_jump_size",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "direction"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "mode": {
              "$ref": "#/$defs/PadMode"
            },
            "type": {
              "const": "pad_mode",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "mode"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "semitones": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "pitch_play",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "semitones"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "censor",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "reverse",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "description": "Rewind (-1) / fast-forward (+1) while held.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "seek",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "direction"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "load_previous",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        }
      ]
    },
    "DeckLayerDef": {
      "description": "A deck-switching layer: physical `side` targets one of `decks`; each press of `input`\nadvances to the next deck.",
      "properties": {
        "decks": {
          "items": {
            "format": "uint8",
            "maximum": 255,
            "minimum": 0,
            "type": "integer"
          },
          "type": "array"
        },
        "input": {
          "type": [
            "string",
            "null"
          ]
        },
        "side": {
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "side",
        "decks"
      ],
      "type": "object"
    },
    "DeviceMatch": {
      "description": "Device recognition rules. Every present rule that matches adds to the score.",
      "properties": {
        "fallback": {
          "description": "Match any device (fallback profiles). Scores lowest.",
          "type": "boolean"
        },
        "name_regex": {
          "description": "Regex matched against the OS port name (case-sensitive unless `(?i)` is used).",
          "type": [
            "string",
            "null"
          ]
        },
        "priority": {
          "default": 0,
          "description": "Tie-breaker between profiles matching the same device (higher wins).",
          "format": "int32",
          "type": "integer"
        },
        "sysex_identity": {
          "anyOf": [
            {
              "$ref": "#/$defs/IdentityMatch"
            },
            {
              "type": "null"
            }
          ],
          "description": "Match on the MIDI Universal Identity Reply (`F0 7E dd 06 02 ...`)."
        },
        "usb": {
          "description": "USB vendor / product ids (product `null` = any product of the vendor).",
          "items": {
            "$ref": "#/$defs/UsbId"
          },
          "type": "array"
        }
      },
      "type": "object"
    },
    "EqBand": {
      "enum": [
        "low",
        "mid",
        "high"
      ],
      "type": "string"
    },
    "FeedbackKey": {
      "description": "Engine state a feedback output reflects. `deck` / `slot` / `unit` are 0-based.",
      "oneOf": [
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "playing",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "cue_indicator",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "sync",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loop_active",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "hot_cue_set",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "slot"
          ],
          "type": "object"
        },
        {
          "description": "Colour index (0..=127) of a hot cue.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "hot_cue_colour",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "mode": {
              "$ref": "#/$defs/PadMode"
            },
            "type": {
              "const": "pad_mode",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "mode"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "vinyl_mode",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "loaded",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "channel_cue",
              "type": "string"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "description": "Channel level meter 0..1.",
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "vu",
              "type": "string"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "description": "Jog ring position 0..1 (one platter revolution).",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "jog_position",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "fx_on",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit"
          ],
          "type": "object"
        },
        {
          "properties": {
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "sampler_loaded",
              "type": "string"
            }
          },
          "required": [
            "type",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "sampler_playing",
              "type": "string"
            }
          },
          "required": [
            "type",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "master_cue",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Host-defined key.",
          "properties": {
            "name": {
              "type": "string"
            },
            "type": {
              "const": "custom",
              "type": "string"
            }
          },
          "required": [
            "type",
            "name"
          ],
          "type": "object"
        }
      ]
    },
    "FxAction": {
      "description": "Effect actions. `unit` is the 0-based FX unit.",
      "oneOf": [
        {
          "properties": {
            "type": {
              "const": "toggle",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit"
          ],
          "type": "object"
        },
        {
          "properties": {
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "select",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit",
            "direction"
          ],
          "type": "object"
        },
        {
          "description": "Beat multiplier down (-1) / up (+1).",
          "properties": {
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "beats",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit",
            "direction"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "level",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "unit"
          ],
          "type": "object"
        },
        {
          "properties": {
            "index": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "param",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "unit",
            "index"
          ],
          "type": "object"
        },
        {
          "description": "Route `unit` to mixer `channel` (`on` follows the switch position).",
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "on": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "assign",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit",
            "channel"
          ],
          "type": "object"
        },
        {
          "description": "Momentary pad FX `slot` on `page` for `deck`.",
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "page": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "pad_fx",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck",
            "page",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "tap_tempo",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "tap_reset",
              "type": "string"
            },
            "unit": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            }
          },
          "required": [
            "type",
            "unit"
          ],
          "type": "object"
        }
      ]
    },
    "GrooveConfig": {
      "description": "Groove-lane recording.",
      "properties": {
        "bars": {
          "default": 4,
          "description": "Pattern length in bars.",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        },
        "channels": {
          "description": "1-based channels whose notes are recorded.",
          "items": {
            "format": "uint8",
            "maximum": 255,
            "minimum": 0,
            "type": "integer"
          },
          "type": "array"
        },
        "quantize_ticks": {
          "default": 24,
          "description": "Quantisation step in ticks at 96 PPQ (24 = 16th note).",
          "format": "uint32",
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "channels"
      ],
      "type": "object"
    },
    "IdentityMatch": {
      "description": "Universal Identity Reply match: manufacturer id (1 or 3 bytes), optional family / member.",
      "properties": {
        "family": {
          "format": "uint16",
          "maximum": 65535,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "manufacturer": {
          "items": {
            "format": "uint8",
            "maximum": 255,
            "minimum": 0,
            "type": "integer"
          },
          "type": "array"
        },
        "member": {
          "format": "uint16",
          "maximum": 65535,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        }
      },
      "required": [
        "manufacturer"
      ],
      "type": "object"
    },
    "InputDef": {
      "description": "One physical control.",
      "oneOf": [
        {
          "description": "Note on/off button or pad (value = velocity / 127, pressed = velocity > 0).",
          "properties": {
            "note": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "note",
              "type": "string"
            }
          },
          "required": [
            "type",
            "note"
          ],
          "type": "object"
        },
        {
          "description": "Range of notes (keyboards); the note number is passed to the action.",
          "properties": {
            "first": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "last": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "note_range",
              "type": "string"
            }
          },
          "required": [
            "type",
            "first",
            "last"
          ],
          "type": "object"
        },
        {
          "description": "7-bit control change. `relative` = endless encoder.",
          "properties": {
            "cc": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "relative": {
              "anyOf": [
                {
                  "$ref": "#/$defs/RelativeEncoding"
                },
                {
                  "type": "null"
                }
              ]
            },
            "type": {
              "const": "cc",
              "type": "string"
            }
          },
          "required": [
            "type",
            "cc"
          ],
          "type": "object"
        },
        {
          "description": "14-bit control change pair; emitted when the LSB arrives (MSB first, as MIDI 1.0 says).",
          "properties": {
            "lsb": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "msb": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "cc14",
              "type": "string"
            }
          },
          "required": [
            "type",
            "msb",
            "lsb"
          ],
          "type": "object"
        },
        {
          "description": "Relative jog wheel. Bindings with `jog_scratch` become `jog_bend` while untouched.",
          "properties": {
            "cc": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "encoding": {
              "$ref": "#/$defs/RelativeEncoding"
            },
            "type": {
              "const": "jog",
              "type": "string"
            }
          },
          "required": [
            "type",
            "cc",
            "encoding"
          ],
          "type": "object"
        },
        {
          "description": "NRPN (CC 99/98 select, CC 6/38 data). `high_res` waits for the data LSB.",
          "properties": {
            "high_res": {
              "type": "boolean"
            },
            "param": {
              "format": "uint16",
              "maximum": 65535,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "nrpn",
              "type": "string"
            }
          },
          "required": [
            "type",
            "param"
          ],
          "type": "object"
        },
        {
          "description": "14-bit pitch bend.",
          "properties": {
            "type": {
              "const": "pitch_bend",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Programme change within `first..=last`; `program - first` fills the action index.",
          "properties": {
            "first": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "last": {
              "default": 127,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "program_change",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "SysEx matched against a hex pattern with `??` wildcards, e.g. `\"F0 00 20 29 ?? F7\"`.",
          "properties": {
            "pattern": {
              "type": "string"
            },
            "type": {
              "const": "sysex",
              "type": "string"
            }
          },
          "required": [
            "type",
            "pattern"
          ],
          "type": "object"
        }
      ],
      "properties": {
        "channel": {
          "description": "1-based MIDI channel; absent = any channel.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "id": {
          "description": "Unique id within the mapping, e.g. `deck1.play`.",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "LibraryAction": {
      "oneOf": [
        {
          "properties": {
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "scroll",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "scroll_fast",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "focus_next",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "focus_previous",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "deck": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "load",
              "type": "string"
            }
          },
          "required": [
            "type",
            "deck"
          ],
          "type": "object"
        },
        {
          "properties": {
            "column": {
              "$ref": "#/$defs/SortColumn"
            },
            "type": {
              "const": "sort",
              "type": "string"
            }
          },
          "required": [
            "type",
            "column"
          ],
          "type": "object"
        },
        {
          "properties": {
            "delta": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            },
            "type": {
              "const": "zoom_waveform",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        }
      ]
    },
    "MixerAction": {
      "description": "Mixer section actions. `channel` is the 0-based mixer channel.",
      "oneOf": [
        {
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "volume",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "trim",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "properties": {
            "band": {
              "$ref": "#/$defs/EqBand"
            },
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "eq",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "channel",
            "band"
          ],
          "type": "object"
        },
        {
          "description": "Per-channel colour FX / filter, 0.5 = off.",
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "filter",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "crossfader",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "master_volume",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Master filter, 0.5 = off (Circuit Tracks project CC74).",
          "properties": {
            "type": {
              "const": "master_filter",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "master_filter_resonance",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Send level of a channel into a bus (0 = reverb, 1 = delay).",
          "properties": {
            "bus": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "send",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "channel",
            "bus"
          ],
          "type": "object"
        },
        {
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "headphone_cue",
              "type": "string"
            }
          },
          "required": [
            "type",
            "channel"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "master_cue",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "headphone_mix",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "headphone_level",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "mic_level",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "smart_fader",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "smart_cfx",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Channel-fader start: `start` = fader left the bottom (true) or returned (false).",
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "start": {
              "type": "boolean"
            },
            "type": {
              "const": "fader_start",
              "type": "string"
            }
          },
          "required": [
            "type",
            "channel",
            "start"
          ],
          "type": "object"
        },
        {
          "description": "Crossfader start for `channel` (0 = left side deck, 1 = right side deck).",
          "properties": {
            "channel": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "start": {
              "type": "boolean"
            },
            "type": {
              "const": "crossfader_start",
              "type": "string"
            }
          },
          "required": [
            "type",
            "channel",
            "start"
          ],
          "type": "object"
        }
      ]
    },
    "ModifierDef": {
      "description": "A modifier (shift) — held by an input or set by the host (virtual modifier).",
      "properties": {
        "id": {
          "type": "string"
        },
        "input": {
          "description": "Input that drives the modifier; absent = virtual (host calls `set_modifier`).",
          "type": [
            "string",
            "null"
          ]
        },
        "toggle": {
          "description": "`true` = each press toggles; `false` = held while pressed.",
          "type": "boolean"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "OutMessage": {
      "description": "Which MIDI message an output sends.",
      "enum": [
        "note",
        "cc"
      ],
      "type": "string"
    },
    "OutputDef": {
      "description": "LED / meter output.",
      "oneOf": [
        {
          "description": "On / off LED.",
          "properties": {
            "off": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "on": {
              "default": 127,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "led",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Colour LED: the state's colour index is sent as velocity / value, `off` when unset.",
          "properties": {
            "off": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "colour",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "description": "Meter / ring: level 0..1 scaled to `min..=max`.",
          "properties": {
            "max": {
              "default": 127,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "min": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "meter",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        }
      ],
      "properties": {
        "channel": {
          "description": "1-based channel.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": "integer"
        },
        "id": {
          "type": "string"
        },
        "message": {
          "$ref": "#/$defs/OutMessage"
        },
        "number": {
          "description": "Note or CC number.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": "integer"
        },
        "side": {
          "description": "Physical side: the source's deck is replaced by the side's current deck layer.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "source": {
          "$ref": "#/$defs/FeedbackKey"
        }
      },
      "required": [
        "id",
        "channel",
        "message",
        "number",
        "source"
      ],
      "type": "object"
    },
    "PadMode": {
      "description": "Performance-pad modes (names cover both rekordbox and Serato layouts).",
      "enum": [
        "hot_cue",
        "pad_fx1",
        "pad_fx2",
        "beat_jump",
        "beat_loop",
        "sampler",
        "keyboard",
        "key_shift",
        "pitch_play",
        "roll",
        "auto_loop"
      ],
      "type": "string"
    },
    "RelativeEncoding": {
      "description": "Encoding of relative (endless) encoders and jog wheels on a 7-bit value.",
      "oneOf": [
        {
          "const": "twos_complement",
          "description": "1..=63 = +1..+63, 65..=127 = -63..-1 (`0x7F` = -1). Pioneer browse knobs use this.",
          "type": "string"
        },
        {
          "const": "sign_magnitude",
          "description": "Bit 6 = sign (set = negative), bits 0..5 = magnitude (`0x41` = -1).",
          "type": "string"
        },
        {
          "const": "offset64",
          "description": "64 = no movement; `value - 64` is the delta (`0x41` = +1, `0x3F` = -1). Pioneer jogs.",
          "type": "string"
        }
      ]
    },
    "SamplerAction": {
      "oneOf": [
        {
          "properties": {
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "trigger",
              "type": "string"
            },
            "velocity": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "slot"
          ],
          "type": "object"
        },
        {
          "properties": {
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "stop",
              "type": "string"
            }
          },
          "required": [
            "type",
            "slot"
          ],
          "type": "object"
        },
        {
          "description": "Load the selected library track into `slot` (SHIFT + pad).",
          "properties": {
            "slot": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "type": {
              "const": "load",
              "type": "string"
            }
          },
          "required": [
            "type",
            "slot"
          ],
          "type": "object"
        },
        {
          "description": "Play `note` on a pitched instrument (scale lock is applied by the engine first).",
          "properties": {
            "instrument": {
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "note": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "pressed": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "note",
              "type": "string"
            },
            "velocity": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type",
            "instrument"
          ],
          "type": "object"
        },
        {
          "properties": {
            "type": {
              "const": "volume",
              "type": "string"
            },
            "value": {
              "default": 0.0,
              "format": "float",
              "type": "number"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        },
        {
          "properties": {
            "direction": {
              "format": "int8",
              "maximum": 127,
              "minimum": -128,
              "type": "integer"
            },
            "type": {
              "const": "bank",
              "type": "string"
            }
          },
          "required": [
            "type",
            "direction"
          ],
          "type": "object"
        },
        {
          "description": "Select a groove pattern / project (Circuit Tracks programme change on channel 16).",
          "properties": {
            "index": {
              "default": 0,
              "format": "uint8",
              "maximum": 255,
              "minimum": 0,
              "type": "integer"
            },
            "queued": {
              "default": false,
              "type": "boolean"
            },
            "type": {
              "const": "select_pattern",
              "type": "string"
            }
          },
          "required": [
            "type"
          ],
          "type": "object"
        }
      ]
    },
    "ScaleLockDef": {
      "description": "Scale lock for note actions.",
      "properties": {
        "follow_track_key": {
          "default": true,
          "description": "Use the loaded track's key set by the host (`set_track_key`).",
          "type": "boolean"
        },
        "key": {
          "default": 0,
          "description": "Fixed key pitch class (0 = C) when not following / no track key.",
          "format": "uint8",
          "maximum": 255,
          "minimum": 0,
          "type": "integer"
        },
        "mode": {
          "$ref": "#/$defs/ScaleMode",
          "default": "major"
        }
      },
      "type": "object"
    },
    "ScaleMode": {
      "description": "Scale modes supported by the scale lock.",
      "oneOf": [
        {
          "enum": [
            "major",
            "harmonic_minor",
            "dorian",
            "phrygian",
            "lydian",
            "mixolydian",
            "major_pentatonic",
            "minor_pentatonic",
            "blues",
            "chromatic"
          ],
          "type": "string"
        },
        {
          "const": "minor",
          "description": "Natural minor (Aeolian).",
          "type": "string"
        }
      ]
    },
    "ScriptDef": {
      "description": "Sandboxed rhai script.",
      "properties": {
        "max_millis": {
          "description": "Wall-time budget per call in milliseconds (default 5).",
          "format": "uint64",
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "max_operations": {
          "description": "Operation budget per call (default 100 000).",
          "format": "uint64",
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "source": {
          "description": "Script source; may define `init()`, `on_midi(ev)`.",
          "type": "string"
        }
      },
      "required": [
        "source"
      ],
      "type": "object"
    },
    "SortColumn": {
      "enum": [
        "bpm",
        "artist",
        "title",
        "key"
      ],
      "type": "string"
    },
    "Trigger": {
      "description": "When a binding fires on a button.",
      "oneOf": [
        {
          "enum": [
            "press",
            "release",
            "both"
          ],
          "type": "string"
        },
        {
          "const": "auto",
          "description": "Momentary actions on press + release, other actions on press, continuous always.",
          "type": "string"
        }
      ]
    },
    "UsbId": {
      "properties": {
        "product_id": {
          "format": "uint16",
          "maximum": 65535,
          "minimum": 0,
          "type": [
            "integer",
            "null"
          ]
        },
        "vendor_id": {
          "format": "uint16",
          "maximum": 65535,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "vendor_id"
      ],
      "type": "object"
    },
    "ValueTransform": {
      "description": "How a continuous input value is turned into the action value.",
      "properties": {
        "curve": {
          "$ref": "#/$defs/Curve",
          "default": "linear"
        },
        "invert": {
          "default": false,
          "description": "Flip the input (`1 - x`) before the curve.",
          "type": "boolean"
        },
        "range": {
          "default": [
            0.0,
            1.0
          ],
          "description": "Output range `[min, max]` the curved value is mapped to.",
          "items": {
            "format": "float",
            "type": "number"
          },
          "maxItems": 2,
          "minItems": 2,
          "type": "array"
        },
        "scale": {
          "default": 1.0,
          "description": "Multiplier for relative deltas (encoders, jogs).",
          "format": "float",
          "type": "number"
        }
      },
      "type": "object"
    }
  },
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "A complete controller mapping.",
  "properties": {
    "bindings": {
      "default": [],
      "description": "Input → action bindings.",
      "items": {
        "$ref": "#/$defs/Binding"
      },
      "type": "array"
    },
    "clock": {
      "anyOf": [
        {
          "$ref": "#/$defs/ClockConfig"
        },
        {
          "type": "null"
        }
      ],
      "description": "MIDI clock behaviour."
    },
    "deck_layers": {
      "description": "Deck-switching layers (a physical side controls one of several virtual decks).",
      "items": {
        "$ref": "#/$defs/DeckLayerDef"
      },
      "type": "array"
    },
    "description": {
      "type": [
        "string",
        "null"
      ]
    },
    "device": {
      "$ref": "#/$defs/DeviceMatch",
      "default": {
        "priority": 0
      },
      "description": "How to recognise the device."
    },
    "groove": {
      "anyOf": [
        {
          "$ref": "#/$defs/GrooveConfig"
        },
        {
          "type": "null"
        }
      ],
      "description": "Groove-lane recording of incoming notes."
    },
    "id": {
      "description": "Stable identifier, e.g. `pioneer-ddj-flx4-rekordbox`.",
      "type": "string"
    },
    "inputs": {
      "default": [],
      "description": "Physical controls (MIDI in).",
      "items": {
        "$ref": "#/$defs/InputDef"
      },
      "type": "array"
    },
    "modifiers": {
      "description": "Modifier (shift) layers.",
      "items": {
        "$ref": "#/$defs/ModifierDef"
      },
      "type": "array"
    },
    "name": {
      "description": "Human-readable name.",
      "type": "string"
    },
    "outputs": {
      "description": "LED / meter feedback (MIDI out).",
      "items": {
        "$ref": "#/$defs/OutputDef"
      },
      "type": "array"
    },
    "script": {
      "anyOf": [
        {
          "$ref": "#/$defs/ScriptDef"
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional sandboxed rhai script."
    },
    "sources": {
      "description": "URLs of the manufacturer documents the mapping was derived from.",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "vendor": {
      "type": [
        "string",
        "null"
      ]
    },
    "version": {
      "default": 1,
      "description": "Format version; must be 1.",
      "format": "uint32",
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "id",
    "name"
  ],
  "title": "MappingFile",
  "type": "object"
}
```

<!-- END GENERATED SCHEMA -->
