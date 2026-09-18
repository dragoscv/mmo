# 📡 MMO Server — API HTTP (OpenAPI 3.1)

> Specificația completă a API-ului local al companion-ului (Express 5, port `17899`) trăiește în
> [`server/openapi.yaml`](../../server/openapi.yaml). Din ea se generează clientul TypeScript
> (`@mmo/sdk/mmo-server`) și modelele Kotlin ale aplicației Android TV.

[🏠 Home](../../README.md) · [🖥️ Companion](README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

## Ce acoperă

| Tag | Rute | Auth |
|-----|------|------|
| `health`, `metrics` | `/health`, `/host-info`, `/logs`, `/metrics` | fără token (`/health`) / token |
| `pair` | `/pair/request`, `/pair/poll`, `/pair/info` (publice), `/pair/approve`, `/pair/pending`, `/pair/deny` | token doar pe approve/pending/deny |
| `library` | `/library/*` — tracks, playlists, drives, stems, analiză | token + `x-user-id` |
| `video`, `watch-party` | `/video/scan`, `/video/file/{fileId}/*`, HLS, subtitrări, `/video/thumbs/{fileId}/sprite.jpg`, TMDB, rooms | token (stream-urile acceptă `?t=&u=`) |
| `audio`, `audio-native` | `/audio/*`, `/audio/native/*` | token / loopback-only |
| `download`, `fs`, `folders`, `scan` | descărcare fișiere, browsing FS, foldere de scan, joburi | token |
| `voice`, `render`, `projects`, `plugins`, `cast`, `profile`, `sync` | clonare voce/TTS, render joburi, assets, VST, DLNA/HA, profil, push cloud→companion | token |
| `media` | `/media/*` — creierul Media Home: recomandări TMDB, disponibilitate streaming, index bibliotecă video, progres vizionare, ascultări | token (inclusiv `/media/status`) |
| `subsonic` | `/rest/{view}` — o singură operație generică pentru API-ul OpenSubsonic | auth proprie prin query (`u`, `t`, `s` / `p`) |

**Autentificare.** Header `x-device-token: <deviceToken>` (obținut la pairing). Nu există
`Authorization: Bearer`. Rutele media/SSE acceptă și `?t=<token>&u=<userId>` (browserele nu pot
seta headere pe `<video>`/`EventSource`). Multe rute `/library`, `/voice`, `/plugins`,
`/mixai-profile` cer și `x-user-id`. Detalii în `info.description` din spec.

Schemele sunt precise acolo unde codul le arată (`res.json({...})`) și `additionalProperties: true`
pentru payload-urile pass-through (ex. metadate TMDB, config plugin-uri). Nu inventăm câmpuri.

## `/media` — Media Home (WP10)

Implementare: `server/src/media/` (vezi `README.md` de acolo și tracker §10–§11). Toate rutele cer
`x-device-token`; `/media/status` **nu** e public ca `/video/probe`, pentru că dezvăluie configurarea
cheilor și dimensiunea bibliotecii — prezența serverului se verifică pe `/pair/info` sau
`/video/probe` (care listează capabilitățile `media.home`, `media.library`, `media.progress`,
`media.plays`). Fără `TMDB_API_KEY` modulul răspunde 200 cu rânduri goale (`configured:false`).

| Rută | Rol |
|------|-----|
| `GET /media/status` | `MediaStatus`: chei configurate (booleeni), regiune/limbă, `revision`, `libraryEtag`, `libraryCount`, `serverId`, `serverName`, stare push (`sync.lastPushedRevision`, `sync.last`) |
| `GET /media/etag` | `{revision, libraryEtag}` — poll ieftin |
| `GET /media/home?profile=&region=&providers=&force=1` | `MediaHome`: rânduri (`continue`, trending, „pentru că ai văzut”, provideri, în bibliotecă) + `serverId`/`serverName` pentru atribuire multi-server |
| `GET /media/title/{kind}/{tmdbId}?region=&profile=` | `MediaTitleResponse`: detalii TMDB, `availability` (oferte + `launch` web/android/tizen + `attribution`), fișiere locale (`files[].serverFileId` = id-ul de la `/video/direct/{fileId}`), progres |
| `GET /media/search?q=&page=` | căutare TMDB multi; `inLibrary:true` pe titlurile prezente local |
| `GET /media/library?since=<libraryEtag>` | `LibraryIndex`: fără `since` → tot indexul (`full:true`); cu `since` → doar rândurile cu `rev > since` + `removed[]` (tombstones). Populat de `/video/scan`, de joburile `POST /scan` (kind video) și incremental de watcher-ul chokidar; `tmdbId` e potrivit best-effort prin TMDB search (cache 30 z) când există cheie |
| `GET /media/providers?region=` | catalogul de provideri TMDB pentru regiune, cu date de lansare |
| `GET /media/progress?profile=&kind=&tmdbId=&since=<revision>&limit=` | progres per profil; `since` = watermark de revizie (direcția web → TV) |
| `PUT /media/progress[?profile=]` | upsert un `ProgressInput` **sau** un array de 1..500; `completed` derivat la ≥ 90 %; LWW pe `updatedAt`; fiecare scriere incrementează `revision` și programează un push |
| `POST /media/plays`, `GET /media/plays?profile=&limit=` | ascultări muzică (`trackKey`, `durationSec`, `completed`) |

**Push către web** (`server/src/media/sync-client.ts`): după orice scriere de progres/ascultare, un
push debounced (10 s) la `POST {webAppUrl}/api/media/sync` cu `{deviceId, revision, since, full,
progress[], plays[]}` și `Authorization: Bearer <deviceToken>` (același model ca `sync/cloud-sync-client.ts`);
push complet la fiecare oră. Watermark `meta.last_pushed_revision` avansează doar la 2xx; 404 (endpoint-ul
web nu există încă) și erorile de rețea lasă watermark-ul neatins și reîncearcă; 401/403 opresc push-urile
până se schimbă token-ul. Starea e vizibilă în `/media/status.sync`.

Schema `media.sqlite` e versionată prin `PRAGMA user_version` (v2 adaugă `rev` pe `progress`,
`track_plays`, `library_index`, tabela `library_tombstones` și `meta.last_pushed_revision`).

## Vizualizare

```powershell
cd server
pnpm openapi:preview          # redocly preview-docs → http://127.0.0.1:8080
pnpm openapi:lint             # redocly lint (0 erori; avertismentele sunt raportate)
```

## Drift guard (`pnpm openapi:check`)

`server/scripts/openapi-check.mjs` parcurge `server/src/**/*.ts` (fără teste), extrage fiecare
`app|router.get|post|put|patch|delete|all("/…")`, aplică prefixul de mount din tabela `MOUNTS`
(`/library`, `/video`, `/rest`, `/v1/sync`, `/projects`, `/mixai-profile`, `/plugins`, `/render`,
`/voice`, `/cast`, `/pair`, `/media`), normalizează parametrii Express 5 (`:id` → `{id}`, `*splat` → `{splat}`)
și compară cu `paths` din YAML în ambele sensuri. Verifică și `info.version == server/package.json#version`.
Iese cu `1` la orice diferență → rulează-l în CI / pre-commit când atingi `server/src`.

Dacă adaugi un router nou montat pe alt prefix, adaugă-l în `MOUNTS`, altfel scriptul aruncă
`… has no mount prefix in openapi-check.mjs MOUNTS`.

## Regenerare clienți (`pnpm openapi:gen`)

```powershell
cd server
pnpm openapi:gen
#  1. node scripts/openapi-kotlin.mjs
#     → apps/tv-android/app/src/main/java/ro/mixai/tv/data/generated/Models.kt
#  2. pnpm --dir ../packages/sdk gen:openapi
#     → packages/sdk/src/generated/mmo-server.d.ts (openapi-typescript)
```

- **TypeScript** — `packages/sdk/src/mmo-server.ts` exportă
  `createMmoServerClient({ baseUrl, token, userId })` peste `openapi-fetch`; tipurile vin din
  `src/generated/mmo-server.d.ts`. `openapi-typescript` rulează din `server/` pentru că cere
  TypeScript 5.x ca peer, iar `packages/sdk` e pe TS 7. Test: `pnpm --dir packages/sdk test`.
- **Kotlin** — `openapi-kotlin.mjs` emite `@Serializable data class`-uri (kotlinx.serialization)
  pentru schemele folosite de TV: `Health`, `Pair*`, `VideoScanResult`, `VideoFile`, `VideoInfo`,
  `SubtitleTrack`, `SubtitleResult`, `Track`, `Playlist`, `PreRemuxJob`, `Media*`, `HomeRow`,
  `TitleCard`, `TitleDetails`, `Availability`, `Offer`, `LaunchData`, `LibraryIndex*`, `Progress*`,
  `TrackPlay*`, `ProviderCatalog`, `Error`, plus tot ce
  referențiază. Nullable → `T? = null`, arrays → `List<T>`, obiecte pass-through →
  `JsonObject`, nume ne-Kotlin → `@SerialName`. `MmoApi.kt` rămâne scris de mână (nu e rescris
  pe modelele generate — urmărit separat). Fără plugin Gradle: fișierul e commitat, build-ul rămâne
  un simplu `assembleDebug`.

## Reguli la modificarea API-ului

1. Schimbi/adaugi o rută în `server/src` → actualizezi `server/openapi.yaml` în același commit.
2. `pnpm openapi:check` + `pnpm openapi:lint` verzi.
3. `pnpm openapi:gen` → commitezi `Models.kt` și `mmo-server.d.ts` regenerate.
4. Bump `info.version` împreună cu `server/package.json#version`.
