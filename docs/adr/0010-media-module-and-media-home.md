# ADR-0010 — Server-owned media module and Media Home at `/`

- Status: Accepted · 2026-09-18
- Tracker: [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md) (D15–D24, WP10–WP14)
- Related: [ADR-0002](0002-mmo-server-headless-core.md) (headless core),
  [ADR-0004](../aplicatie/tv-android.md) (TV apps), [ADR-0009](0009-remove-third-party-embed-sources.md)

## Context

Until 2.0 the video half of MixAI was a thin viewer over **one** MMO Server: every `/watch/*`
page called a single `getCompanionLink()`, `video_files.device_id` was filled from an arbitrary
first `companion_devices` row, and a user with two servers (PC + Raspberry Pi) saw one library.
Recommendations were a client-side TMDB call from the web app (`video-recommendations.ts`) with
no history model; the TVs (Tizen, Android) each kept progress locally (seconds vs. milliseconds)
and had zero deep-link code, so a title that was not in the library was a dead end. The only
"play from elsewhere" path was the hidden pirate-embed builder removed in ADR-0009. Music had no
server-side play history at all (localStorage only).

Three architectural questions had to be answered at once: **where the brain lives** (TMDB client,
cache, recommendation scoring), **how deep links are resolved** (exact provider links vs. search
fallbacks), and **how progress is shared** across web, two TV platforms and N servers.

## Decision

1. **MMO Server is the brain** (D17). `server/src/media/` owns the TMDB client (v3/v4 auth, 30 req/s
   token bucket, `append_to_response`), the availability resolver, the recommendation engine, the
   video library index and progress/plays — all persisted in a per-server **SQLite** file
   (`media.sqlite`, `PRAGMA user_version` migrations). TTLs: details/images 30 d, recs 24 h,
   providers 24 h, MOTN 7 d, trending 6 h. Keys (`TMDB_API_KEY`, `MOTN_API_KEY`) live on the
   server; every integration is a **no-op without a key** (D24). Routes are mounted at `/media/*`
   behind the device token and documented in `openapi.yaml` (194 routes, drift-guarded).
2. **Deep links: MOTN → TMDB providers → registry search** (D18). Exact links come from Movie of
   the Night's Streaming Availability API (free tier, RO region, commercial use allowed) cached
   7 days; when absent, TMDB `watch/providers` (JustWatch-sourced, attribution required) names the
   provider and a static **provider registry** (Netflix, Disney+, HBO Max, Prime, Apple TV+,
   SkyShowtime, Voyo, AntenaPlay, YouTube, Google TV) supplies web / Android package / Tizen app
   launch data and a search URL. JustWatch's private GraphQL API is **not** used.
3. **Shared progress through the server** (D21). TVs and the web read/write seconds per profile via
   `GET/PUT /media/progress`; each write stamps a global `revision`, `?since=<rev>` returns deltas,
   and a debounced client pushes progress + plays to the web app's `POST /api/media/sync` (Bearer
   device token; last-writer-wins into `watch_history`, dedupe into `track_plays`). Local progress
   remains the offline fallback and is migrated once.
4. **Media Home at `/`** (D15, D16). The web root is a Media Home RSC: hero billboard, Watch rows
   fanned out over **all paired servers** and merged by TMDB id with `sources[]` and per-server
   chips, Listen rows from `track_plays`, and a unified title page `/media/[kind]/[tmdbId]` that
   shows "Play on <server>" when local and provider deep links otherwise. The old music dashboard
   moves to `/dashboard`. Both TV apps consume the same JSON (`MediaRepository.kt`, `lib/media.ts`).
5. **Trakt dropped** (D19). App registration requires Trakt VIP; the own history/watchlist/ratings
   model plus the sync above replaces it. The existing scrobble code stays env-gated and inert.
6. **Codai curator is optional** (D22/WP11-07): one `codai-fast` call per home revision, cached
   24 h, may retitle rows and add a one-line "why"; any failure leaves the rows untouched.

## Consequences

- **Positive.** One implementation of TMDB/recs/availability for three clients; keys never reach a
  browser or TV; multi-server is the default rather than a mode; progress round-trips web ↔ TV
  without a third-party account; the removed embed sources have a licensed replacement
  ("where to watch" deep links).
- **Costs.** Each MMO Server needs its own TMDB key (or shows empty rows); the web app must fan
  out to N servers and degrade per server (offline/outdated notices); MOTN's free tier is
  1 000 req/mo, so the 7-day cache is load-bearing; the static provider registry must be updated
  by hand when a Romanian provider changes its app id.
- **Data.** Web: `drizzle/0030_media_home.sql` (`track_plays`, `media_sync_state`) — expand-only,
  applied to production separately. Server: `media.sqlite` v2 (`rev` columns, tombstones).
- **Contract.** New route → `openapi.yaml` → `openapi:check` → `openapi:gen` (Kotlin `Models.kt`,
  TS `mmo-server.d.ts`); server 3.1.0, `@mmo/sdk` 0.1.0, TV apps 1.1.0, web 2.2.0.

## Alternatives considered

- **Web app as the brain** (TMDB + recs in Next.js, servers as dumb file hosts). Rejected — TVs
  then depend on the cloud for every row, keys are per-account instead of per-server, and offline
  LAN use (the Pi at home) breaks. It also duplicates the video index that the server already scans.
- **JustWatch GraphQL for exact deep links.** Rejected — undocumented, unlicensed for third-party
  use, and JustWatch's own terms only permit the attributed TMDB `link`. MOTN offers the same data
  under a published free tier.
- **Trakt for history/ratings/sync.** Rejected — app registration is VIP-only, and a third-party
  account would become mandatory for a feature that only needs our own two tables.
- **Per-TV local progress only (status quo).** Rejected — Android ms vs. Tizen s vs. web seconds
  already diverged and "continue watching" was per device.
