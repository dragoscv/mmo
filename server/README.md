# 🖥️ MixAI Companion — Setup pentru dezvoltatori

> Setup, comenzi și convenții pentru lucrul la **MixAI Companion** (Electron desktop, `server/`).
> Pentru ghidul utilizatorului → [`docs/companion/`](../docs/companion/).
> Pentru arhitectura globală → [`docs/arhitectura/`](../docs/arhitectura/).

[🏠 Home](../README.md)

---

## 🎯 Ce este Companion-ul

App Electron desktop care rulează în background și expune un **server HTTP local pe `127.0.0.1:17899`**. Web app-ul (din browser) îl detectează la încărcare și activează features care necesită access nativ:

- 🎚️ **MIDI hardware** (DDJ-FLX4, Circuit Tracks, MIDI keyboards)
- 🔊 **Audio nativ low-latency** (audify pentru WASAPI/CoreAudio/ALSA)
- 📁 **Watch folders OS-level** (chokidar)
- 💿 **Scriere directă pe USB** (cu permisiuni native)
- 🔄 **Auto-update** prin GitHub Releases

---

## ⚡ Quick start

```bash
cd server
pnpm install
pnpm dev                            # compilează TS + pornește Electron
```

Companion-ul va porni cu o fereastră (UI minimal în `ui/`) și un server HTTP pe `127.0.0.1:17899`.

Verifică că funcționează:
```bash
curl http://127.0.0.1:17899/healthz
# → { "ok": true, "version": "0.9.5", "capabilities": [...] }
```

---

## 📦 Scripts

| Script | Ce face |
|--------|---------|
| `pnpm dev` | `pnpm ui:build` + `tsc-watch` → `electronmon .` |
| `pnpm ui:dev` / `pnpm ui:build` / `pnpm ui:typecheck` | Renderer-ul Vite + React din `ui/` (WP5): dev server HMR, build în `ui/dist/`, `tsc -p ui/tsconfig.json` |
| `pnpm build` | `pnpm ui:build && tsc` — produce **tot** ce intră în asar (`ui/dist/` + `dist/`) |
| `pnpm build:headless` | Doar `tsc` (Docker/Pi nu au renderer) |
| `pnpm start` | `electron dist/main.js` (presupune build făcut) |
| `pnpm dist:win` | Build NSIS installer pentru Windows x64 |
| `pnpm dist:mac` | Build DMG pentru macOS x64 + arm64 (cu ad-hoc signing) |
| `pnpm dist:linux` | Build AppImage + deb pentru Linux |
| `pnpm start:headless` | `node dist/headless.js` — serverul FĂRĂ Electron (Docker / Pi / systemd) |
| `pnpm rebuild:electron` | Recompilează `audify` pentru ABI-ul Electron (după `rebuild:node`) |
| `pnpm rebuild:node` | Recompilează `audify` pentru Node-ul de sistem (headless local). `better-sqlite3` 13 e N-API — același binar merge în Electron și Node, nu mai trebuie rebuild |

Output build: `server/release/` (ignorat în Git).

### Ce intră în `app.asar` (WP5-04)

`build.files` din `package.json`: `dist/**` (main + preload + server, CJS), `ui/dist/**`
(renderer-ul Vite, `base: "./"`, fără sourcemaps) și `assets/**`. Excluse explicit:
`src/`, `ui/src`, `ui/public`, `ui/index.html`, `ui/*.ts`, orice `*.ts`/`*.map`,
`tsconfig.json`, `vitest.config.ts`. Modulele native (`audify`, `better-sqlite3`,
`ffmpeg-static`, `ffprobe-static`) stau **în afara** asar-ului (`asarUnpack`).
`extraResources` copiază `python/`, `fpcalc`, `virtual-audio`, `cloudflared`, `bin/rbexport`.

Verificare locală rapidă (fără installer, ~2–4 min):

```powershell
pnpm build
pnpm exec electron-builder --dir --win --x64
pnpm exec asar list release/win-unpacked/resources/app.asar | Select-String 'ui/dist/index.html'
```

### Headless (Docker, Raspberry Pi)

