# 🖥️ MMO Companion — Setup pentru dezvoltatori

> Setup, comenzi și convenții pentru lucrul la **MMO Companion** (Electron desktop, `server/`).
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
| `pnpm dev` | `tsc && electron dist/main.js` |
| `pnpm build` | `tsc` (doar compilare TS) |
| `pnpm start` | `electron dist/main.js` (presupune build făcut) |
| `pnpm dist:win` | Build NSIS installer pentru Windows x64 |
| `pnpm dist:mac` | Build DMG pentru macOS x64 + arm64 (cu ad-hoc signing) |
| `pnpm dist:linux` | Build AppImage + deb pentru Linux |

Output build: `server/release/` (ignorat în Git).

---

## 🗂️ Structura

```
server/
├── src/
│   ├── main.ts              Electron main process — window, tray, IPC handlers
│   ├── preload.ts           Bridge sigur renderer ↔ main (contextBridge)
│   ├── server.ts            Express HTTP server pe :17899
│   ├── store.ts             Settings persistente (electron-store)
│   └── audio/               Native audio (audify) — playback, recording, devices
├── ui/                      Renderer UI (HTML/JS minimal, opțional)
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
| `electron` | Runtime |
| `electron-builder` | Build & dist |
| `electron-updater` | Auto-update din GitHub Releases |
| `electron-store` | Settings persistente (encrypted la nevoie) |
| `express` | HTTP server local |
| `cors` | CORS pentru web app origin |
| `ws` | WebSocket server (pentru SSE alternative) |
| `chokidar` | Watch folders cross-platform |
| `music-metadata` | Extragere metadate (la fel ca în web app) |
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

> Toate endpoint-urile sunt limitate la `127.0.0.1` (loopback) și verifică `Origin` să fie `localhost:3000` sau `muzicai.ro`.

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

1. Bump versiunea în `server/package.json` (`0.9.5` → `0.9.6`)
2. Commit + push pe `main`
3. Trigger workflow GitHub Actions: `.github/workflows/companion-release.yml`
   - Build pentru toate platformele
   - Upload în GitHub Releases la `dragoscv/mmo`
4. Utilizatorii primesc notificare auto-update la următoarea pornire (sau în 24h)

> **Notă**: electron-builder folosește versiunea din `package.json` ca tag git (`v0.9.6`), nu un custom prefix.

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
Schimbă în `src/server.ts` (constanta `PORT`). Dacă schimbi, actualizează și web app-ul (`app/src/lib/native-companion.ts`).

### Auto-update eșuează în dev
`electron-updater` e dezactivat în dev mode (verificat prin `app.isPackaged`). Funcționează doar în builduri pachetate.

---

## 🔗 Linkuri

- 🏠 [README principal](../README.md)
- 📦 [Releases](https://github.com/dragoscv/mmo/releases)
- 🏗️ [Arhitectură companion](../docs/arhitectura/02-componente-suite.md#-mmo-companion-server)
- 📚 [Ghid user](../docs/companion/)
