# 🖥️ MMO Companion — Ghid utilizator

> Aplicația desktop (MMO Server / MixAI Companion) care extinde MixAI cu capabilități native: MIDI, audio low-latency, watch folders, scriere USB.

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

## 📚 Documente

| Document | Subiect |
|----------|---------|
| [instalare.md](instalare.md) | Cum instalezi pe Windows / macOS / Linux |
| [api-local.md](api-local.md) | Endpoints HTTP locale expuse pe `:17899` |
| [ipc-protocol.md](ipc-protocol.md) | Protocol IPC main ↔ renderer |
| [audio-pipeline.md](audio-pipeline.md) | Pipeline audio nativ (audify) |
| [auto-update.md](auto-update.md) | Cum funcționează auto-update prin GitHub Releases |

> Aceste ghiduri sunt în curs de scriere. Pentru setup dev → [`server/README.md`](../../server/README.md).

---

## ⚡ Cea mai rapidă cale

```bash
# 1. Descarcă pentru OS-ul tău:
#    https://github.com/dragoscv/mmo/releases/latest
#
#    - Windows:  MMO-Companion-Setup-X.Y.Z.exe
#    - macOS:    MMO-Companion-X.Y.Z-arm64.dmg (Apple Silicon)
#                MMO-Companion-X.Y.Z-x64.dmg   (Intel)
#    - Linux:    MMO-Companion-X.Y.Z.AppImage
#                mmo-companion_X.Y.Z_amd64.deb

# 2. Rulează installer / mount DMG / chmod +x AppImage

# 3. La pornire, deschide MixAI (web):
#    https://mixai.ro
#    → bara laterală arată "✓ Companion connected"
```

---

## 🖥️ Rulare headless pe PC (Windows)

Același cod de server (port 17899, mDNS `_mmo-companion._tcp`, Quick Connect
`/pair/*`, `/video/*`) poate rula ca proces Node 22 simplu, fără Electron —
util când vrei ca PC-ul să servească filmele către MixAI TV fără să deschizi
aplicația desktop și fără jonglat ABI-ul `better-sqlite3` (Electron ↔ Node).

```powershell
# porneste (detached, log în .copilot-tmp/companion-local.log, pid în companion-local.pid)
pwsh -NoProfile -File scripts/run-companion-local.ps1 -Media 'D:\Movies,D:\TV Shows,H:\Music'

# opreste instanța anterioară
pwsh -NoProfile -File scripts/run-companion-local.ps1 -Stop

# firewall (o singură dată, cere UAC): TCP 17899 + UDP 5353 (mDNS)
Start-Process explorer.exe scripts\firewall-companion.cmd
```

Parametri: `-Media` (foldere separate prin virgulă — cu `-File` dă-le ca UN
string), `-Port` (17899), `-Data` (`%APPDATA%\mixai-companion-headless`;
`config.json` de acolo conține `deviceToken`), `-NodeExe`, `-Build` (rulează
`tsc`). Folderele din `-Media` sunt înregistrate doar la **prima pornire** cu
un `-Data` gol; ca să le schimbi, șterge folderul de date sau editează
`scanFolders` în `config.json`.

Verificare: `curl.exe http://127.0.0.1:17899/health` și `/pair/info` (`lanUrl`
trebuie să fie IP-ul din LAN, nu un bridge Hyper-V/WSL). Scanarea video:
`POST /video/scan {}` cu header `x-device-token`. Pe TV: Welcome → „Connect to a
server on this network” → cardul `<hostname> · <ip>:17899` → cod din 6 cifre →
`POST /pair/approve {code}` cu același token (sau mixai.ro/pair).

Capcană Windows: `bonjour-service` face bind pe `0.0.0.0` și lasă OS-ul să
aleagă interfața de multicast — pe un host cu Hyper-V/WSL/Docker pleacă pe
bridge-ul virtual și LAN-ul nu vede anunțul. `lan-announce.ts` fixează socketul
mDNS pe NIC-ul cu default route și publică un singur A record (IP-ul din LAN).

