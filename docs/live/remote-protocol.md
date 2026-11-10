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
| UDP OSC (port `ws_port + 1`) | Low-latency faders/buttons (same token as first OSC arg is NOT required: OSC is LAN-only and gated by the paired client's source address) |
| mDNS `_mixai-live._tcp.local.` | Discovery; TXT `v=1`, `name=<engine name>`, `port`, `osc` |

Default port **17920** (WS/HTTP), **17921** (OSC). Bind `0.0.0.0` only when LAN control is enabled; the
desktop UI uses `127.0.0.1` with the `controller` token from the local config file.

## Auth and roles

Pairing is by QR code: `mixai-live://pair?host=<ip>&port=17920&t=<token>&name=<engine>` (also printed as an
`http://<ip>:17920/?t=<token>` link for the web remote). Tokens are 128-bit random hex, compared in constant
time, rotatable. Roles:

| Role | May |
|---|---|
| `controller` | everything |
| `performer` | scenes/setlist navigation, mix (input/main/monitor/monitor_dry), bypass, mute, tap tempo, tuner view |
| `viewer` | read state + meters only |

Limits: 32 clients, 16 KiB per message, 200 messages/s per client (excess dropped with an `error`), cross-origin
WebSocket upgrades refused unless the `Origin` matches the engine host.

## Messages

Every message is `{"type": "...", ...}`. Client messages may carry `"id": <u32>`; the server echoes it in the
matching `ack` or `error`.

### Server → client

| type | fields | when |
|---|---|---|
| `hello` | `protocol: 1, version, role, engine_name, sample_rate, buffer_frames, devices: RunningInfo` | after connect |
| `state` | `state: SessionState` | after `hello`, and after every change (debounced 30 ms) |
| `meters` | `in_peak, in_rms, out_peak:[l,r], out_rms:[l,r], gr:[dB per insert], dsp_load, dsp_load_max, xruns, clipped, tune: {freq, midi, cents, target, correction_cents} \| null, latency_probe: "idle"\|"running"\|{"done_ms":x}\|"failed"` | 30 Hz to clients that sent `subscribe` with `meters:true` (watches: 10 Hz with `meters_hz`) |
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
| `set_mix` | any of `input_db, main_db, monitor_db, monitor_dry, bypass, mute` | performer |
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

## OSC address space

`/live/mix/{input,main,monitor}` f (dB) · `/live/mix/monitor_dry` f (0..1) · `/live/bypass` i ·
`/live/mute` i · `/live/scene/next` · `/live/scene/prev` · `/live/goto` i i · `/live/tap` ·
`/live/fx/<insert>/<param>` f (value) · `/live/fx/<insert>/enabled` i · `/live/panic`.

## Versioning

`protocol` is bumped only for breaking changes; unknown message types and unknown fields are ignored by both
sides (forward compatible). Clients show "update the app" when `protocol` is higher than they support.
