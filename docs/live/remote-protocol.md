# MixAI Live — control protocol v1

One protocol for every controller: the desktop UI (local), phones/tablets/watches (LAN) and the web remote
page. Implemented by `apps/live/engine/crates/live-remote` (server, inside `mixai-live-engine serve`).
State types are the serde forms of `live_engine::session::SessionState` / `MixState` / `InsertState`.

## Transport

| Channel | Use |
|---|---|
| HTTP `GET /` | Web remote page (RO/EN, design tokens), served by the engine |
| HTTP `GET /health` | `{"ok":true,"protocol":1,"version":"x.y.z"}` (no auth) |
| HTTP `GET /api/fx` | Effect catalogue: `[{id, params:[{id,min,max,default,unit,curve,choices}]}]` |
| WebSocket `GET /ws?t=<token>&c=<client-id>` | JSON text frames, one message per frame |
| UDP OSC (port `ws_port + 1`) | Low-latency faders/buttons. **Off by default** (`serve --osc`). Every address starts with an OSC key (`/<key>/live/...`); the sender's address grants nothing, loopback included |
| mDNS `_mixai-live._tcp.local.` | Discovery; TXT `v=1`, `name=<engine name>`, `port`, `osc` |

Default port **17920** (WS/HTTP), **17921** (OSC, only when enabled). Bind `0.0.0.0` only when LAN control is enabled; the
desktop UI uses `127.0.0.1` with the `controller` token from the local config file.

## Auth and roles

Pairing is by QR code: `mixai-live://pair?host=<ip>&port=17920&t=<token>&name=<engine>` (also printed as an
`http://<ip>:17920/?t=<token>` link for the web remote). Tokens are 128-bit random hex, compared in constant
time, rotatable. Roles:

| Role | May |
|---|---|
| `controller` | everything |
| `performer` | scenes/setlist navigation, mix (input/main/monitor/monitor_dry/monitor_untuned), bypass, mute, tap tempo, tuner view |
| `viewer` | read state + meters only |

Limits: 32 clients, 16 KiB per message, 200 messages/s per client (excess dropped with an `error`), cross-origin
WebSocket upgrades refused unless the `Origin` matches the engine host.

## Messages

Every message is `{"type": "...", ...}`. Client messages may carry `"id": <u32>`; the server echoes it in the
matching `ack` or `error`.

### Server → client

| type | fields | when |
|---|---|---|
| `hello` | `protocol: 1, version, role, engine_name, sample_rate, buffer_frames, devices: RunningInfo`, and when OSC is on, for `performer` and `controller` only: `osc: { port, performer_key, controller_key? }` | after connect |
| `state` | `state: SessionState` | after `hello`, and after every change (debounced 30 ms) |
| `meters` | `in_peak, in_rms, out_peak:[l,r], out_rms:[l,r], gr:[dB per insert], dsp_load, dsp_load_max, xruns, clipped, safety_gr:[main dB, monitor dB], chain_latency_samples, monitor_chain_latency_samples, tune: {freq, midi, cents, target, correction_cents} \| null, latency_probe: "idle"\|"running"\|{"done_ms":x}\|"failed"` | 30 Hz to clients that sent `subscribe` with `meters:true` (watches: 10 Hz with `meters_hz`) |
| `ack` | `id` | command applied |
| `error` | `id?, code, message` | codes: `unauthorized`, `forbidden`, `bad_request`, `unknown_insert`, `unknown_param`, `unknown_preset`, `unknown_fx`, `chain_full`, `no_setlist`, `factory_preset`, `unknown_binding`, `rate_limited` |

