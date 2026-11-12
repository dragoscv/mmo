# Connected mode: phone remote, second screen, Party DJ (WP19-21, desktop WP19-42)

Crate `apps/mixai/src-tauri/crates/decks-remote` (MIT OR Apache-2.0), exposed through `decks-ffi` as
`DecksRemote`, used by the Compose shells (`ConnectPanel`, status-bar **Connect** chip), and used directly by
the desktop app (`apps/mixai/src-tauri/src/remote.rs`, see [Decks desktop](#decks-desktop)).

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
  - out: `hello`, `state` (controller/viewer), `now_playing` (guest), `requests`, `requested`,
    `controls{locked}` (controller), `error`, `pong`
  - commands: `play`, `pause`, `cue{pressed}`, `hot_cue{slot}`, `loop_auto{beats}`, `loop_exit`,
    `beat_jump{beats}`, `sync{lock}`, `volume`, `eq{band,db}`, `filter`, `crossfader`, `master_volume`.
- `PROTOCOL_VERSION = 1` in `hello` (`controls` is an added message: a page that does not know it ignores it).
- The server pings every session once a second (WebSocket ping; browsers answer by themselves) and drops one
  that sent nothing for 5 s, so a phone that left the Wi-Fi stops counting as connected.

## Security model

- One 128-bit random token per role (OS RNG), compared in constant time; the QR carries it.
  **New code** rotates a role's token and disconnects every device paired with the old one.
- `Origin` must be absent or equal to `Host` (other web pages cannot drive the decks through a
  visitor's browser).
- Validation before the engine: decks 0–3, hot cue 0–7, loop 1/32–64 beats, beat jump ±128, no NaN/∞,
  continuous controls clamped (volume 0–1, EQ −26…+6 dB, filter/crossfader −1…1). The desktop shell validates
  every command a second time before the engine call.
- Limits: 48 clients, 16 KiB messages, 120 messages/s per client, 512 queued commands, 8 KiB request head,
  64 connections in their HTTP request at once (the next ones get `503` from the accept thread, no thread is
  spawned for them), 5 s for the whole request head however slowly it arrives.
- **Controls lock** (`RemoteServer::set_controls_locked`): while on, every controller command is refused with an
  `error` (only letting go of CUE passes, so a held deck stops); requests, votes and moderation keep working.
- Text from outside (request title / artist / note, deck labels) loses control characters, zero-width and
  bidirectional formatting characters (U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF and the other invisible
  ones in `is_hidden_char`) and variation selectors that vary nothing; a text that is empty after that is
  refused like an empty one. A request cannot show reversed, spoofed or blank in the DJ's list.
  Three kinds of such characters are kept or replaced because a reader does see them (`strip_hidden`):
  a line break or a tab (also U+0085, U+2028, U+2029) becomes one space, so two lines do not run into one
  word; a zero width joiner stays between two visible characters that are not Latin letters or digits, so an
  emoji sequence (family, profession with a skin tone, rainbow flag) stays one picture; the tag characters of
  a subdivision flag (England, Scotland, Wales) stay right after the black flag U+1F3F4 when they are tag
  digits and lower-case tag letters ended by the cancel tag, at most 8. A joiner between Latin letters or next
  to white space, and tag characters anywhere else, are removed.
  Known limits: the zero width NON-joiner (U+200C) is always removed, so Persian and some Indic words that
  use it to break a ligature are shown joined (readable, not the spelling the guest typed); a text made only
  of combining marks is not refused as blank. Both are on the follow-up list (WP19-58).
- LAN only, plain HTTP: tokens are visible to anyone sniffing the same Wi-Fi. Use **New code** after a
  party; there is no remote access from the Internet.

## Party requests

`RequestQueue` (pure, unit-tested): dedup by normalised title + artist (case, punctuation and `feat.`
tails ignored) — a duplicate counts as a vote; one vote per client; max 3 open requests per client;
200 pending max (lowest-voted oldest dropped); hidden characters stripped (see the security model); 120 chars
per field.
Order: accepted → pending by votes → played → rejected. Guests never see notes, client ids or
rejected requests.

## App integration

```kotlin
val r = backend.startRemote()          // FfiRemote over DecksRemote.start(0, true)
r.pairing(RemoteRoleUi.GUEST)          // url + QR modules (draw with token colours, 4-module quiet zone)
r.pump()                               // every 4th frame: phone commands -> engine, engine snapshot -> phones
r.requests(); r.setRequestState(id, ACCEPTED)
r.setControlsLocked(true)              // phones cannot move the decks; requests keep working
```

`pump()` returns the mixer changes it applied so the shell moves its own knobs (`DecksController.applyRemoteMixer`).
Its `controlsLocked` field is what the server holds right now: `DecksController.controlsLocked` is refreshed from every
report (a lock set elsewhere shows; a change the server refused does not stay shown). The Compose `ConnectPanel` has the
switch **Lock phone controls** (a `Role.Switch` with its state as a word, 44 dp, 48 dp on touch input) right above the
requests row, with the line "Phones cannot move the decks while this is on. Song requests keep working." under it. The
choice is kept while Connect is off and applied again at the next start (a new `DecksRemote` starts unlocked), like the
request switch; nothing is saved across app sessions.
Swift: the same `DecksRemote` object is in the generated `DecksFFI` bindings.

Android: `INTERNET` + `ACCESS_LOCAL_NETWORK` are declared. `ACCESS_LOCAL_NETWORK` becomes a runtime permission
once `targetSdk` reaches 37 (currently 36): the Connect toggle must request it then.

## Decks desktop

The desktop app (`apps/mixai`, Tauri) runs the same crate from its Rust shell (`src-tauri/src/remote.rs`): a pump
thread applies phone commands to the engine and publishes the deck state every 50 ms while Connect is on. The UI is
`src/remote/*` (status-bar chip **Connect** and its popover), the commands are `remote_status`, `remote_start`,
`remote_stop`, `remote_rotate`, `remote_requests`, `remote_request_set`, `remote_set`.

**Turn Connect on.** Click **Connect** in the status bar, then **Start**. The row at the top shows the address the
codes point at (`On · <LAN address>:<port>`). The port is a free one picked at every start, and the three codes are
new at every start: a code from an earlier session never works again. While Connect is on, the chip shows the
number of devices and of requests waiting and can no longer be hidden by a narrow window.

**The three codes, and which one to show.**

| Code | Gives | Show it to |
|---|---|---|
| Party guests | now playing, song requests, votes | the room: this is the only code guests may see |
| Second screen | the decks, read-only | your own tablet / TV |
| Phone remote | full control of the decks and the mixer, request moderation | your own phone, never a screen guests can see |

The **Codes** tab opens with the guest code only. The other two sit behind **Show the other two codes**, next to
the warning: anyone who photographs the remote code controls the decks until you press **New code** for that role
(which disconnects every device paired with the old one).

**Lock phones.** The switch under the address refuses every transport and mixer command from a phone remote (play,
pause, CUE, hot cues, loops, sync, faders, EQ, crossfader, master) while it is on: a phone in a pocket cannot pause a
deck or pull the master down. Song requests, votes and moderation keep working, the phone page says the controls
are locked, and a deck that plays because CUE is held on a phone goes back to its cue point. The choice is kept
while Connect is off, until the app is closed (it is not saved: a new app session starts unlocked).

**CUE from a phone** is the CDJ button: on a playing deck it goes back to the cue point and pauses; paused on the cue
point it plays while held; paused elsewhere it sets the cue point there. A held CUE belongs to the phone that pressed
it (another phone's CUE on that deck is ignored until it is let go). The deck stops on its cue point by itself when
that phone disappears (Wi-Fi lost, tab closed: within about 5 s), when the phones are locked and when Connect is
turned off. If another track was loaded meanwhile, that track is not touched.

**Your own controls win over a phone.** While a phone holds CUE on a deck, PLAY in the app keeps the deck playing
after the phone lets go; PAUSE stops it where it is; CUE takes it back to the cue point, paused. In all three cases
the phone's later release does nothing. Hot cue, beat jump, sync and a click in the waveform are taken into account
as well: a phone's CUE pressed within 150 ms of one of them does not set the cue point at the place the playhead just
left. The native apps (`decks-ffi`) follow the same rules; both implementations run one shared table of scenarios in
their tests.

This covers what goes through the app's deck commands (`deck_play`, `deck_pause`, `deck_seek`, `deck_jump_hot_cue`,
`deck_beat_jump`, `deck_phase_sync`): the on-screen controls, the keyboard shortcuts, HID controllers and plugins,
and PLAY, CUE and the hot cue buttons of a MIDI controller mapped in the shell (`src-tauri/src/midi.rs`).
Not covered on 2026-11-12: the co-pilot's transitions (`copilot.rs`) and the legacy `deck_sync` command. After one
of those, a phone that holds CUE still pauses the deck and takes it back to the cue point when it lets go.

Limit: the shell tells "another track was loaded" by the track id and, for files loaded without a library id, by
the track length to 10 ms. Two files without an id and of the same length to 10 ms, swapped while a phone holds CUE,
count as the same track: the release then seeks the new one to the old cue point, paused. (The native apps use the
load ticket and do not have this limit.)

**Requests.** The **Requests** tab lists what guests asked for (accept → the shared playlist, reject, played, find
in library); a new request is announced once to assistive technology. Keyboard: the tabs are one tab stop (arrows,
Home, End), left / right turn the request pages, and no arrow pressed inside the popover reaches the app's
crossfader shortcuts.

**Turn Connect off** (**Stop**): a deck held by a phone's CUE goes back to its cue point, every device is
disconnected, the request queue is dropped and the port is closed. Nothing of the Connect session survives except
the **Lock phones** choice and the request-switch choice, and those only until the app is closed.

Connect refuses to start (with a message, no port left open) when the port cannot be opened or when the shell's
worker thread is not running; it never reports "on" with commands silently dropped.

### Windows firewall

Connect listens on the LAN (`0.0.0.0:<port>`), so the first **Start** makes Windows show its firewall prompt for
MixAI Decks. Allow it on **private networks** (home or venue network you trust). Not allowing it leaves Connect
"on" on this computer while no phone can reach it; Windows keeps that answer, change it under *Windows Security →
Firewall & network protection → Allow an app through firewall*. If Windows classifies the venue Wi-Fi as a public
network, phones are blocked unless the app is allowed on public networks too: prefer setting that network to
Private over allowing public networks in general. This section describes Windows behaviour and was not re-tested
for this change (the automated tests bind `127.0.0.1` only, which raises no prompt).

What a device on the same network gets **without a code** (source: `handle` in `crates/decks-remote/src/server.rs`):

| Request | Answer without a token |
|---|---|
| `GET /health` | `200 ok` |
| `GET /`, `/remote`, `/party` | `200`, the static page (HTML + script; it holds no deck data, no titles, no token) |
| `GET /tokens.css` | `200`, the design tokens |
| `GET /ws` (WebSocket upgrade) without a valid `t=` | `401`; with a foreign `Origin` `403` |
| anything else | `404`; a method other than `GET` `405`; a malformed request `400` |

Everything live (deck state, now playing, the request list, commands, requests, votes) goes over `/ws` and needs
the token of its role. Without a code a stranger learns that the app is running and can load an empty page.

## Practice mode (desktop)

Status-bar chip **Practice** (`apps/mixai/src/practice/*`). While it is on, the mix is sampled four times a second
and scored 0–100 from four criteria, each shown as a 5-cell meter:

| Criterion | Measures | Weight |
|---|---|---|
| Tempo match | how close the two decks in the mix run (half / double time counts as the same tempo) | 30 % |
| Beats aligned | how far apart their beats land (in half / double time the faster deck's beats against the slower deck's half beats) | 30 % |
| Key match | Camelot compatibility of the two keys, after key shift | 20 % |
| Steady level | jumps of the master level of more than 6 dB within a second that follow a move of a channel fader, trim, crossfader or master volume, or a deck being started or stopped | 20 % |

A slow crossfade (8 s or more end to end) with the decks in time adds a small bonus. Only decks that play and are
audible in the master are judged: the deck being prepared in the headphones is not. A break into a drop in the music
itself is not a level jump, nor is an EQ or filter move.

The score is a heuristic over a few engine readings, not a judge of a mix: it cannot hear phrasing, track choice or
the room, tempo and beats depend on the beat grids being right, and a deliberate cut or a key clash used on purpose
scores as a mistake. Use it as a guide for practice. Details and thresholds: the header of
`apps/mixai/src/practice/scoring.ts`.

## Tests

- `cargo test -p decks-remote` (2026-11-12): 30 unit (protocol validation incl. every numeric command against
  NaN / ∞ / out of range, queue, hidden characters, tokens, QR, HTTP parsing and the request-head deadline; on
  loopback sockets: handshake cap and 503, connection ids and a closed socket, a silent phone dropped by the
  heartbeat, controls lock), 3 asset (token drift, no literal colours, RO/EN key parity), 6 end-to-end on real
  loopback sockets (pages + headers, wrong token / foreign origin refused, controller commands validated and
  drained, state push, viewer/guest cannot control, full party flow, token rotation disconnects only that role).
  Since 2026-11-12 also: line breaks to spaces, emoji joiners and subdivision flags kept only where they draw.
- `cargo test -p decks-ffi --lib` (`engine::cue_button::tests::*`, `remote::tests::*`): the CUE button state
  machine (owner of a hold, the app's own button over a phone, the shared scenario table, settle window),
  pairing/QR/lifecycle, pump against a stopped engine, mixer echo, validation, holds of a phone that goes away on
  real loopback sockets, controls lock, one hold releaser per engine, and the real engine with live audio at
  fader 0 (skipped without an output device).
- `cargo test -p mixai remote::`: the desktop shell: the CUE state machine with a held CUE whose
  phone disappears / is locked out / Connect off / another track loaded / a second phone, the same on real
  loopback sockets (socket closed, code rotated), a press before the engine caught up, start refused without the
  worker thread, labels and hidden characters, lifecycle on loopback; since 2026-11-12 the app's own PLAY /
  PAUSE / CUE / jumps against a phone's CUE, the six deck commands calling `remote::note_local` before the
  engine, and the shared scenario table.
- `node --test src/practice/scoring.test.ts src/remote/remote-core.test.ts` in `apps/mixai` (practice scoring,
  connected-mode helpers).
- `:decks-ui:desktopTest` `RemoteTest`: demo engine refuses, pairings + deck labels, phone mixer echo,
  moderation, party switch, shutdown, controls lock (port calls, pump report as the source of the state, kept across
  Connect off / on); `ConnectPanelTest`: the lock switch absent while Connect is off, named + switch role + state word
  in EN and RO, above the requests row, 44 / 48 dp target, follows a lock the server holds, nothing cut at 320 dp.

Every test binds `127.0.0.1`; none listens on the LAN.

## Not in this slice

Crate sync with MixAI Music and shared b2b crates (ADR-0014 "own LAN sync") need a library change feed in
`decks-library`; mDNS discovery is not needed while pairing is by QR. SwiftUI Connect view is pending
with the other SwiftUI work (built only on vmui-mac).

The Compose shells (`decks-ffi` `DecksRemote`) have the controls-lock switch in `ConnectPanel` (2026-11-12). A CUE a
phone holds is ended by `DecksRemote.pump` when that phone disappears or is locked out (`drain_commands_from` +
`is_connected` in the binding, see [ffi.md](ffi.md)); the shells add nothing of their own to that.
