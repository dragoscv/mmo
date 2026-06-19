# Plan — Cloud-Persistent Library with Availability States

## Goal

Make the music library **persist per account in the cloud** so it survives across
devices, while real audio playback comes from a **home device running the companion**:

- **Scan & import** media via the companion → metadata flows into the cloud DB.
- **Cloud Postgres is the source of truth** for library metadata.
- A track is shown as:
  - **connected** — a user device holding that file is online (playable via companion stream).
  - **offline** — the audio is pinned in the browser's IndexedDB cache (playable without companion).
  - **disconnected** — metadata exists but no online device and no offline cache (greyed, not playable).
- Sync is **real-time on every change**; dedup by **sha256** content hash.
- Audio files **stay on the home device** (no bulk cloud upload); only metadata + user-pinned offline blobs are stored client-side.

## Current architecture (as-is)

The library is **companion-centric**. Despite a fully-featured Postgres `tracks` table
existing, the web app never reads it:

- `apps/web/src/actions/tracks.ts` — every read proxies to the companion via
  `lib/companion-library.ts`; returns **empty** when no companion link. Header comment:
  *"the web app no longer reads or writes the tracks table directly."*
- `apps/web/src/actions/scan.ts` — ingests scanned tracks into the **companion SQLite**.
- `apps/web/src/lib/companion-library.ts` — HTTP client to companion `/library/*`.
- Result: open the app on another device with no companion → empty library / 500s.

Infrastructure that **already exists** and we reuse:

- **Postgres schema** (`apps/web/src/db/schema.ts`): `tracks` (with `sha256`,
  `fieldVersions` jsonb for per-field LWW, `syncVersion`, `externalId`,
  unique `tracks_user_sha_uniq`), `playlists`, `playlistTracks`, `deviceFolders`,
  `devices` (`status`, `lastSeenAt`, `lanUrl`, `syncCursor`).
- **Sync protocol**: `apps/web/src/app/api/sync/route.ts` (GET `?cursor` + POST),
  `lib/sync-apply.ts` (per-field last-write-wins). Companion side:
  `server/src/sync/cloud-sync-client.ts` + `server/src/sync/index.ts`
  (pull every 30s, debounced push).
- **Device auth**: `X-Device-Token` + `X-User-Id`; `app/api/devices/auto-register`;
  tokens encrypted at rest (`lib/device-token.ts`).
- **UI primitives**: `components/track-availability.tsx` (3-state badge, currently
  single-device), `hooks/use-offline.ts` (IndexedDB `mmo-offline`, not wired).

## Target architecture (to-be)

```
Companion (home device)                 Cloud (Postgres + Next.js)            Browser (any device)
─────────────────────────              ───────────────────────────          ──────────────────────
scan files → SQLite mirror             tracks (source of truth)             reads tracks from cloud
  │ push delta (realtime)      ──────► sync-apply (LWW)                      shows availability badge
  │ report file ownership      ──────► track_sources (deviceId+path)         play:
heartbeat presence (WS/SSE)    ◄─────► device presence channel                 connected → companion stream
stream audio on request        ◄─────────────────────────────────────────     offline   → IDB blob
                                                                               disconnected → greyed
```

## Decisions (locked with user)

| Topic | Decision |
|---|---|
| Source of truth | Cloud Postgres for metadata; companion pushes up |
| Audio storage | Stays on home device; companion streams; cloud = metadata + browser IDB |
| Sync trigger | Real-time on every change |
| Dedup identity | sha256 content hash |
| Track↔device link | New `track_sources` table (trackId/sha256 + deviceId + filepath) |
| Default no-device state | `disconnected` unless IDB-cached → `offline` |
| Presence | Dedicated websocket/SSE presence channel |
| Offline cache | User-pinned tracks: audio blob + metadata in IndexedDB |
| Scope | Full vertical slice |

## Work breakdown

### Phase 1 — Invert the read path (fixes empty/500 on other devices)
1. **`apps/web/src/db/schema.ts`** — confirm/extend `tracks` columns needed for display.
2. **`apps/web/src/actions/tracks.ts`** — rewrite reads (`getTracks`, `getTrackById`,
   `getGenres`, `getKeys`, stats) to query **Postgres via Drizzle**, filtered by `userId`.
   Remove the companion-proxy dependency for reads.
3. Keep write/scan path pushing to companion **and** ensure companion sync pushes to cloud
   (already wired) so cloud stays populated.
4. Verify the Library page renders from cloud with companion **off**.

### Phase 2 — Track ownership + availability model
5. **New table `track_sources`** in `schema.ts`: `id`, `userId`, `trackId` (fk),
   `sha256`, `deviceId` (fk), `filepath`, `lastSeenAt`. Unique `(deviceId, sha256)`.
   Generate migration (`pnpm db:generate`), run (`pnpm db:migrate`).
6. **Companion** (`server/src/sync/*`): report owned files (sha256 + path) to a new
   endpoint `app/api/library/sources` that upserts `track_sources`.
7. **Availability resolver** (server util): for each track, compute state from
   `track_sources` joined to `devices.status`/`lastSeenAt` (any online → connected) +
   client IDB pins (offline) → else disconnected.

### Phase 3 — Real-time presence channel
8. Add presence transport (decide WS vs SSE during impl; SSE simpler on Vercel).
   Companion heartbeat → updates `devices.status`/`lastSeenAt`; web subscribes for live
   availability updates. Reuse `device-token` auth.

### Phase 4 — Multi-source availability UI
9. **`components/track-availability.tsx`** — generalize from single `deviceId` to a list
   of sources + offline-pin state; show connected/offline/disconnected per decisions.
10. Wire into Library table rows (`apps/web/src/app/library/library-client.tsx`).

### Phase 5 — Offline cache (user-pinned)
11. **`hooks/use-offline.ts`** + IDB `mmo-offline` — store audio blob + metadata on
    explicit "Make available offline" action; expose pin state to availability resolver.
12. Player: resolve playable source — offline blob → online companion stream →
    else disabled.

### Phase 6 — Streaming resolution
13. Resolve a playable URL for "connected" tracks via the owning online device
    (`devices.lanUrl`/apiUrl/tunnel) on demand; fall back across multiple sources.

## Migration & safety notes
- New table + possible columns → use `pnpm db:generate` then `pnpm db:migrate`
  (expand→migrate→contract; additive only, no destructive drops).
- `tracks_user_sha_uniq` already enforces per-user dedup by sha256.
- Don't break existing companion SQLite sync; cloud becomes the authoritative read.

## Open questions / risks
- **Presence transport on Vercel**: long-lived WS isn't ideal on serverless; SSE or a
  separate small service (reuse `infra/yjs-relay`?) may be needed. Decide in Phase 3.
- **Stream auth across the public internet** when companion is only on LAN — may require
  the existing tunnel mechanism; confirm companion exposes a reachable stream URL.
- **sha256 availability**: confirm companion computes sha256 for every track (needed for
  `track_sources` dedup).

## Definition of done
- Library metadata visible on a second device with the home companion **off**.
- Each track shows correct connected/offline/disconnected state, updating live when the
  home companion goes on/offline.
- Pinned tracks play offline; connected tracks stream from the home device.
- No regression to existing scan/import; `pnpm typecheck` + build pass.
