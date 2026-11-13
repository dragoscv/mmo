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

A fourth page, `/now`, is not a role: it is the [stream overlay](#stream-overlay-now-playing-page-for-obs) for
OBS, with its own read-only code (desktop app only on 2026-11-12).

Phones need only a browser on the same Wi-Fi. The pages are served by the app itself (no cloud, no
install), follow the system language (RO / EN) and use the design tokens (`/tokens.css`, a byte copy of
`packages/design-tokens/dist/tokens.plain.css`, drift-tested by `tests/assets.rs`).

## Protocol

- HTTP/1.1: `GET /`, `/party`, `/now`, `/tokens.css`, `/health`. Every response carries
  `Content-Security-Policy: default-src 'none'; …`, `X-Frame-Options: DENY`, `no-store`, `nosniff`,
  `Referrer-Policy: no-referrer`. A request is served only when its `Host` header names the server by an
  address (see the security model); anything else gets `403 host`.
- WebSocket `GET /ws?t=<token>&c=<client-id>`; JSON messages, `type`-tagged.
  - in: `command` (controller), `request`, `vote`, `moderate` (controller), `ping`
  - out: `hello`, `state` (controller/viewer), `now_playing` (guest), `requests`, `requested`,
    `controls{locked}` (controller), `on_air{title,artist}` (stream overlay only), `error`, `pong`
  - commands: `play`, `pause`, `cue{pressed}`, `hot_cue{slot}`, `loop_auto{beats}`, `loop_exit`,
    `beat_jump{beats}`, `sync{lock}`, `volume`, `eq{band,db}`, `filter`, `crossfader`, `master_volume`.
- `PROTOCOL_VERSION = 1` in `hello` (`controls` and `on_air` are added messages: a page that does not know
  them ignores them).
- The server pings every session once a second (WebSocket ping; browsers answer by themselves) and drops one
  that sent nothing for 5 s, so a phone that left the Wi-Fi stops counting as connected.

## Security model

- One 128-bit random token per role (OS RNG), compared in constant time; the QR carries it.
  **New code** rotates a role's token and disconnects every device paired with the old one, also a device
  that was let in a moment before: a session keeps the code it was opened with together with the revision
  of the codes at that moment (both read under one lock), and compares its code again whenever the revision
  moved. (In 1.6.0 a session took the revision only when its loop started, after its first message was
  sent: a role code changed in that gap was never noticed and the device stayed connected with the revoked
  code for as long as the socket lived. Fixed in 1.7.0, for the roles and for the stream overlay.)
- The stream overlay has a token of its own that is not a role: a socket opened with it is sent `on_air` and
  nothing else (no `hello`, no deck state, no request list, no controls lock) and everything it sends except
  `ping` is answered with `error` ("the stream overlay is read-only"). See
  [Stream overlay](#stream-overlay-now-playing-page-for-obs).
- `Origin` must be absent or equal to `Host` (other web pages cannot drive the decks through a
  visitor's browser).
- `Host` must name the server by an ADDRESS: an IPv4 literal (`192.168.1.20:47831`), a bracketed IPv6
  literal (`[::1]:47831`) or `localhost`, each with or without a port. Every request with another host, or
  with none, is answered `403 host` before anything else is looked at: no page, no `/health`, no socket
  (`host_is_address` in `crates/decks-remote/src/http.rs`). Why: the origin rule above compares two headers
  that both carry whatever NAME the browser was given. A page on another site can point its own DNS name at
  this computer ("DNS rebinding"); its requests then arrive with that name as host and as origin and pass
  the origin rule. With this rule they are refused, whatever code they carry. Phones, second screens and OBS
  are not affected: every pairing address and the stream overlay address name an IP address. The port in the
  header is not compared with the port bound (a forwarded port may differ). Not accepted on purpose: a
  computer name (`my-pc.local`), a decimal or hexadecimal address (`2130706433`, `0x7f.0.0.1`), an IPv6
  literal with a zone (`[fe80::1%eth0]`).
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
- What the stable stream overlay address means for all of this: the three role codes still die when Connect
  is turned off, but the overlay code is long-lived (kept between starts until **New code** on the Stream
  tab) and the port is the same every time. So an address that leaked once (a scene file shared online, a
  screenshot of the OBS source properties, a recording of the Wi-Fi: it travels in plain HTTP like every
  code) stays usable until the code is changed. What it gives: whoever has the address and can reach this
  computer's port reads the title and the artist of the track on air, and nothing else (no deck state, no
  request list, no control; see the stream overlay section). Treat the address like a link to a public
  "now playing" widget, and press **New code** when it got out.

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
codes point at (`On · <LAN address>:<port>`). The port is the fixed port 47831 (see
[The port](#the-port)), and the three codes are new at every start: a code from an earlier session never works
again (the stream overlay code is the exception: it is kept). While Connect is on, the chip shows the number of
devices and of requests waiting and can no longer be hidden by a narrow window.

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
the **Lock phones** choice and the request-switch choice, and those only until the app is closed. Kept across
sessions (on this computer): the stream overlay code and nothing else; with the fixed port that keeps the address
in OBS working (see [Stream overlay](#stream-overlay-now-playing-page-for-obs)).

Connect refuses to start (with a message, no port left open) when the port cannot be opened or when the shell's
worker thread is not running; it never reports "on" with commands silently dropped.

### The port

Connect asks for the same port at every start: **47831** (`REMOTE_DEFAULT_PORT` in
`apps/mixai/src/remote/overlay-core.ts`; a user port that IANA has not assigned to a service and that is outside
the ranges Windows reserves by default). A stable port is what lets the address pasted into OBS survive a
restart of the app.

When that port is taken (another program listens on it, or the system holds it: Windows answers "access denied"
for a port in a reserved range), Connect does not fail: it starts on a free port and says so. The status answer
carries `portFallback: true`. Any other failure to open the port is still an error.

A fallback is for that run only. The app never keeps a port: the next start asks for 47831 again, whatever port
the last run ended up on (a fallback port comes from the system's dynamic range; asking for it again would make
the address drift from start to start and the fixed port would never be tried again). So after a run on a
fallback port the address in OBS is the usual one again as soon as 47831 is free at a start; during that run
OBS needs the address of that run.

Where the DJ is told: the note is on the **Stream** tab only. The tab carries a mark ("!", read out as "the
address changed") while Connect runs on a fallback port, and the tab shows "The usual port was in use: this time
Connect runs on port N. Copy the address below into OBS; the next start tries the usual port again." The line
next to **New code** then says "This address works until Connect is stopped." instead of "The address stays the
same the next time you start Connect." Nothing is shown outside that tab: a DJ who uses Connect for phones only
sees just the mark. (The phone codes are new at every start anyway, so a changed port costs them nothing.)

The shell itself has no default port: `remote_start` without `port` (or with 0) takes any free port, as before.
The native apps (`decks-ffi`) still start on a free port chosen at every start.

### Stream overlay ("Now playing" page for OBS)

`GET /now` is a page that shows the title and the artist of the track that is on air and follows the mix by
itself. It is made for an OBS **Browser source**; any tool that shows a web page works.

**Add it in OBS.**

1. In MixAI Decks: **Connect** → **Start** → tab **Stream** → **Copy** next to "This computer".
2. In OBS: *Sources* → **+** → **Browser**. Paste the address as **URL**.
3. Width **1200**, height **240** is a good start (the text scales with the box: any size from 300×80 to
   1920×1080 works; the title takes at most two lines, the artist one). Leave "Custom CSS" as it is: the page
   keeps its own background transparent.
4. Put the source where the title should sit. Nothing shows until a track is on air.

The address looks like `http://127.0.0.1:47831/now?t=<code>`. "This computer" is the loopback address: it keeps
working when the Wi-Fi address changes, and it is the one to use when OBS runs on the same computer as Decks.
"Another computer" is the same page on this computer's LAN address, for a second streaming PC; it is offered only
when Connect listens on the network (it changes when the network does). When Connect was started on one address
only, only the address that actually answers is offered.

**Options** (add them to the address with `&`; a value that is not listed is ignored):

| Option | Values | Effect |
|---|---|---|
| `align` | `left` (default), `center`, `right` | where the text sits in the box |
| `scale` | `0.5` … `3` (default `1`) | text size relative to the width; the height of the box still caps it |
| `plate` | `1` | a solid plate behind the text (tools without transparency, busy video) |
| `plate` | `full` | the whole page solid (a plain background instead of a transparent one) |
| `label` | `1` | a small "Now playing" line above the title |
| `lang` | `en`, `ro` | language of that label and of the page's one message (default: the language of the browser) |

Example: `http://127.0.0.1:47831/now?t=<code>&align=right&scale=1.5&label=1`.

The page uses the design tokens (`/tokens.css`), in the dark mode; the text has a dark halo so it reads on any
video. Text fades when the track changes and when nothing is on air; with "reduce motion" set in the system the
change is immediate. A title longer than two lines ends in an ellipsis. Title and artist are inserted as text,
never as markup.

**When the title changes (the on-air rule).** A track is on air once it has been the loudest audible one for
**8 seconds** in a row. Audible level = playing × channel fader × crossfader side (a deck assigned THRU ignores
the crossfader); under 0.05 a deck counts as silent; of two equally loud decks the first one wins. While another
track has been louder for less than 8 s nothing changes, so a short blend or a cut back does not flicker. After
8 s without any audible track the page shows nothing. The same track taking over on another deck is not a change.
The rule is `crates/decks-remote/src/on_air.rs` (pure, unit-tested); the shell feeds it every 50 ms while Connect
is on (`on_air_decks` / `feed_on_air` in `src-tauri/src/remote.rs`) with the deck's own crossfader assignment and
the same cleaned title and artist the phone pages get (the library's label when it belongs to the loaded track).
It runs only while Connect is on, and starts from nothing at every start.

How it differs from the set tracklist (`src/setlog`, [set-recording.md](set-recording.md)): the tracklist waits
20 s and then backdates the entry to the moment the track became the loudest; the overlay waits 8 s and never
backdates: it follows the room. The party page's "now playing" is a third thing: every playing deck with its
fader up, at once.

**What the code allows.** The `t=` code in the address is the stream overlay code. It only reads the on-air
title: a socket opened with it gets `on_air` messages and nothing else (no deck state, no BPM, no request list),
and a command, a song request, a vote or a moderation sent on it is refused. It is kept between starts of the
app (the phone, second-screen and guest codes are new at every start), so the address in OBS stays valid.
**New code** on the Stream tab makes a new one: every overlay using the old address is disconnected at once and
the old address is refused from then on (the page then shows "MixAI Decks did not accept this address. Copy it
again from Connect, Stream." so the streamer sees why the source went empty; the same line shows in the rare
case that 48 devices are connected already); the phones stay connected. Anyone on the network who has the
address can read the title of the track on air, nothing more; the address travels in plain HTTP like the other
codes.

Where the code is kept: in the app's local storage on this computer (key `mixai-remote-overlay`; the code only,
never a port: a value written by a build that also stored the last port is still read for its code and rewritten
without the port). It is NOT part of the settings export and NOT part of the cloud profile (a test pins that),
so another computer with the same account gets its own code. A code handed to the shell is taken only in the
exact form the shell makes (32 lower-case hex characters); anything else is replaced by a fresh one.

**Limits and behaviour on a lost connection.**

- Overlays count as devices: at most 48 devices in total, each overlay is pinged and dropped after 5 s of
  silence like a phone, and it shows in the **Devices** tab as "Stream overlay".
- The page reconnects by itself (0.5 s, doubling to 8 s). After a lost connection it keeps the last title for
  **5 seconds**, then clears it, and shows the current one again as soon as it is back. Besides the server's
  pings the page sends its own every 4 s and treats 12 s of silence as a lost connection.
- With Decks closed or Connect off the page cannot load at all: OBS shows its own "cannot connect" page in the
  source until Connect runs again (OBS reloads a Browser source when the scene becomes active if "Refresh
  browser when scene becomes active" is ticked; otherwise use the source's Refresh button once).
- A file without tags shows what the deck shows (its file title); a track with neither title nor artist shows
  nothing.
- Two files loaded WITHOUT a library id that have the same title, artist and length (to 10 ms) count as one
  track for the rule.
- The overlay is in the desktop app only. The native apps' Connect (`decks-ffi`) serves the page (same crate)
  but nothing feeds the rule there and no screen shows the address: the page stays empty.
- Browser engine: the colours of the page (the tokens are `oklch()`, the halo is a `color-mix()`) need
  Chromium 111 or newer. OBS Studio 31.0 moved its Browser source to Chromium 127 (OBS 31.0 release notes).
  Rendered and measured on 2026-11-12 with headless Edge 157 only; NOT tried inside OBS, and not on an older
  engine (there the text is expected to stay readable, white without the halo and without the plate: not
  verified).
- Text size: the title is 5 % of the source's width times `scale`, capped at 20 % of its height (18 % with
  `plate=1`) so that two title lines, the artist and the label always fit. From the page's CSS
  (`--t: min(20vh, calc(5vw * var(--scale)))`): 48 px in a 1200×240 source (the height caps it: 20 % of 240;
  5 % of 1200 would be 60), 96 px in 1920×1080 (5 % of 1920), and the smallest, **15 px** in 300×80 (5 % of
  300; 20 % of 80 would be 16), 14.4 px there with `plate=1` (18 % of 80). The artist is 0.6 and the label
  0.4 of the title size (9 px and 6 px in a 300×80 source: legible only as a hint; use a larger source).
- Fonts: the page ships no font file. It asks for the families of the design tokens (Space Grotesk for the
  title, Inter for the rest) and, when the computer that runs the page does not have them, for the fonts
  every system has (`system-ui`, `-apple-system`, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, then
  the generic sans-serif). So the face is decided by the computer OBS runs on: on a Windows PC without those
  two fonts installed the text is Segoe UI. Install the two fonts there to get the look of the app; the
  layout does not depend on it (sizes follow the box, long text ends in an ellipsis).

**With an older build of the app** (a shell that does not know the overlay): the Stream tab is not shown, Connect
starts on a free port as before, and nothing else changes. The UI tells such a shell by the missing
`portFallback` field of the status.

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
| `GET /`, `/remote`, `/party`, `/now` | `200`, the static page (HTML + script; it holds no deck data, no titles, no token) |
| `GET /tokens.css` | `200`, the design tokens |
| `GET /ws` (WebSocket upgrade) without a valid `t=` | `401`; with a foreign `Origin` `403` |
| anything else | `404`; a method other than `GET` `405`; a malformed request `400` |
| any of the above with a `Host` that is not an IP address or `localhost` (or with no `Host`) | `403 host`, nothing else |

Everything live (deck state, now playing, the request list, commands, requests, votes) goes over `/ws` and needs
the token of its role (the on-air title: the stream overlay code). Without a code a stranger learns that the app
is running and can load an empty page.

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
- Stream overlay (2026-11-12). Crate: `on_air` unit tests (levels, the 7.9 s / 8.0 s boundaries for a first
  track, a challenger and silence, a doubled track, backward and non-finite time), the overlay access
  (`an_overlay_may_only_ping`, code lookup), `tests/assets.rs` (the page is in the token, locale and text-only
  checks), `tests/e2e.rs` on loopback sockets (page + headers, a saved code kept and a malformed one replaced,
  `on_air` at connect and on change and nothing else while deck state / requests / the lock change, commands /
  requests / votes / moderation refused, a new code disconnects the overlay and only it, the device limit, a
  silent overlay dropped). Shell (`cargo test -p mixai remote::`): the feed (assignment, fader, labels, track
  identity), 8 s on a real overlay socket through the pump's own step, the rule reset at every start, which
  addresses are offered per bind, the busy-port fallback on a real busy loopback port, the code kept /
  validated / rotated. UI (`node --test src/remote/*.test.ts`): `overlay-core.test.ts` (copy with an injected
  clipboard, what is stored, what a start sends to a new and to an old shell) and `contract.test.ts`, which
  reads `remote.rs` and `bridge/remote.ts` and pins the command names, their arguments and every field of the
  status, the event, a device, a pairing and the on-air track.
  Counts with the overlay: `cargo test -p decks-remote` = 43 unit + 4 asset + 12 end-to-end (was 30 + 3 + 6).
  The tests were shown to be able to fail: 21 one-line changes of the crate (the 8 s threshold, the crossfader
  side, the overlay's read-only rule, its code check, rotation, the route) and 11 of the shell (the busy-port
  fallback, the feed, the code kept, the rule reset) each turn at least one test red; one further shell change
  is equivalent by design (the rule is reset both when Connect starts and when it stops: removing one of the
  two changes nothing, removing both is caught).
  NOT tested on 2026-11-12: the page inside OBS itself (it was rendered by headless Edge only), a real second
  streaming computer on the LAN address, the Windows firewall prompt, and the overlay against a running app
  (the dev instances ran a shell built before this change; the scripts for that are in the work package notes).
- Stream overlay, review fixes (2026-11-13). Counts: `cargo test -p decks-remote` = 47 unit + 4 asset + 12
  end-to-end; `cargo test -p mixai remote::` = 49; `node --test src/remote/*.test.ts` = 36.
  - A code changed right after a device was let in (`a_code_changed_right_after_a_device_was_let_in_still_`
    `disconnects_it`): a test-only gate holds a new session between its handshake and its loop while the test
    presses "New code", for a role and for the overlay, with two controls (a device held there while another
    code changes stays and is served). The old order (the revision read when the loop starts) fails it every
    time; before, the same defect showed only now and then, as a device that stayed connected for the whole
    20 s limit of an end-to-end test on a busy machine.
  - The `Host` rule: unit tests of `host_is_address` (addresses, `localhost`, IPv6 literals, DNS names, a
    missing header, odd ports and odd address forms) and real sockets (`a_request_that_names_the_server_by_a_`
    `dns_name_gets_nothing`, plus lines in the two end-to-end tests): every path answers `403 host` to a DNS
    name, also a socket request whose origin equals its host and whose code is right.
  - The pump: the step the thread runs is `pump_step`; `one_pump_step_does_everything_the_thread_needs_on_a_`
    `real_server` drives it against a real loopback server with a phone socket and an overlay socket (a phone
    command reaches the engine, the state reaches the phone, the rule is fed and the overlay hears it after
    8 s, a vanished phone's hold ends, no engine = silence), and a source check pins that the Tauri-only
    wrapper hands the step over and does none of it itself. Every other overlay test of the shell now goes
    through that step as well.
  - `remote_set` as one batch (`remote_set_is_one_batch_refused_whole_or_applied_whole`), and in the UI: a
    start after a fallback asks for the fixed port again, a stored value from before (with a port) is read
    for its code and rewritten without the port.
  - The end-to-end tests' client now answers the server's pings from a thread of its own, like a browser tab
    (a socket a test merely holds was dropped as silent after 5 s when the machine was saturated: three tests
    red in one run of thirty).
  - Able to fail: 14 one-line changes of the crate and 12 of the shell for these fixes (the late revision
    read, the revision not moved by "New code", the host rule in its parts, the pump step without its feed /
    publish / commands, the batch rule) and 9 of the UI helpers (a port kept, read back or asked for again).
  - Live, on a dev instance of the app with the overlay (2026-11-13, build of 01:43, before these fixes): the
    fixed port and the same overlay code across stop / start and page reloads; the page and its headers
    fetched on the computer itself; `on_air` first and nothing else on an overlay socket; on air 8.07 s after
    PLAY, 8.01 s after the crossfader moved to the other deck, cleared 8.08 s after both decks paused
    (measured on the socket); seven kinds of messages refused on the overlay socket while a phone's PLAY
    worked; "New code" closing the overlay socket 0.35 s after the click and leaving the phone connected; a
    start with the port held by another program running on a fallback port with the note and the tab mark;
    the app's own page rendered by headless Edge with the title on air.
    NOT done live: the fixes of this date themselves (the host rule and the late-revision fix need a new
    build of the shell; the "never keep a port" change is covered by unit tests only), OBS itself, a second
    computer on the LAN address, the firewall prompt.
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
