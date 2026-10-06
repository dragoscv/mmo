# MixAI Media Platform — canonical plan & tracker

> Status: **ACTIVE** · Owner: Dragos · Created 2026-09-17 · This is the single
> tracker for the MuzicAI → MixAI rebrand, the self-hosted **MMO Server**, casting,
> TV/Tizen apps, OpenSubsonic, codai integration. Update the checkboxes here, not in
> chat. Decisions live in `docs/adr/`.

## 0. Naming (ADR-0001)

| Thing | Name | Identifier |
|---|---|---|
| Brand / platform / account / domain | **MixAI** | `mixai.ro`, `api.mixai.ro`, `device-<id>.mixai.ro` |
| Self-hosted server (Pi / PC / Docker) | **MMO Server** — *MixAI Media Organizer* | image `ghcr.io/dragoscv/mmo-server`, mDNS `_mmo-server._tcp`, pkg scopes `@mmo/*` |
| Web app (Next.js, Vercel) | **MixAI** | `apps/web`, PWA id `ro.mixai.app` |
| Desktop companion (Electron shell around MMO Server) | **MixAI Companion** | `ro.mixai.companion`, userData `mixai-companion` |
| Native DJ app (Tauri) | **MixAI DJ** | `apps/mixai`, `ro.mixai.dj` |
| Android TV / Google TV app | **MixAI TV** | `apps/tv-android`, `ro.mixai.tv` |
| Samsung Tizen app (.wgt) | **MixAI TV** (Tizen) | `apps/tv-tizen`, id `http://mixai.ro/tv` |
| Mobile (Android now, iOS later) | **MixAI** | `apps/native`, `ro.mixai.app` |
| Browser extension | **MixAI Downloader** | `mixai-downloader@mixai.ro` |

Rule: user-facing copy always says *MixAI*; the word *MMO* appears only when we mean
the server ("MMO Server", "run MMO Server on your Raspberry Pi").

## 1. Why we win vs Plex / Jellyfin / Navidrome (research 2026-09-17)

Evidence in `/memories/repo/media-server-research-2026-09.md` and the ADRs.

1. **Casting that works** — Jellyfin's #1 complaint; Plex paywalled remote. We cast
   server-side (works via Tailscale, from any client) plus browser Cast + DLNA + HA bridge.
2. **Music is a peer of video** — OpenSubsonic API → 50+ clients day one; gapless,
   ReplayGain, synced lyrics (LRCLIB), sonic similarity. Jellyfin music is weak,
   Navidrome has no video.
3. **AI that nobody ships** — codai: semantic search (embeddings), NL playlists
   (filter-first, LLM ranks), Whisper subtitles, skip-intro, auto-tagging. Pi stays thin,
   ML runs on the PC or codai cloud (Immich remote-ML topology).
4. **Free remote access, free mobile, free TV** — after Plex's 2025–26 paywalls.
5. **Pi-first honesty** — Pi 5 has no HW encoder: direct play → remux → delegate
   transcode to the PC (rffmpeg pattern). Never burn-in subs on the Pi (OCR PGS at scan).
6. **One brand, many surfaces** — web, Companion, DJ, TV (Compose+Media3), Tizen, mobile.

## 2. Phases & checklist

### Phase A — Rebrand (this session)
- [x] All user-facing strings MuzicAI → MixAI (i18n ro/en, JSX, manifests, metadata)
- [x] Server naming → "MMO Server" / "MixAI Companion" (package.json, productName, appId, artifactName)
- [x] Bundle IDs `ro.muzicai.*` → `ro.mixai.*` (tauri ×2, capacitor, electron, Play packageName)
- [x] Storage-key migration: `muzicai-*` localStorage/IndexedDB/userData → `mixai-*` with one-time copy (`lib/storage-migration.ts`, `server/src/store.ts`)
- [x] Domains → `mixai.ro` (layout metadataBase, extension DEFAULT_BASE_URL, server defaults, CORS allowlists, terraform, assetlinks, AASA, tunnel docs, tests)
- [x] Logos/wordmark/OG re-exported with MixAI text; gradient ids renamed
- [x] README/README.en/NAVIGARE/docs/CHANGELOG headers; docs/mixai plan renamed "MixAI DJ"
- [x] Versions: web **1.0.0**, companion **2.0.0**, extension major bump, mixai DJ bump
- [x] Verify: `rg -i muzicai` = 0 outside CHANGELOG history; web typecheck+vitest; server tsc+vitest; gateway vitest

### Phase B — Infrastructure
- [x] Cloudflare: zone `mixai.ro` added (pending NS change at registrar: clyde/rachel.ns.cloudflare.com), nameservers handed over, scoped API token (Zone.DNS + Cloudflare Tunnel) stored in `.env`, never printed
- [x] DNS: `mixai.ro`, `www`, `api` (Cloud Run gateway), `device-*` (tunnel), `staging`
- [ ] Vercel domain + Cloud Run gateway domain mapping + Terraform CORS updated

