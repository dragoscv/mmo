# ADR-0002 — MMO Server is a headless Node core; Companion is a shell around it

- Status: Accepted · 2026-09-17

## Context
`server/` is an Electron 34 + Express app, x64-only, with native deps (`audify`,
`better-sqlite3`), Python sidecars and `ffmpeg-static`. Users of self-hosted media
servers expect a Docker image that runs on arm64 (Raspberry Pi). Options considered:
port Electron to arm64; rewrite in Rust; extract a headless core.

## Decision
Extract `server/src/core/` — a Hono (Node 22) app containing library, scanning,
streaming (audio, video direct/remux/HLS), subtitles, sync, auth, mDNS, casting and
the OpenSubsonic API — with **no Electron, audify or Python imports**. Electron's
`main.ts` mounts the same core in-process and adds tray/UI/native audio. The core
ships as a multi-arch Docker image (`node:22-bookworm-slim`, distro ffmpeg) and as a
plain `node dist/core.js` entry.

Pi 5 has no hardware video encoder, so the Pi profile is **direct play → remux
(`-c copy`) → audio-only transcode**, with full video transcodes delegated to a
configured PC (`MMO_TRANSCODE_REMOTE`, rffmpeg pattern) or refused with a clear
client message.

## Rejected
- Electron on arm64: heavy, fragile native builds, not what Docker users want.
- Rust rewrite: best runtime, but discards the existing server and delays by months.
  Rust is used surgically (Cast sender sidecar, rbexport) instead.

## Consequences
- `fluent-ffmpeg` is archived — spawn the ffmpeg CLI directly.
- Native audio (`audify`) and the Python analyzers stay Companion-only features,
  advertised via `/capabilities` so clients can hide them on a Pi.