Același cod rulează și ca proces Node 22 simplu, fără Electron / `audify`
(ADR-0002, `src/platform/` este singurul loc care atinge Electron):

```bash
MMO_HEADLESS=1 MMO_DATA=~/.local/share/mmo-server MMO_PORT=17899 MMO_MEDIA=/media/Music node dist/headless.js
# sau
docker build -f server/Dockerfile -t mmo-server:dev server
docker run --rm -p 17899:17899 -v mmo-data:/data -v /srv/media:/media:ro mmo-server:dev
```

Env: `MMO_PORT` (17899), `MMO_DATA` (dir config/db/logs), `MMO_MEDIA`
(foldere separate prin virgulă, înregistrate la primul boot dacă store-ul e gol),
`FFMPEG_PATH` / `FFPROBE_PATH` (altfel `ffmpeg-static`, apoi PATH).
Imaginea multi-arch (amd64 + arm64) e publicată de
`.github/workflows/mmo-server-docker.yml` la tag `server-v*` →
`ghcr.io/dragoscv/mmo-server`. Deploy pe Pi: `infra/pi/README.md`.

---

## 🗂️ Structura

```
server/
├── src/
│   ├── main.ts              Electron main process — window, tray, IPC handlers
│   ├── preload.ts           Bridge sigur renderer ↔ main (contextBridge)
│   ├── server.ts            Express HTTP server pe :17899
│   ├── store.ts             Settings persistente (`SettingsStore` JSON, `<userData>/config.json`)
│   ├── platform/            Singurul loc care atinge Electron (ADR-0002)
│   └── audio/               Native audio (audify) — playback, recording, devices
├── ui/                      Renderer Vite 8 + React 19 pe @mmo/ui (src/, vite.config.ts, tsconfig.json)
│   └── dist/                Build renderer (gitignored) — încărcat de main.ts, împachetat în asar
├── assets/                  Iconuri (icon.png pentru toate platformele)
├── scripts/
│   └── mac-adhoc-sign.js    Ad-hoc signing pentru macOS dist
├── release/                 Build output (gitignored)
├── dist/                    TS compiled (gitignored)
├── package.json             Configurație electron-builder
└── tsconfig.json
```

---

## 🛠️ Dependențe principale

| Pachet | Rol |
|---|---|
| `electron` 44 | Runtime (Chromium 152, Node 24) |
| `electron-builder` 26.15 | Build & dist |
| `electron-updater` | Auto-update din GitHub Releases |
| `express` 5 | HTTP server local (`path-to-regexp` v8: `/*name` wildcard, fără regex inline în rute) |
| `better-sqlite3` 13 | SQLite (N-API, prebuilt în tarball, Node ≥ 22) + `drizzle-orm` 0.45 |
| `cors` | CORS pentru web app origin |
| `ws` | WebSocket server (pentru SSE alternative) |
| `chokidar` 5 | Watch folders cross-platform (ESM-only → `import()` dinamic din build-ul CJS) |
| `music-metadata` 11 | Extragere metadate (ESM-only → `import()` dinamic) |
| `audify` | Native audio I/O (PortAudio binding) |

---

## 🔌 Endpoints HTTP expuse

| Endpoint | Method | Scop |
|----------|--------|------|
| `/healthz` | GET | Probe — returnează `{ ok, version, capabilities }` |
| `/audio/:id` | GET (Range) | Streaming audio file (cu seek) |
| `/file/copy` | POST | Copiază fișier (validate path, no `..`) |
| `/file/write` | POST | Scrie fișier (folosit pentru rekordbox XML) |
| `/scan/folders` | GET | Listează folderele watch-uite |
| `/scan/folders` | POST | Adaugă folder de watch |
| `/devices` | GET | Listează drive-uri & MIDI devices |
| `/midi/listen` | WS | WebSocket cu mesaje MIDI raw |
| `/yt-dlp/download` | POST | Descarcă track via yt-dlp (dacă e disponibil) |

> Toate endpoint-urile sunt limitate la `127.0.0.1` (loopback) și verifică `Origin` să fie `localhost:13789` sau `mixai.ro`.

---

## 🎧 OpenSubsonic API (`/rest/*`)

