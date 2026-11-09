# Connected mode: phone remote, second screen, Party DJ (WP19-21)

Crate `apps/mixai/src-tauri/crates/decks-remote` (MIT OR Apache-2.0), exposed through `decks-ffi` as
`DecksRemote`, used by the Compose shells (`ConnectPanel`, status-bar **Connect** chip).

## What it does

The DJ turns **Connect** on. Decks opens a small LAN server and shows three QR codes:

| Role | Page | Can do |
|---|---|---|
| Phone remote (`controller`) | `/` | play/pause, CUE (hold), hot cues 1–4, loop 4, sync, channel volume, 3-band EQ, crossfader, master; moderate requests |
| Second screen (`viewer`) | `/` | read-only decks: title, BPM, key, time left, bar phase |
| Party guest (`guest`) | `/party` | see now playing, request songs, vote |

Phones need only a browser on the same Wi-Fi. The pages are served by the app itself (no cloud, no
install), follow the system language (RO / EN) and use the design tokens (`/tokens.css`, a byte copy of
`packages/design-tokens/dist/tokens.plain.css`, drift-tested by `tests/assets.rs`).

## Protocol

- HTTP/1.1: `GET /`, `/party`, `/tokens.css`, `/health`. Every response carries
  `Content-Security-Policy: default-src 'none'; …`, `X-Frame-Options: DENY`, `no-store`, `nosniff`,
  `Referrer-Policy: no-referrer`.
- WebSocket `GET /ws?t=<token>&c=<client-id>`; JSON messages, `type`-tagged.
  - in: `command` (controller), `request`, `vote`, `moderate` (controller), `ping`
  - out: `hello`, `state` (controller/viewer), `now_playing` (guest), `requests`, `requested`, `error`, `pong`
  - commands: `play`, `pause`, `cue{pressed}`, `hot_cue{slot}`, `loop_auto{beats}`, `loop_exit`,
    `beat_jump{beats}`, `sync{lock}`, `volume`, `eq{band,db}`, `filter`, `crossfader`, `master_volume`.
- `PROTOCOL_VERSION = 1` in `hello`.

## Security model

- One 128-bit random token per role (OS RNG), compared in constant time; the QR carries it.
  **New code** rotates a role's token and disconnects every device paired with the old one.
- `Origin` must be absent or equal to `Host` (other web pages cannot drive the decks through a
  visitor's browser).
- Validation before the engine: decks 0–3, hot cue 0–7, loop 1/32–64 beats, beat jump ±128, no NaN/∞,
  continuous controls clamped (volume 0–1, EQ −26…+6 dB, filter/crossfader −1…1).
- Limits: 48 clients, 16 KiB messages, 120 messages/s per client, 512 queued commands, 8 KiB request head.
- LAN only, plain HTTP: tokens are visible to anyone sniffing the same Wi-Fi. Use **New code** after a
  party; there is no remote access from the Internet.

## Party requests

`RequestQueue` (pure, unit-tested): dedup by normalised title + artist (case, punctuation and `feat.`
tails ignored) — a duplicate counts as a vote; one vote per client; max 3 open requests per client;
200 pending max (lowest-voted oldest dropped); control characters stripped; 120 chars per field.
Order: accepted → pending by votes → played → rejected. Guests never see notes, client ids or
rejected requests.

## App integration

```kotlin
val r = backend.startRemote()          // FfiRemote over DecksRemote.start(0, true)
r.pairing(RemoteRoleUi.GUEST)          // url + QR modules (draw with token colours, 4-module quiet zone)
r.pump()                               // every 4th frame: phone commands -> engine, engine snapshot -> phones
r.requests(); r.setRequestState(id, ACCEPTED)
```

`pump()` returns the mixer changes it applied so the shell moves its own knobs (`DecksController.applyRemoteMixer`).
Swift: the same `DecksRemote` object is in the generated `DecksFFI` bindings.

Android: `INTERNET` + `ACCESS_LOCAL_NETWORK` are declared. `ACCESS_LOCAL_NETWORK` becomes a runtime permission
once `targetSdk` reaches 37 (currently 36): the Connect toggle must request it then.

## Tests

- `cargo test -p decks-remote`: 19 unit (protocol validation, queue, tokens, QR, HTTP parsing), 3 asset
  (token drift, no literal colours, RO/EN key parity), 6 end-to-end on real loopback sockets (pages +
  headers, wrong token / foreign origin refused, controller commands validated and drained, state push,
  viewer/guest cannot control, full party flow, token rotation disconnects only that role).
- `cargo test -p decks-ffi --lib remote`: pairing/QR/lifecycle, pump against a stopped engine, mixer echo.
- `:decks-ui:desktopTest` `RemoteTest`: demo engine refuses, pairings + deck labels, phone mixer echo,
  moderation, party switch, shutdown.

## Not in this slice

Crate sync with MixAI Music and shared b2b crates (ADR-0014 "own LAN sync") need a library change feed in
`decks-library`; mDNS discovery is not needed while pairing is by QR. SwiftUI Connect view is pending
with the other SwiftUI work (built only on vmui-mac).
