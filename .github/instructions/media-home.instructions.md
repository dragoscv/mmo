---
applyTo: "apps/web/src/lib/media/**, apps/web/src/app/(home)/**, server/src/media/**, apps/tv-android/**/media*, apps/tv-tizen/**/media*"
description: "Media Home architecture (tracker §10, WP10–WP12): MMO Server is the brain, TTLs, provider registry, attribution, no pirate embeds"
---

# Media Home (Watch + Listen) — tracker §9–§11, decisions D15–D24

## Architecture (server is the brain — D17)
```
web (Next 16) ──/media/* (x-device-token)──▶ MMO Server A ──▶ TMDB / MOTN (keys on the server, SQLite cache)
  │ fan-out to N paired servers, dedupe by tmdbId, sources[] + per-server chips   ◀── TV Android / Tizen
  └──▶ Postgres (profiles, history mirror, track_plays, prefs) ◀── sync server→web on change + hourly
```
- `server/src/media/`: `tmdb.ts` (bearer, limiter ~40 req/s, `append_to_response` ≤ 20), `availability.ts`,
  `providers.ts` (registry), `recs.ts`, `progress.ts`, `library.ts` (video index + etag), `routes.ts`.
  Store: `media.sqlite` (titles, providers, recs_cache, progress, track_plays, library_index).
- Routes (WP10-07): `/media/home`, `/media/title/:kind/:id`, `/media/search`, `/media/etag`,
  `/media/library?since=`, `/media/progress` GET/PUT (seconds, per profile), `/media/plays`. Every response
  carries `serverId` for attribution. Spec them in `server/openapi.yaml` → `openapi:check` → `openapi:gen`.
- Env on the server: `TMDB_API_KEY`, `MOTN_API_KEY`, `MEDIA_REGION` (default `RO`). **All integrations no-op
  cleanly without keys** (D24: the user creates keys in a browser and provides them out-of-band).
- Web: `/` = `MediaHome` RSC (D15; old dashboard → `/dashboard`), `lib/media/aggregate.ts` fan-out via
  `aggregateAcrossCompanions`, merge by `tmdbId` → `sources[]`; `HeroBillboard`, `MediaRow` (embla, keyboard/D-pad,
  virtualised > 40), `/media/[kind]/[tmdbId]` title page. Migration `track_plays` + `media_sync_state` (expand-only).
- TVs consume the same JSON. Android: `ProviderLauncher` + `<queries>`, Watch Next channel. Tizen: `launch.ts`
  (`launchAppControl(view,url)`, `getAppInfo`, `application.launch` privilege). Progress via server with a local
  fallback queue; one-shot migration of local progress (D21).

## Cache TTLs (fixed — do not invent others)
details/images **30 d** · recs **24 h** · TMDB watch/providers **24 h** · MOTN availability **7 d** · trending **6 h**.
Curator (codai, env-gated, WP11-07) rows **24 h**.

## Availability chain (D18) and attribution
1. Movie of the Night Streaming Availability v4 `GET /shows/movie/{tmdbId}?country=ro` → `streamingOptions.ro[]`
   `{service, type, link}` (free tier 1 000 req/mo — cache 7 d, never per render).
2. Fallback: TMDB `watch/providers` (logos + JustWatch page link).
3. Fallback: provider registry search URL.
**No JustWatch GraphQL** (unofficial). Attribution required on any surface that shows the data: TMDB logo +
"This product uses the TMDB API but is not endorsed or certified by TMDB"; JustWatch credit next to TMDB
provider data; MOTN credit where its links are used.
Registry (WP10-03): Netflix, Disney+, HBO Max, Prime Video, Apple TV+, SkyShowtime, Voyo, AntenaPlay, YouTube,
Google TV — each with web URL, Android package (verify with `adb shell pm list packages`; Voyo unverified) and
Tizen app id.

## Recommendations (WP10-04)
Profile vector from watched/ratings; RRF over TMDB recs of the last 15 titles; weighted-rating prior; exclude
watched/owned/dismissed; ≤ 2 per collection; cold start = trending RO. Rows: Continue, Top picks, Because you
watched ×3, Trending RO on your providers, Upcoming RO, New in library. Watched = ≥ 90 % or manual.

## Hard rules
- **No pirate embeds** (D20, ADR-0009): `streaming-scrapers.ts`, `/video/streams`, `StreamSourcePicker`, the vidsrc
  flag are removed — never reintroduce embed/scraper URLs. Deep links go only to legitimate providers.
- Trakt is dropped (D19): own history/watchlist/ratings; existing scrobble stays env-gated no-op.
- Keys live on the server only; web never calls TMDB/MOTN directly for Media Home (legacy `lib/tmdb.ts` for
  `/watch/*` is being migrated, not extended).
- Multi-server: aggregate by default (D16); unreachable server = chip state, never a thrown page.
- Profile-scoped progress/history; seconds on the wire (Android converts ms).
- i18n RO+EN for every new string; rows `role="list"`, focus visible, reduced motion honoured (WP11-08).

## Verify
- Server: `pnpm -C server test` covers recs scoring, availability chain, progress upsert, routes (WP10-09);
  `pnpm -C server openapi:check` clean after route changes.
- Without keys: `curl.exe -H "x-device-token: …" http://127.0.0.1:17899/media/home` → 200 with empty external
  rows, not 500.
- Web: aggregate merge + row builder tests; e2e home at 4 widths light/dark (WP11-09). Devices: Google TV
  192.168.100.31 and Odyssey 192.168.100.135 open Netflix/YouTube from a title; progress round-trips web↔TV (WP12-03).
