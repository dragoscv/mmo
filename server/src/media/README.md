# Modulul `media` — creierul Media Home (MMO Server)

Servește recomandări, disponibilitate pe platforme de streaming și progres de vizionare pentru web,
TV Android și Tizen. Vezi `docs/mixai-design-tracker.md` §10–§11 (WP10).

## Env

| Variabilă | Implicit | Rol |
|---|---|---|
| `TMDB_API_KEY` | — | cheie v3 (`?api_key=`) sau token v4 (începe cu `eyJ` → `Authorization: Bearer`). Fără ea modulul e no-op (`configured:false`, rânduri goale). |
| `MOTN_API_KEY` | — | Movie of the Night v4 (`https://api.movieofthenight.com/v4`, header `X-API-Key`). Opțional: deep-link-uri exacte. |
| `MEDIA_REGION` | `RO` | `watch_region` / `country` |
| `MEDIA_LANG` | `ro-RO` | `language` TMDB |

## Tabele (`<userData>/media.sqlite`, WAL, `PRAGMA user_version`)

`titles` (detalii TMDB, 30 z) · `availability` (MOTN 7 z / TMDB 24 h) · `recs_cache` (liste TMDB 6 h,
catalog provideri 24 h, rânduri Home 24 h, potriviri `match:` 30 z) · `progress` (secunde, per profil,
`completed` la ≥90 %, `rev`) · `track_plays` (`rev`) · `library_index` (fișiere locale ↔ TMDB id, `rev`) ·
`library_tombstones` · `meta` (`revision`, `library_etag`, `last_pushed_revision`). Schema v2.

## Endpoint-uri (`createMediaRouter`, montat la `/media` în `server.ts` după `authMiddleware`)

`GET /status` · `GET /home?profile=&region=&providers=8,337` · `GET /title/:kind/:tmdbId?region=&profile=` ·
`GET /search?q=` · `GET /library?since=<libraryEtag>` · `GET /progress?profile=&since=<revision>` ·
`PUT /progress` (obiect sau array 1..500) · `POST /plays` · `GET /plays?profile=&limit=` · `GET /etag` ·
`GET /providers?region=`. Detalii: `docs/companion/api.md` §`/media`.

## Index bibliotecă (`library.ts`, `library-hooks.ts`)

`video-scan-runner.ts`, `/video/scan` și `video-watcher.ts` apelează `mediaLibraryHooks()` (no-op până
`server.ts` instalează implementarea reală). `makeServerFileId` = același hash ca `makeFileId` din
`video-routes.ts`. Potrivirea TMDB (`matchTitle`) folosește `search/multi` + `pickMatch` (titlu exact,
an ±1, kind) și e cache-uită în `recs_cache`.

## Push progres → web (`sync-client.ts`)

`PUT /progress` și `POST /plays` → `schedule()` (debounce 10 s) → `POST {webAppUrl}/api/media/sync`
cu `Authorization: Bearer <deviceToken>`; push complet orar. Watermark `meta.last_pushed_revision`.
404/offline → reîncercare; 401/403 → pauză până se schimbă token-ul.

## Atribuire

Ofertele din TMDB `watch/providers` provin de la **JustWatch** (`attribution: ["JustWatch"]`);
cele din MOTN → `["Movie of the Night"]`.

## Teste

```powershell
& "$env:APPDATA\fnm\node-versions\v22.23.2\installation\node.exe" node_modules\vitest\vitest.mjs run src/media
```