MMO Server expune API-ul Subsonic 1.16.1 + extensii OpenSubsonic (ADR-0005), deci
orice client Subsonic (Symfonium, Feishin, Amperfy, DSub, Supersonic, Music
Assistant…) poate reda biblioteca direct. Cod în `src/subsonic/`.

- URL server: `http://<host>:17899` · user: orice · **parolă = device token**
   (sau `apiKey=<device token>` — extensia `apiKeyAuthentication`).
- Răspuns XML implicit, JSON cu `f=json`; GET și POST form (`formPost`).
- Metode: ping, getLicense, getOpenSubsonicExtensions, getMusicFolders,
   getIndexes, getArtists, getArtist, getAlbum, getSong, getAlbumList2,
   getRandomSongs, getSongsByGenre, getGenres, search3, getStarred2, star/unstar,
   setRating, scrobble, getPlaylists/getPlaylist/createPlaylist/updatePlaylist/
   deletePlaylist, stream, download, getCoverArt, getLyricsBySongId, getUser,
   getScanStatus, startScan.
- Teste: `node node_modules/vitest/vitest.mjs run src/subsonic` cu Node 22 pe
   PATH (vitest 5; `better-sqlite3` 13 nu mai are nevoie de rebuild per runtime).

Ghid utilizator: `docs/aplicatie/opensubsonic.md`.

---

## 🔐 Securitate

- HTTP **doar pe loopback** (`127.0.0.1`), niciodată pe `0.0.0.0`
- CORS **allowlist** pentru web app origin
- Path validation: nu acceptăm path-uri cu `..` sau care nu sunt sub root configurat
- Device token: companion cere un JWT de la web app la pornire și îl include în request-uri inițiate de companion → web app
- macOS: ad-hoc signing (`scripts/mac-adhoc-sign.js`) — nu Apple Developer ID, deci utilizatorul vede warning Gatekeeper la prima rulare
- Auto-update verifică signature din GitHub Releases

---

## 🚢 Release flow

1. Bump versiunea în `server/package.json` (`3.0.0` → `3.0.1`) + intrare în `server/CHANGELOG.md`
2. Commit + push pe `main`
3. Workflow-ul `.github/workflows/companion-release.yml` pornește automat (job `detect`: build doar
   dacă nu există deja release `v<version>`)
   - Node 22 + pnpm 10, cache `~/.cache/electron` + `electron-builder`
   - `pnpm build` (Vite renderer → `ui/dist` + `tsc`), apoi `electron-builder` per OS
   - Upload în GitHub Releases la `dragoscv/mmo`
4. Utilizatorii primesc notificare auto-update la următoarea pornire (sau în 24h)

> **Notă**: electron-builder folosește versiunea din `package.json` ca tag git (`v3.0.0`), nu un custom prefix.

---

## 🐛 Troubleshooting

### `audify` nu compilează
```bash
# Linux:
sudo apt install build-essential libasound2-dev

# macOS:
xcode-select --install

# Windows:
# Necesită Visual Studio Build Tools
```

### Port 17899 ocupat
Schimbă în `src/server.ts` (constanta `PORT`). Dacă schimbi, actualizează și web app-ul (`apps/web/src/lib/native-companion.ts`).

### `better_sqlite3.node was compiled against a different Node.js version`
Nu ar mai trebui să apară de la 3.0.0: `better-sqlite3` 13 e N-API și încarcă
`node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, valabil pentru Electron
și Node ≥ 22 deopotrivă. Dacă apare, ai un `build/Release/better_sqlite3.node` vechi
(compilat local) care are prioritate doar când lipsește prebuild-ul — șterge folderul
`build/` și reinstalează. Pentru `audify` rămâne valabil `rebuild:node` / `rebuild:electron`.

### Auto-update eșuează în dev
`electron-updater` e dezactivat în dev mode (verificat prin `app.isPackaged`). Funcționează doar în builduri pachetate.

---

## 🔗 Linkuri

- 🏠 [README principal](../README.md)
- 📦 [Releases](https://github.com/dragoscv/mmo/releases)
- 🏗️ [Arhitectură companion](../docs/arhitectura/02-componente-suite.md#-mmo-companion-server)
- 📚 [Ghid user](../docs/companion/)
