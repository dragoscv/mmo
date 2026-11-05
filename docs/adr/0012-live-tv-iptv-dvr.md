# ADR-0012 — Live TV, IPTV and DVR as a native MMO Server module

- Status: Accepted · 2026-11-04 (built in MMO Server 3.6.0, HLS proxy 3.7.0, recording file route 3.8.0;
  clients in TV Android 2.0.0, TV Tizen 2.1.0, web 3.0.0)
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) (D28, WP16-12..16, WP16-26, WP16-34, WP16-41)
- Related: [ADR-0009](0009-remove-third-party-embed-sources.md) (no pirate sources),
  [ADR-0010](0010-media-module-and-media-home.md) (server-owned media module),
  [ADR-0011](0011-hub-remote-and-watch-together.md) (hub), user guide [`docs/aplicatie/media-home.md`](../aplicatie/media-home.md)

## Context

Plex, Jellyfin and Emby all have a Live TV tab; MixAI had none. Users who already pay for an IPTV
subscription, run an HDHomeRun tuner or have a provider M3U had to use a separate app on every TV.
WP16 (D28) asked for channels, an EPG grid, fast zapping, catch-up and a DVR on all three surfaces,
without turning MixAI into a channel distributor and without the CPU cost of transcoding on a home
PC or a Raspberry Pi.

Constraints that shaped the design: sources differ wildly (plain M3U with XMLTV, Xtream Codes
`player_api.php`, HDHomeRun HTTP tuners); guides can be tens of MB of XML; TVs are slow at parsing;
upstream URLs often embed credentials; a tuner or an Xtream account allows only N concurrent streams;
and ADR-0009 already established that MixAI ships no third-party content sources.

## Decision

1. **The brain is a native server module, `server/src/livetv/`**, mounted at `/livetv` behind the device
   token (`?t=` is accepted for players that cannot send headers). State lives in its own SQLite file,
   `livetv.sqlite` (sources, channels, programmes, favourites, recordings, rules). Clients never talk to
   an IPTV provider for metadata; they only read `/livetv/*`.
2. **Sources are added by the user; we ship no channel lists.** Three kinds (`types.ts`):
   - `m3u` — URL or file; streaming parser (`m3u.ts`: `#EXTINF` attributes, `tvg-*`, `group-title`,
     `catchup*`), optional XMLTV URL or the playlist's `x-tvg-url` header.
   - `xtream` — host + username + password (`xtream.ts`: categories, live streams, base64 short EPG,
     archive / timeshift); the guide comes from the provider's `xmltv.php` unless overridden.
   - `hdhomerun` — device IP (`hdhomerun.ts`: discover + lineup; DRM channels skipped).
   Passwords are stored server-side and never returned (`hasPassword` only); upstream URLs are redacted in
   logs. Channel ids are a stable hash of (source, tvg-id | url | stream id), so a refresh keeps hidden,
   sort, custom number and per-profile favourites. Sources refresh on their own schedule (`refreshHours`,
   default 24, loop every 15 min).
3. **EPG on the server.** XMLTV is parsed in chunks (`xmltv.ts`, gzip, timezones); programmes are matched
   to channels by tvg-id, then by normalised name (`epg-match.ts`). The store keeps 24 h back and 14 days
   ahead; `GET /livetv/guide?from&to&channels` returns at most a **48 h** window and `GET /livetv/now`
   returns now/next, so TVs render a grid without parsing XML.
4. **Playback: redirect by default, copy-proxy on request, never transcode.**
   - `GET /livetv/stream/:channelId` answers **302** to the upstream URL: zero server CPU and bandwidth, and
     the device token never follows the redirect upstream.
   - `?proxy=1` pipes the bytes through the server (Range forwarded, hop headers copied). For HLS (3.7.0) the
     playlist is **rewritten** so every variant, segment, init map and key goes through
     `GET /livetv/proxy/:channelId?u=&s=`; `s` is an HMAC over (channel, URL) with a per-process secret, so the
     proxy only fetches URLs that appeared in a playlist we served (no open proxy / SSRF). This is what lets
     hls.js on Tizen (`file://` origin) and the browser play streams that send no CORS headers.
   - `GET /livetv/catchup/:channelId?start&duration` answers 302 to the archive URL (Xtream timeshift; M3U
     `catchup-source` templates, `shift`, `flussonic`); `409` when the channel has no archive.
   - Video and audio are passed through as-is. There is no transcode path in the module.
