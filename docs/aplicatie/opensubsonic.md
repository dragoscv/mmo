# OpenSubsonic — conectează orice player Subsonic la MMO Server

MMO Server (Companion pe desktop sau imaginea headless de pe Raspberry Pi)
implementează API-ul **Subsonic 1.16.1** cu extensiile **OpenSubsonic**
(ADR-0005). Asta înseamnă că poți folosi biblioteca ta din MixAI cu peste 50
de aplicații mature de muzică, fără nicio configurare pe server.

## Conectare

| Câmp | Valoare |
|------|---------|
| **Adresă server** | `http://<ip-sau-host>:17899` (ex. `http://homepi:17899`, `http://192.168.100.232:17899`) |
| **Utilizator** | orice text (ex. `mmo`) — nu este verificat |
| **Parolă** | **device token-ul** serverului |
| **API key** (opțional) | același device token, dacă clientul suportă *apiKeyAuthentication* |

### Unde găsesc device token-ul?

- **Companion (desktop)**: Setări → *Dispozitiv* → *Token* (copiază). Este
  același token pe care îl folosește web app-ul pentru `X-Device-Token`.
- **Headless / Pi**: în `<MMO_DATA>/config.json`, câmpul `deviceToken`
  (`/srv/homepi/mmo-data/config.json` pe instalarea standard cu Docker).

> Token-ul este secretul unic al serverului — îl folosești ca parolă, nu îl
> publica. Toate cele trei mecanisme Subsonic sunt acceptate:
> `apiKey=<token>`, `u`+`t`+`s` (`t = md5(token + s)`) și `u`+`p`
> (`p` în clar sau `enc:<hex>`).

### Clienți testați / recomandați

- **Symfonium** (Android) — *Add media provider → Subsonic*, activează
  *OpenSubsonic*; suportă sync offline (trimite `search3` cu query gol).
- **Feishin** (Windows/macOS/Linux) — *Add server → Subsonic*.
- **Amperfy** (iOS/macOS) — *Subsonic* → adresă + user + parolă.
- **DSub**, **Supersonic**, **Sonixd**, **Music Assistant** (Home Assistant).

Dacă rulezi pe LAN fără HTTPS, alege în client „permite HTTP” / „nesecurizat”.

## Metode suportate

| Categorie | Metode |
|-----------|--------|
| Sistem | `ping`, `getLicense`, `getOpenSubsonicExtensions` |
| Navigare | `getMusicFolders`, `getIndexes`, `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getGenres` |
| Liste | `getAlbumList2` (random, newest, alphabeticalByName, alphabeticalByArtist, frequent, recent, starred, byGenre, byYear), `getRandomSongs`, `getSongsByGenre`, `getStarred2` |
| Căutare | `search3` (query gol sau `*` = toată biblioteca) |
| Adnotare | `star`, `unstar` (id de piesă, album sau artist), `setRating`, `scrobble` |
| Playlist-uri | `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist` |
| Media | `stream` (Range, `timeOffset`), `download`, `getCoverArt`, `getLyricsBySongId` |
| Utilizator / scanare | `getUser`, `getScanStatus`, `startScan` |

Extensii OpenSubsonic anunțate: `apiKeyAuthentication`, `formPost`,
`songLyrics`, `transcodeOffset`.

Toate metodele acceptă `GET` și `POST` (form-urlencoded), cu sau fără sufixul
`.view`, iar formatul răspunsului este XML implicit sau JSON cu `f=json`.

### Identificatori

- piese: `tr_<id>` · albume: `al_<hash>` · artiști: `ar_<hash>` · playlist-uri: `pl_<id>`
- Albumele și artiștii sunt agregate din piese (`album` + `artist`, fără
  diferențe de majuscule); hash-urile rămân stabile între scanări.
- `coverArt` = `tr_…` sau `al_…` — se servește imaginea încorporată în tag-uri.

## Limite (deliberate)

- **Fără transcodare la cerere**: `maxBitRate` și `format` sunt ignorate,
  fișierul se trimite direct (Pi 5 nu are encoder hardware). Excepție:
  `timeOffset>0` folosește ffmpeg `-ss` (mp3/opus) dacă ffmpeg există.
- **Fără redimensionare cover** (`size` ignorat) — se returnează imaginea
  originală; piesele fără artwork încorporat răspund cu eroarea 70.
- **`scrobble` nu persistă**: tabela `tracks` nu are `play_count` /
  `last_played`, deci listele `frequent` / `recent` cad pe „newest”.
  `submission=false` (now playing) este no-op.
- **Un singur utilizator**: serverul deservește contul asociat dispozitivului
  (`userId` din config); `getUser` raportează rol admin.
- **Fără `getMusicDirectory`** (navigare pe foldere), podcast-uri, radio,
  share, bookmark-uri, play queue, chat, jukebox, avatar, video, `getArtistInfo*`,
  `getAlbumInfo*`, `getSimilarSongs*`, `getTopSongs`, `getNowPlaying`,
  `search`/`search2`, `getAlbumList`/`getStarred` (v1). Clienții moderni
  folosesc variantele „2/3”, care sunt implementate. Metodele lipsă răspund cu
  eroarea 70 și mesajul „Method not supported by this server”.

## Coduri de eroare

| Cod | Situație |
|-----|----------|
| 10 | parametru lipsă |
| 40 | user/parolă (token) greșite |
| 43 | `apiKey` și `u` trimise simultan |
| 44 | `apiKey` invalid |
| 70 | metodă necunoscută sau resursă inexistentă |
| 0 | eroare internă |

## Verificare rapidă

```powershell
curl.exe "http://homepi:17899/rest/ping.view?f=json&v=1.16.1&c=test&apiKey=<token>"
curl.exe "http://homepi:17899/rest/getOpenSubsonicExtensions?f=json&v=1.16.1&c=test&apiKey=<token>"
```

Răspuns așteptat: `{"subsonic-response":{"status":"ok","version":"1.16.1","type":"MixAI MMO Server",…,"openSubsonic":true}}`.
