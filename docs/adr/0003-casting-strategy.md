# ADR-0003 — Casting: browser Cast + DLNA + Home Assistant first, server-side Cast second

- Status: Accepted · 2026-09-17

## Context
No casting code exists. Target renderers: Google TV / Chromecast (Cast), Samsung
Odyssey OLED G8 (Tizen: DLNA renderer, no Chromecast built-in), Nest Hub, any TV.
Jellyfin's most-reported problem is unreliable Cast; Node Cast libraries
(`castv2-client`) are unmaintained; Rust `rust_cast` 0.21 is active.

## Decision
Phase 1 (now):
1. **Google Cast Web Sender** in the web app using the Default Media Receiver
   (`CC1AD845`, no registration). Chrome/Chromium only. Subtitles as WebVTT with CORS.
2. **DLNA/UPnP renderer control** in MMO Server (`upnp-client-ts`): discover via SSDP,
   `SetAVTransportURI`/`Play`. Covers the Odyssey and virtually every TV on the LAN.
3. **Home Assistant bridge** in MMO Server: `media_player.play_media` on existing
   entities (`HA_URL`, `HA_TOKEN`). Works from any client, including Firefox/mobile.
4. One "Play on…" picker that merges the three device lists + MixAI TV devices.

Phase 2: a Rust `rust_cast` sidecar so the server drives Cast devices itself
(works through Tailscale from any client). Phase 3: custom CAF receiver ($5 account)
and Tizen app for full-UI playback with ASS/PGS subtitles.

## Consequences
- Streams handed to renderers must be reachable by the renderer: LAN URL from mDNS,
  H.264/AAC in MP4 or HLS, never MKV/HEVC-in-TS for Cast.
- The server needs a `renderer profile` per target (Cast DMR, Tizen, generic DLNA)
  to choose direct/remux/transcode.
