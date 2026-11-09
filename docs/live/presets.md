# MixAI Live — presets, songs and setlists (JSON format v1)

Implemented in `apps/live/engine/crates/live-engine/src/preset.rs` (serde). The same JSON travels over the
[remote protocol](remote-protocol.md) (`load_setlist`, `state.setlist`) and is printed by
`mixai-live-engine presets` ([CLI](cli.md)).

## Preset

A preset is an ordered effect chain.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `version` | integer | no | `1` | Format version. Higher than `1` is rejected (`unsupported preset format version N`) |
| `name` | string | yes | — | Unique within the engine; setlists reference presets **by name** |
| `description` | string | no | `""` | |
| `tags` | string[] | no | `[]` | |
| `chain` | `InsertSpec[]` | yes | — | At most 32 entries (`too many inserts`) |

### InsertSpec

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `fx` | string | yes | — | Effect id from [effects.md](effects.md); unknown ids fail the build (`unknown effect`) |
| `enabled` | bool | no | `true` | Disabled inserts stay in the chain, bypassed at zero cost |
| `params` | object `{param id: number}` | no | `{}` | Missing ids keep their defaults; unknown ids are **warnings**, not errors |

Rules applied when a preset is built (control thread):

- Values are clamped to the parameter range; `choice` and `on/off` values are rounded (see
  [effects.md](effects.md#common-behaviour)).
- Parameters set at build time do not ramp in from the defaults (the effect state is reset after applying them).
- Insert ids are assigned by the engine at load time (they are not part of the file); clients address inserts
  by these runtime ids (`state.chain[].id`).
- "Save preset" (`save_preset` control) captures the live chain with **every** parameter written out and
  replaces a preset with the same name.

```json
{
  "version": 1,
  "name": "Warm Lead",
  "description": "Gentle tuning, plate-ish reverb.",
  "tags": ["pop", "live"],
  "chain": [
    { "fx": "gate", "params": { "threshold": -52, "range": -18 } },
    { "fx": "eq", "params": { "hpf_freq": 95, "mid2_freq": 3200, "mid2_gain": 2.5 } },
    { "fx": "deesser" },
    { "fx": "compressor", "params": { "threshold": -21, "ratio": 3.5, "attack": 6 } },
    { "fx": "autotune", "params": { "retune": 70, "humanize": 0.6, "amount": 0.6 } },
    { "fx": "delay", "enabled": false, "params": { "sync": 6, "mix": 0.12 } },
    { "fx": "reverb", "params": { "decay": 1.6, "mix": 0.14 } },
    { "fx": "limiter", "params": { "ceiling": -1 } }
  ]
}
```

`choice` parameters take the index (`"sync": 6` = `1/8d`; `"key": 9` = `A`; `"scale": 2` = `minor`).

## Song and SongPart

| Song field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `title` | string | yes | — | |
| `artist` | string | no | `""` | |
| `key` | string \| null | no | `null` | Applied to every `autotune` and `harmonizer` insert on recall ([key strings](#key-strings)) |
| `bpm` | number \| null | no | `null` | Applied to the `bpm` of every `delay` insert on recall |
| `parts` | `SongPart[]` | yes | — | |
| `lyrics` | string \| null | no | `null` | Stored for clients; the teleprompter is planned (WP21-13) |
| `notes` | string | no | `""` | |

| SongPart field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `name` | string | yes | — | "Verse", "Chorus"… |
| `preset` | string | yes | — | Preset **name**; an unknown name fails the recall with `unknown_preset` |
| `program` | integer 0–255 \| null | no | `null` | Reserved for MIDI program / foot-switch recall — MIDI input is planned (WP21-04) |

## Setlist

| Field | Type | Required | Default |
|---|---|---|---|
| `version` | integer | no | `1` |
| `name` | string | yes | — |
| `songs` | `Song[]` | yes | — |

```json
{
  "version": 1,
  "name": "Friday gig",
  "songs": [
    {
      "title": "Opener",
      "key": "A minor",
      "bpm": 96,
      "parts": [
        { "name": "Verse", "preset": "Natural Vocal" },
        { "name": "Chorus", "preset": "Pop Polish", "program": 2 }
      ]
    },
    {
      "title": "Slow one",
      "artist": "Band",
      "key": "Eb major",
      "bpm": 68,
      "parts": [{ "name": "All", "preset": "Ballad Hall" }],
      "notes": "Capo 1"
    }
  ]
}
```

Navigation (`goto {song, part}`, `next`, `prev`): `next` goes to the next part, then to the first part of the
next song, and stays on the last part at the end; `prev` mirrors it. With no position yet, both go to song 0,
part 0. Recall = load the part's preset (click-free swap with tail spill), then apply the song key and BPM.

## Key strings

`parse_key` accepts a note letter `A`–`G` (case-insensitive), an optional `#` or `b`, and an optional mode:

| Input | Key index | Scale |
|---|---|---|
| `"A minor"` | 9 (`A`) | `minor` |
| `"F# major"` | 6 (`F#`) | `major` |
| `"Bb"` | 10 (`A#`) | `major` (default) |
| `"c# min"` | 1 (`C#`) | `minor` |
| `"Am"` / `"A m"` | 9 | `minor` (`m` alone, or any mode starting with `min`) |
| `"H"` | — | not recognised: the song key is ignored |

Only `major` and `minor` are produced from strings; other scales (dorian, blues…) are set on the insert itself.

## Factory presets

Shipped by `factory()` and always loaded. Names are stable ids for setlists.

| Name | Tags | Chain |
|---|---|---|
| Natural Vocal | natural, live | gate › eq › deesser › compressor › reverb › limiter |
| Pop Polish | pop, tune | eq › deesser › compressor › autotune › doubler › delay › reverb › limiter |
| Hard Tune | tune, fx | eq › compressor › autotune (retune 0.5 ms) › delay › reverb › limiter |
| Harmony Stack | harmony | eq › compressor › autotune › harmonizer (3rd above, 4th below) › reverb › limiter |
| Rock Grit | rock | gate › eq › compressor › saturator › delay (110 ms slap) › limiter |
| Ballad Hall | ballad | eq › deesser › compressor › chorus › delay › reverb (4 s) › limiter |
| Speech / MC | speech | gate › eq › deesser › compressor (auto make-up) › limiter |

Exact values: `mixai-live-engine presets`. A test (`every_factory_preset_builds_without_warnings`) builds every
factory preset, checks it has no unknown parameters and round-trips it through JSON.

## Storage

User presets created with `save_preset` live in the engine session (memory) for now; persistence to disk, a
JSON Schema file and import/export in the desktop app are planned (WP21-04, WP21-07).
