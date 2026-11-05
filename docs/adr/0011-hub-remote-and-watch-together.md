# ADR-0011 — Authenticated WebSocket hub for remote control and Watch Together

- Status: Accepted · 2026-11-04 (built in MMO Server 3.5.0, clients in TV Android 2.0.0, TV Tizen 2.1.0, web 3.0.0)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) (D29, WP16-07, WP16-08, WP16-27, WP16-34, WP16-39)
- Related: [ADR-0004](0004-tv-apps-compose-media3-and-tizen-web.md) (TV apps), [ADR-0010](0010-media-module-and-media-home.md)
  (server-owned media module), user guide [`docs/aplicatie/media-home.md`](../aplicatie/media-home.md)

## Context

After WP10–WP15 every surface (web, TV Android, TV Tizen) could play from an MMO Server, but each one
did so alone. There was no way to see which devices were online, to start a film on the TV from the
browser, or to type a search on the TV from a phone. The only shared-viewing feature was the old
`/video/party` watch party: a relay that forwarded play/pause events with no clock model, so members
drifted apart by whatever their network latency happened to be, and it only worked between browsers.

WP16 (D29) asked for three things on one channel: a **device registry with presence**, **remote
commands** with an acknowledgement (play on TV, pause, seek, text input), and **Watch Together** rooms
that keep several players on the same frame, including guests outside the LAN (through the tunnel).
All three need server-to-client push with low and predictable latency, and Watch Together needs a
clock model, not just event forwarding.

## Decision