5. **DVR with `ffmpeg -c copy`, remux at idle, never re-encode** (`recorder.ts`, `DvrScheduler`).
   - One-off recordings (from a guide entry or start/stop, padding 0..3600 s, max 24 h) and series rules
     (title match, optional channel, `keepLast`), expanded after every guide refresh.
   - Capture: `ffmpeg -map 0 -c copy -f mpegts` (with `-reconnect` for HTTP) into `<recordings>/.partial/`
     at below-normal priority. When it ends, the `.ts` is remuxed to `.mkv` with `-c copy` inside the global
     analysis slot at **IDLE** priority (`withAnalysisSlot`, same queue as library analysis). If the remux
     fails, the playable `.ts` is kept rather than losing the recording.
   - Recordings go to the first scan folder of kind "recordings" + `Live TV/`, else `<userData>/recordings`.
   - On restart: a recording that was running is marked failed ("server restarted during recording");
     past scheduled ones are marked missed. Nothing is silently dropped.
   - `GET /livetv/recordings/:id/file` (3.8.0) streams a finished recording exactly as recorded, with Range
     (206/416), for `<video>` seeking and offline download. Only `done` rows whose path resolves inside the
     recordings directory are served; the stored path is never trusted blindly.
6. **Tuner limits are explicit.** Each source has a limit: HDHomeRun `TunerCount`, Xtream
   `max_connections`, M3U default **2**, overridable per source (1..64). Over-subscribed recordings are
   flagged `conflict: true` in `GET /livetv/recordings` (first scheduled wins) and fail loudly at start time
   ("tuner conflict: all N tuner(s) of this source are busy") instead of being dropped.
7. **Client zapping strategies** (each surface uses what is fastest on its platform):
   - TV Android (`ui/livetv/LiveTvPlayer.kt`): Media3 `DefaultPreloadManager` keeps the neighbours **N±1**
     (circular, in the current channel list order) plus the last channel preloaded (2 s each); small start
     buffer (`liveLoadControl`). Measured on Google TV with test HLS feeds: zap 348–463 ms.
   - TV Tizen (`screens/LiveTv.tsx`, `screens/livetv/stream.ts`): **two `<video>` elements**, the hidden one
     preloads the neighbour so a zap is a swap; hls.js (MSE) preferred, native `<video src>` fallback for raw
     MPEG-TS. Measured on the Odyssey G8: preloaded zap 23–80 ms.
   - Web (`components/mmo/live/live-player.tsx`): two `<video>` slots, the back one holds the **preloaded
     neighbour** in the direction of the last zap (after 800 ms); zap times are pushed to `window.__mixaiZap`.

## Consequences

- **Positive.** One implementation of parsers, guide, catch-up and DVR for three clients; TVs get a ready
  JSON guide; zero transcoding cost (a Raspberry Pi can record several channels); recordings keep the
  original quality and are playable and downloadable from any client.
- **Known limit — proxied relative HLS on Android.** Media3 resolves segment URIs of a proxied playlist
  against the proxy URL; for upstreams whose playlists use relative paths this broke on TV Android, so its
  `StreamResolver` (`ui/livetv/LiveTvCommon.kt`) reads the server's 302 itself (`/livetv/stream/:id`
  without `proxy=1`, redirects disabled) and plays the upstream HLS URL directly, without the device token.
  Non-HLS streams (MPEG-TS, HDHomeRun) still go through `?proxy=1` with the token header. Tizen and web use
  the rewritten proxy playlists. The consequence: on Android, HLS channels need the upstream to be reachable
  from the TV itself.
- **Costs.** `livetv.sqlite` grows with the guide (14 days ahead); a recording blocks one tuner slot for its
  whole padded duration; remux waits behind library analysis in the idle queue; the proxy secret is per
  process, so after a restart players refetch the master playlist.
- **Legal stance.** MixAI is a player and recorder for sources the user is entitled to. We ship no channel
  lists, no provider presets and no channel logos; store listings avoid "IPTV" wording and channel brands
  (D39). Recordings are private copies on the user's own server. This is consistent with ADR-0009.
- **Contract.** Routes are in `server/openapi.yaml` (drift-guarded), `Models.kt` and the SDK regenerated;
  errors are `{error}` with 400/403/404/409/502.

## Alternatives considered

- **Use Jellyfin/Plex/TVHeadend as the Live TV backend.** Rejected — a second server to install and keep
  running, another auth model, and none of them is the brain the TV apps already talk to (ADR-0010).
- **Transcode to a fixed HLS ladder (ffmpeg on the server).** Rejected — CPU/GPU cost on a home PC or Pi,
  quality loss, and a second of extra latency per zap; every client already decodes the upstream codecs.
  The same rule as WP15 applies: never re-encode video.
- **Parse M3U/XMLTV on each client.** Rejected — guides are tens of MB, Tizen is slow at XML, and favourites,
  recordings and tuner accounting need one shared place anyway.
- **Always proxy.** Rejected as the default — doubles server bandwidth and adds a hop for every viewer; kept
  as `?proxy=1` for CORS-less browsers and token-protected tuners.
- **Bundle a starter channel list (public FAST/free-to-air M3Us).** Rejected — licensing varies per channel
  and country, and listing them makes MixAI a distributor. Romanian channels from our own server are a
  separate project, out of WP16 (D28).