### Phase C — MMO Server core (ADR-0002)
- [x] `server/src/core/` — headless Hono app: library, audio/video streaming, HLS, subtitles, scan, mDNS, auth, sync; no Electron/audify imports
- [x] Electron `main.ts` boots core in-process (Companion = shell)
- [x] `server/Dockerfile` node:22-bookworm-slim, multi-arch amd64+arm64, ffmpeg from distro, `MMO_DATA=/data`, `/media` volume, `/health`
- [x] `.github/workflows/mmo-server-docker.yml` — native arm runner matrix, push by digest, `imagetools create`, GHCR
- [x] `infra/pi/compose.mmo.yaml` + deploy to `homepi` (`ssh homepi`, Docker, `/srv/homepi/mmo`) — verify `curl http://homepi.local:17899/health`
- [ ] Transcode delegation: `MMO_TRANSCODE_REMOTE=ssh://pc` (rffmpeg-style), Pi does copy/remux only
- [x] Quick Connect pairing (6-digit code) for TV/mobile
- [x] Device-code login (/activate) — `POST /api/device/code` + `POST /api/device/token`, mints an Auth.js session for the TV

### Phase D — Casting phase 1 (ADR-0003)
- [x] Web: Google Cast Web Sender (DMR `CC1AD845`), `lib/cast/google-cast.ts`, cast button in video player + music player, WebVTT with CORS
- [x] Server: DLNA/UPnP renderer control (`upnp-client-ts`), `/cast/devices`, `/cast/play` — Odyssey G8, any TV
- [x] Server: Home Assistant bridge (`HA_URL`/`HA_TOKEN`) — list `media_player.*`, `play_media`
- [x] Unified "Play on…" picker in web (browser Cast / DLNA / HA / MixAI TV devices)
- [ ] Phase 2 (later): Rust `rust_cast` sidecar for server-side Cast; CAF receiver ($5 dev account)

### Phase E — TV apps (ADR-0004)
- [x] `apps/tv-android`: Kotlin, Compose for TV, Media3/ExoPlayer, Leanback launcher, D-pad, Quick Connect login, browse/continue/play, subtitles, direct play w/ DeviceProfile
- [x] CI: `.github/workflows/tv-android-release.yml` → debug + release APK artifacts
- [x] Live test on the new Chromecast (find via HA `media_player.*` list) with `adb connect`
- [x] `apps/tv-tizen`: Vite web app .wgt reusing `apps/web` player, Tizen Studio build script, sideload to Odyssey G8 via `sdb`

### Phase F — OpenSubsonic (ADR-0005)
- [x] `/rest/*` router: ping, getLicense, getOpenSubsonicExtensions, getArtists/Albums/Song, search3, stream, getCoverArt, getPlaylists CRUD, scrobble, star, getLyricsBySongId, apiKeyAuthentication, transcodeOffset
- [ ] Tested with Feishin or Symfonium against homepi

### Phase G — codai (ADR-0006)
- [x] `packages/ai` `codaiAdapter` via `@ai-sdk/openai-compatible` → `https://ai.codai.ro/v1`, models `codai`, `codai-fast`, `codai-embed`, `codai-transcribe`, `codai-tts`
- [x] Model resolver: codai first, existing providers fallback; mock when no key
- [x] Key minting: `lib/codai-mgmt.ts` `POST https://api.codai.ro/apps/keys` with `CODAI_APP_TOKEN` (`{ok,data}` envelope!), stored per user; ephemeral tokens for browser
- [ ] First AI features: semantic library search (embeddings + sqlite-vec), Whisper subtitles job

### Phase H — Product gaps (music + video)
- Music: gapless (Web Audio handoff), ReplayGain scan (`ffmpeg -af ebur128`), LRCLIB lyrics, smart playlists, tag editing, sonic similarity
- Video: Media Segments (intro/outro) + skip button, PGS→SRT OCR at scan, HDR→SDR side version job, DeviceProfile-driven direct play decision, SyncPlay hardening (bounded waits, position beacons), Kodi NFO import/export, TVmaze fallback, Trakt behind flag (API paywalled)
- Both: offline downloads in TV/mobile, per-user profiles + parental PIN, backup/restore of DB

### Phase I — Distribution & licence (ADR-0007)
- [x] `LICENSE` → AGPL-3.0 for server/web core; `packages/sdk` MIT; `COMMERCIAL-LICENSE.md` scoped to cloud/Pro; `TRADEMARKS.md`
- [ ] Docker/GHCR, Windows installer (Companion), Linux deb/AppImage arm64, Pi one-liner `curl … | sh`
- [ ] Release cadence: monthly points, semver majors; CHANGELOG via changesets

## 3. Out of scope now (named, with reason)
- iOS app — needs Apple dev account + Xcode CI; user said later.
- Custom Cast receiver / Tizen store listing — needs paid dev accounts; phase 2.
- Rust server rewrite — rejected in ADR-0002.
- Paid tier — blocked on TMDB commercial licence decision (~$149/mo).
