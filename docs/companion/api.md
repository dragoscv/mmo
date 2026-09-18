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
| `subsonic` | `/rest/{view}` — o singură operație generică pentru API-ul OpenSubsonic | auth proprie prin query (`u`, `t`, `s` / `p`) |

**Autentificare.** Header `x-device-token: <deviceToken>` (obținut la pairing). Nu există
`Authorization: Bearer`. Rutele media/SSE acceptă și `?t=<token>&u=<userId>` (browserele nu pot
seta headere pe `<video>`/`EventSource`). Multe rute `/library`, `/voice`, `/plugins`,
`/mixai-profile` cer și `x-user-id`. Detalii în `info.description` din spec.

Schemele sunt precise acolo unde codul le arată (`res.json({...})`) și `additionalProperties: true`
pentru payload-urile pass-through (ex. metadate TMDB, config plugin-uri). Nu inventăm câmpuri.

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
`/voice`, `/cast`, `/pair`), normalizează parametrii Express 5 (`:id` → `{id}`, `*splat` → `{splat}`)
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
  `SubtitleTrack`, `SubtitleResult`, `Track`, `Playlist`, `PreRemuxJob`, `Error`, plus tot ce
  referențiază. Nullable → `T? = null`, arrays → `List<T>`, obiecte pass-through →
  `JsonObject`, nume ne-Kotlin → `@SerialName`. `MmoApi.kt` rămâne scris de mână (nu e rescris
  pe modelele generate — urmărit separat). Fără plugin Gradle: fișierul e commitat, build-ul rămâne
  un simplu `assembleDebug`.

## Reguli la modificarea API-ului

1. Schimbi/adaugi o rută în `server/src` → actualizezi `server/openapi.yaml` în același commit.
2. `pnpm openapi:check` + `pnpm openapi:lint` verzi.
3. `pnpm openapi:gen` → commitezi `Models.kt` și `mmo-server.d.ts` regenerate.
4. Bump `info.version` împreună cu `server/package.json#version`.