---

## 🎨 Interfața desktop (renderer)

Fereastra Electron este o aplicație **Vite 8 + React 19** în `server/ui/`, pe
design system-ul comun (`packages/design-tokens` + `packages/ui`, Base UI,
Tailwind v4). Nu are `package.json` propriu — dependențele stau în
`server/package.json` (devDependencies) și există un singur lockfile.

| Comandă (în `server/`) | Efect |
|---|---|
| `pnpm ui:dev` | Vite dev server (în browser, fără `window.mmo` — util doar pentru layout) |
| `pnpm ui:build` | Generează `ui/dist/` (≈ 650 KB, încărcat de Electron prin `loadFile("../ui/dist/index.html")`, `base: "./"`) |
| `pnpm ui:typecheck` | `tsc --noEmit -p ui/tsconfig.json` |
| `pnpm build` / `pnpm dev` / `pnpm dist:*` | rulează întâi `ui:build`, apoi `tsc` (main process) |

Structură: `ui/index.html` (splash inline pe `tokens.plain.css` + `prehydrate.js`,
fără flash, respectă `prefers-reduced-motion`), `ui/src/main.tsx`
(`ThemeProvider` → `CompanionI18nProvider` → `ToastProvider`), `ui/src/App.tsx`
(rute în state local: Auth / Main / Audio Setup), `ui/src/lib/ipc.ts` (tipul
`window.mmo` derivat din `server/src/preload.ts` — 24 metode + `va.*` cu 8;
**UI-ul apelează exact această suprafață, nimic în plus**), `ui/src/i18n/`
(RO+EN, `uiMessages` din `@mmo/ui` + 143 chei proprii; limba = `prefs.locale`).

Comportamente păstrate din vechiul renderer: poll de siguranță la 3 s pentru
`get-status` (plus push `status-changed` / `auth-invalidated`), meter latență la
4 Hz cu pauză pe `visibilitychange`, evenimente `update-status`
(checking/current/available/downloading/ready/error) cu buton „Instalează și
repornește”, fluxurile `va.*` (probe/install/uninstall/list/create/rename/
setEnabled/remove) cu erorile afișate utilizatorului (UAC/sudo anulat).

Titlebar-ul draggable (`-webkit-app-region: drag`) se randează **doar pe macOS**
(`titleBarStyle: hiddenInset`); pe Windows/Linux se folosește rama nativă —
asta elimină vechiul „double frame”.

Tema: `mode: "system"` se rezolvă prin `prefers-color-scheme`, pe care Electron
îl leagă deja de `nativeTheme`; handler-ele IPC `get-theme` / `theme-updated`
rămân în main.ts doar pentru `BrowserWindow.backgroundColor`.

---

## 🤔 De ce am nevoie de Companion?

| Capabilitate | Doar web app | Cu Companion |
|---|---|---|
| Browse bibliotecă | ✅ | ✅ |
| Mix DJ basic | ✅ | ✅ |
| Hardware MIDI (DDJ-FLX4, etc.) | ⚠️ Web MIDI cu limitări | ✅ Native, low-latency |
| Audio low-latency | ⚠️ ~20ms | ✅ ~5ms |
| Watch folders OS-level | ❌ | ✅ |
| Scriere directă USB CDJ | ❌ | ✅ |
| Auto-import din download | ⚠️ manual | ✅ automat |

---

## 🔐 Securitate & confidențialitate

- Companion-ul **nu trimite date** spre internet decât pentru auto-update (GitHub) și pentru a se conecta la web app-ul tău
- HTTP server-ul ascultă **doar pe loopback** (`127.0.0.1`) — niciun alt computer din rețea nu poate accesa
- Toate fișierele rămân local, sub controlul tău
- Open source — codul e [aici](https://github.com/dragoscv/mmo/tree/main/server)

---

[🏠 Home](../../README.md)