`SessionState` (additive since engine 0.1.0+midi): `preset, chain, mix, setlist, position, presets, factory_presets, modified_presets` (factory presets overridden by a user copy — only these can be reverted),
bpm, midi: { map: MidiMap, learning: MidiTarget | null, ports: [string], last: string | null }, revision`. The MIDI
types are described in [MIDI control](midi.md).

### Client → server

| type | fields | role |
|---|---|---|
| `subscribe` | `meters: bool, meters_hz?: 1..30` | viewer |
| `set_param` | `insert: u32, param: string, value: f32` | controller |
| `set_param_norm` | `insert, param, norm: 0..1` (uses the param curve) | controller |
| `set_enabled` | `insert, on: bool` | controller |
| `add_insert` | `fx: string, at: u32` | controller |
| `remove_insert` | `insert` | controller |
| `move_insert` | `insert, to: u32` | controller |
| `load_preset` | `name` | performer |
| `save_preset` | `name` | controller |
| `delete_preset` | `name` (a modified factory preset reverts to factory; an unmodified one → `factory_preset`) | controller |
| `set_mix` | any of `input_db, main_db, monitor_db, monitor_dry, monitor_untuned, bypass, mute` | performer |
| `load_setlist` | `setlist: Setlist` | controller |
| `goto` | `song, part` | performer |
| `next` / `prev` | — | performer |
| `tap_tempo` | — (the server averages taps and sets every delay `bpm`) | performer |
| `panic` | — (mute + reset tails; `set_mix {mute:false}` to recover) | performer |
| `latency_probe` | — | controller |
| `midi_learn` | `target: MidiTarget \| null` (null cancels) — the next CC / note binds to it | controller |
| `midi_unbind` | `index` into `state.midi.map.bindings` | controller |
| `midi_settings` | any of `program_change: bool, channel: 0 (omni) \| 1..16` | controller |
| `ping` | `t` → server replies `{"type":"pong","t":…}` | viewer |

## Output safety

After the faders, each bus (main and monitor) ends in a safety stage that no control can remove, disable or
reorder: a zero-latency stereo limiter with an exact ceiling at **−1 dBFS**. `bypass`, the dry monitor blend and
the latency click pass through it too, and non-finite samples become silence. `meters.safety_gr` is its deepest
gain reduction since the previous `meters` message (dB ≥ 0, main then monitor); `meters.clipped` is true when
either value is above 0.1 dB, which means the signal after the faders was too hot, not that the output clipped.

`input_db`, `main_db` and `monitor_db` accept −60…+12 dB. A move **up** ramps over 300 ms, a move **down** over
10 ms.

## Tuned only for the audience (`monitor_untuned`)

`set_mix {monitor_untuned: true}` feeds the **monitor** bus from a second chain instead of the main one: the same
inserts, parameters, order and enabled flags, minus every pitch effect (`autotune`, `harmonizer`). The ears get
the voice without the shifter's latency (256 samples, 5.3 ms) plus everything else — EQ, compressor, de-esser,
reverb, delay — while the main bus (FOH, stream, recording) keeps the full chain with correction and harmonies,
sample for sample unchanged. `monitor_dry`, the monitor gain, `mute`, `bypass`, the latency click and the safety
stage keep working on the monitor bus exactly as before.

`meters.monitor_chain_latency_samples` is the chain latency the ears hear: equal to `chain_latency_samples` while
the option is off (there is no second chain then, and nothing extra is computed), the monitor chain's own figure
while it is on. Every later edit of the main chain — parameter, enable, add, remove, move, preset or scene load,
setlist navigation, MIDI, `reset` — reaches the monitor chain too; inserts are linked by id, so an operation on a
pitch insert simply does not apply there.

The option is not persisted: the engine starts with it off, so a client that wants it must send `set_mix` again
after every restart. Switching it on or off while singing crossfades the monitor bus over 10 ms, and a scene
change lets the old monitor chain ring out on the monitor bus just as the old main chain does on the main bus.

## OSC address space

OSC is off unless the engine was started with it (`serve --osc`, `HostConfig.osc`). Every address carries a key:

`/<key>/live/mix/{input,main,monitor}` f (dB) · `/<key>/live/mix/monitor_dry` f (0..1) ·
`/<key>/live/mix/monitor_untuned` i (0/1, no argument = 1) · `/<key>/live/bypass` i ·
`/<key>/live/mute` i · `/<key>/live/scene/next` · `/<key>/live/scene/prev` · `/<key>/live/goto` i i ·
`/<key>/live/tap` · `/<key>/live/fx/<insert>/<param>` f (value) · `/<key>/live/fx/<insert>/enabled` i ·
`/<key>/live/panic`.

- There are two keys, 32 hex characters each: `performer_key` (mix, scenes, tap, panic) and `controller_key`
  (also `/live/fx/...`). They are **not** the pairing tokens, because a control-surface layout that embeds a key
  is a file people export and share. Rotating a role's token replaces its OSC key.
- Keys are sent in `hello.osc` to performers (their own) and controllers (both), and printed in the `ready` line
  of `serve`. Viewers get none.
- A datagram without a valid key is dropped silently, whatever its source address. OSC has no replies.
- Limit: 400 accepted messages per second in total, counted after the key check (datagrams without a valid key
  do not use it up); `/live/panic` is never rate-limited. Two surfaces share the limit.
- OSC travels in clear text on the network, like the rest of protocol v1: use it on a network you control.

## Versioning

`protocol` is bumped only for breaking changes; unknown message types and unknown fields are ignored by both
sides (forward compatible). Clients show "update the app" when `protocol` is higher than they support.