1. **One authenticated WebSocket, `WS /hub`, on the MMO Server** (`server/src/hub/`). `index.ts` wires
   the socket and the HTTP routes; `core.ts` (`HubCore`) holds all state and is transport-agnostic and
   deterministic given `now()`, so it is unit-tested without sockets (`hub.test.ts`); `sync-math.ts` holds
   the pure clock and drift rules that every client mirrors.
   - Auth: `?t=<deviceToken>` (or `x-device-token`) gives full access; TV apps have no `Origin`, so the
     token alone is enough. `?inv=<invite>&name=<name>` gives guest access to **one room only**, and only
     from an allowed browser `Origin`. Anything else gets `401` at upgrade time.
   - Frames are JSON, `maxPayload` 64 KiB, server ping every 20 s (dead sockets are terminated).
   - HTTP siblings behind the device token: `GET /hub/devices`, `POST /hub/command` (waits up to 4 s for the
     target's ack: 200, 404 `no_such_device`, 504 `timeout`), `POST /hub/rooms`, `GET /hub/rooms/:id`. Public:
     `GET /hub/invite/:invite` (room name, phase, media, member count) for the guest join page.
   - The `/ws` status socket was switched to `noServer` + path dispatch in the same release: the old
     `{server, path}` form answered `400` to every other upgrade path on the port, including `/hub`.
2. **Device registry and presence.** A client sends `hello {deviceId, name, platform, caps, profileId, app}`;
   a reconnecting `deviceId` replaces its stale connection. `state {playing, positionSec, durationSec, media}`
   (or `idle`) records what the device is playing. Every change broadcasts `devices` to all non-guest
   connections. Platforms in use: `android-tv`, `tizen`, `web`, `web-guest`.
3. **Remote commands.** `cmd {target, action, args, seq}` is forwarded to the target as
   `cmd {from, action, args, seq}`; the target answers `ack {seq, ok, error?, state?}`, which is routed back
   to the sender (or resolves the pending HTTP request). The server does not interpret actions; clients
   advertise them in `caps`. TV Android and TV Tizen implement `play` (`fileId`, start second), `pause`,
   `seek`, `stop`, `next`, `previous`, `text` (opens Search with the typed query) and `navigate`; the web
   player implements `play`/`pause`/`resume`/`toggle`/`seek`/`seekBy`/`stop`/`next`/`previous`/`rate`/`volume`
   and advertises the transport subset. Unacked commands are dropped after 30 s.
4. **Watch Together rooms** (max 16 members, empty rooms expire after 10 min).
   - **Clock sync** (SyncPlay-style): clients send `time {t0}` (3 pings 1 s apart, then every 30 s), the
     server answers `{t0, t1, t2}`; offset `((t1-t0)+(t2-t3))/2`, RTT `(t3-t0)-(t2-t1)`. `ClockEstimator`
     keeps the **8 latest samples, trusts the lowest-RTT one** and smooths the offset with an **EMA, α = 0.4**.
   - **State machine** `idle → waiting → playing ⇄ paused`. `room:load` / `room:seek` / a late joiner / a
     member reporting `room:ready {ready:false}` puts the room in `waiting`; when every member is ready
     (or after an 8 s timeout that drops stragglers' veto) the server resumes.
   - **Scheduled commands**: play is not "start now" but an anchor `{playing, positionSec, atServerMs}` with
     `atServerMs = now + leadTime`, `leadTime = max member RTT + 150 ms`, clamped to 150..2000 ms. Every
     client converts the anchor to its own clock and starts at the same server instant.
   - **Drift correction** (`driftAction`, hysteresis): members report `room:report {positionSec, rttMs}` at
     1 Hz; each client compares its position with `expectedPosition(anchor)`. Above **120 ms** it nudges the
     playback rate proportionally, clamped to **0.95–1.05** (pitch change stays inaudible), until drift is
     under **40 ms**; above **1.5 s** it hard-seeks.
   - Chat (`room:chat`, 500 chars) and reactions (`room:react` with the media timestamp) are relayed to the room.
5. **Invites over the tunnel.** An invite is `roomId.exp.HMAC-SHA256(secret, roomId.exp)` (32 chars,
   base64url), valid **24 h**, verified with a constant-time compare. The secret is persisted in
   `media.sqlite` (`hub_secret`) so links survive restarts. A guest can only send `room:*`, `time` and
   `hello`, never sees the device list, and can stream **only the room's current file**: `/video/*?inv=`
   is accepted for that `fileId` (`inviteAllowsFile`), and guest HLS playlists carry `inv=` on segment
   URLs, never the device token. The invite link works through the Cloudflare tunnel because it is a plain
   HTTPS/WSS URL on the same server.
6. **WebSocket, not SSE.** The hub is bidirectional by nature: `time` pings need a round trip measured on one
   connection (an SSE stream plus separate POSTs puts the request on a different socket with different
   latency, which corrupts the RTT sample), commands need acks routed back, and members report state at
   1 Hz. TV clients already ship OkHttp (Android) and native `WebSocket` (Tizen, browsers). The SSE fallback
   listed in WP16-07 was **not built**; clients reconnect with exponential backoff 1 s → 30 s and rejoin
   their room instead.
7. **Clients.**
   - TV Android: `apps/tv-android/.../data/HubClient.kt` (OkHttp WS, backoff, `ClockEstimator`, remote
     commands, rejoin after reconnect), `ui/together/WatchTogetherScreen.kt` (invite + QR, members, chat,
     reactions), room-following player with a drift corrector. Requires server ≥ 3.5.0 (`MIN_HUB_VERSION`).
   - TV Tizen: `apps/tv-tizen/src/lib/hub.ts`, `screens/Together.tsx`, `player/useRoomSync.ts`; same
     protocol and version gate; the device name override in Settings is sent in `hello`.
   - Web: `apps/web/src/lib/mmo/hub.ts` (same behaviour, forwards `playerBus` now-playing as `state`),
     `components/mmo/player/together-panel.tsx` + `use-room-sync.ts`, "Play on TV" picker and remote mode,
     public guest page `/together` (what the TV QR codes open, `guest-together.tsx`).

## Consequences

- **Positive.** One protocol for presence, remote and shared viewing on all three surfaces; Watch Together
  members stay within tens of milliseconds instead of a network RTT; "Play on TV" works from any browser that
  holds the server token; guests need no account and get access to one file for one day.
- **Costs.** Hub state is in memory: a server restart drops rooms and presence (clients reconnect and see an
  empty registry; an invite is only accepted while its room exists, so old links stop working). Rooms live on one server; there is no
  cross-server room. The drift math is duplicated in TypeScript (server, Tizen, web) and Kotlin and must stay
  in step (`sync-math.ts` is the reference, tests on both sides). Servers older than 3.5.0 have no hub and
  answer `400` on `/hub`; clients show "server too old".
- **Security.** Full access still equals the device token (same trust as every other route). Guests are
  limited by the HMAC invite, the `Origin` check and the per-file `/video` gate. Chat moderation
  (report/block/filter) is not built in this ADR; it is scoped to WP16-50.
- **Contract.** Routes are in `server/openapi.yaml` (drift-guarded by `openapi:check`), `Models.kt` and the SDK
  are regenerated; the WS message set is documented at the top of `server/src/hub/core.ts`. The old
  `/video/party` router stays as it was.

## Alternatives considered

- **Jellyfin SyncPlay as-is.** Its clock model (lowest-RTT ping, scheduled commands, rate/seek correction) is
  what we copied, but the implementation is tied to Jellyfin's session and user model and its C# server.
  Porting the protocol verbatim would have imported concepts we do not have (Jellyfin users, group
  permissions) and no TV client of ours speaks it.
- **Firebase (Realtime Database / Firestore) as the relay.** Rejected — makes a Google account and the
  internet mandatory for a LAN feature, adds a second auth system next to the device token, and gives no
  control over latency for clock sync. A self-hosted server is the point of MixAI.
- **WebRTC data channels between members.** Rejected — needs signalling anyway (so a server channel still
  exists), plus STUN/TURN for members behind NAT; mesh topology grows quadratically with 16 members; Tizen's
  WebRTC support is uneven. The latency gain is irrelevant once commands are scheduled ahead by max RTT.
- **Server-Sent Events + HTTP POST.** Rejected for the reasons in decision 6 (split sockets distort RTT, no
  natural ack path).
- **Keep the old `/video/party` relay.** Rejected — no clock model, browsers only, no presence or remote.
