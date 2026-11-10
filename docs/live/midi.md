# MixAI Live — MIDI control

Foot switches, expression pedals, keyboards and controllers drive the engine through MIDI. `mixai-live-engine serve`
opens **every** MIDI input port at start (`--no-midi` disables it; `mixai-live-engine midi-ports` lists them).
Bluetooth LE MIDI pedals need nothing special: pair them in the OS (Windows MIDI Services / Bluetooth settings,
macOS Audio MIDI Setup, BlueZ on Linux) and they appear as ordinary ports. A port another app holds exclusively
(WinMM) is skipped with a note on stderr. Clock, active sensing and SysEx are ignored.

The logic is pure Rust in `live-engine` (`midi.rs`): the binary only forwards raw bytes, so the desktop app, the
FFI and tests share it. Open ports, the learn target and the last message seen are in `state.midi`
([remote protocol](remote-protocol.md)).

## Messages understood

| Message | Use |
|---|---|
| Control change (CC) | continuous value 0–127 → parameter / mix fader; ≥ 64 → on, < 64 → off for insert toggles; an upward crossing of 64 fires an action once (momentary foot switches send 127 then 0) |
| Note on | action trigger, insert toggle, or velocity → value |
| Note off / note on velocity 0 | ignored (except that learn never binds on it) |
| Program change | recalls the song part whose `program` equals the number ([presets](presets.md#song-and-songpart)), searched from the current song onwards so numbers may repeat across songs; off with `program_change: false` |

## Bindings (`MidiMap`, persisted as `midi.json`)

```json
{
  "bindings": [
    { "source": { "kind": "cc", "channel": 0, "number": 80 }, "target": { "kind": "action", "action": "next" } },
    { "source": { "kind": "cc", "channel": 0, "number": 4 }, "target": { "kind": "param", "fx": "reverb", "param": "mix" } },
    { "source": { "kind": "note", "channel": 9, "number": 36 }, "target": { "kind": "action", "action": "panic" } }
  ],
  "program_change": true,
  "channel": null
}
```

| Field | Type | Meaning |
|---|---|---|
| `source.kind` | `cc` \| `note` | message kind |
| `source.channel` | 0–15 \| null | MIDI channel (0-based; null = any) |
| `source.number` | 0–127 | controller or note number |
| `program_change` | bool (default true) | program change recalls song parts |
| `channel` | 0–15 \| null | listen only to this channel (null = omni) |

`MidiTarget` (`kind` tag):

| `kind` | Fields | Effect |
|---|---|---|
| `param` | `fx, param` | sets the parameter of the **first insert of that effect kind** (normalised 0–1 → its range, see [effects](effects.md)). Addressing by kind keeps the binding working when a song part loads another preset; in a chain without that effect it does nothing |
| `enable` | `fx` | CC: on/off at 64; note: toggles |
| `mix` | `field`: `input_db` \| `main_db` \| `monitor_db` \| `monitor_dry` | faders map 0–127 to −60…+12 dB (unity ≈ CC 106); `monitor_dry` maps to 0–1 |
| `action` | `action`: `next` \| `prev` \| `tap_tempo` \| `panic` \| `toggle_bypass` \| `toggle_mute` | one shot |

## MIDI learn

1. Send `{"type":"midi_learn","target":{…}}` (controller role) — the desktop app and the phone chain screen do this
   from a long-press on any control.
2. Move the pedal / press the switch. The first CC or note on binds to the target; a binding on the same source is
   replaced, so re-learning never stacks. When a channel filter is set the binding uses that channel, otherwise the
   channel the message came on.
3. `{"type":"midi_learn","target":null}` cancels; `midi_unbind {index}` removes a binding;
   `midi_settings {program_change?, channel?: 0 (omni) | 1..16}` changes the settings.

Every change is written to `midi.json` immediately (atomic `.tmp` + rename) and restored on the next start.

## Latency

Messages go from the midir callback through a bounded channel (1024 messages, dropped rather than blocking the
driver) to the control loop, which polls every few milliseconds; parameter changes then ride the lock-free command
ring and are smoothed on the audio thread, so a pedal sweep never clicks. Typical pedal → audible change is under
10 ms plus the audio buffer.
