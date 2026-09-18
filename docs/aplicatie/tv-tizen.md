# 📺 MixAI TV pentru Samsung Tizen

> Aplicație web Tizen (`.wgt`) pentru televizoare/monitoare Samsung Smart Hub (ex. Odyssey OLED G8).
> Se conectează la **MMO Server** din rețeaua locală și redă filme + muzică pe ecranul mare.
> Cod: [`apps/tv-tizen/`](../../apps/tv-tizen/README.md) · decizie: [ADR-0004](../adr/0004-tv-apps-compose-media3-and-tizen-web.md).

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md) · [⬅️ Aplicație](README.md)

---

## Ce face

| Ecran | Conținut |
|---|---|
| **Bun venit** | Prima pornire: două carduri — **Conectare cu contul MixAI** *(recomandat)* și **Conectare la un server din această rețea** (Quick Connect local). Cu server salvat ecranul e sărit. BACK închide aplicația. |
| **Cont MixAI** | Cod de **8 caractere** (`ABCD-1234`) + QR + cronometru; „Deschide mixai.ro/activate pe telefon”. La confirmare, TV-ul primește sesiunea și lista serverelor tale și se conectează automat la primul care răspunde. |
| **Descoperire** | Caută automat MMO Server în rețea și afișează fiecare server găsit ca un card (nume, adresă, versiune). Zero tastare. „Introdu adresa manual” rămâne ca alternativă secundară. |
| **Quick Connect** | Cod din **6 cifre** + QR + cronometru. Îl introduci în MMO Server → *Quick Connect* (sau scanezi QR-ul cu telefonul → `mixai.ro/pair`). La aprobare TV-ul primește token-ul și trece la Acasă. |
| **Conectare manuală** | IP-ul serverului (portul 17899 se completează automat), *device token*, user ID opțional. |
| **Acasă** | **Media Home** (server ≥ 3.1 cu `/media/*`): billboard erou (backdrop, titlu, meta, „Redă” / „Unde vezi”, rotește la 12 s, pauză cât e focalizat) + un rând pe fiecare `HomeRow` de la server (Continuă vizionarea, Alese pentru tine, Pentru că ai văzut…, În trend, În bibliotecă) cu postere 2:3, bară de progres și eticheta „În bibliotecă”. Dedesubt rândurile clasice: Filme · Seriale · Albume noi · Ascultate recent · Setări. Server vechi (404 pe `/media/*`) → doar rândurile clasice. |
| **Titlu** | Backdrop + poster + sinopsis + meta (durată, sezoane, gen, rating). **Surse**: „Redă de pe <server>” per fișier local (cu „Continuă de la mm:ss” din progresul de pe server). **Unde vezi**: un buton per ofertă (logo, nume, tip abonament/închiriere/gratuit, `instalat`/`neinstalat`) → deschide aplicația providerului. „Marchează văzut” → `PUT /media/progress {completed:true}`. Rânduri Similare / Recomandate. |
| **Album** | Lista pieselor; OK pornește redarea de la piesa aleasă, cu coadă până la finalul albumului. |
| **Player** | Video (direct MP4 sau HLS) și audio (Subsonic `stream`). ±10 s, pauză, subtitrări WebVTT, piesa următoare/anterioară. |

La pornire: server salvat → **Acasă** direct; dacă `GET /health` nu răspunde → ecranul de descoperire
cu serverul salvat pre-selectat (card „Salvat anterior”).

## Conectare cu contul MixAI (`lib/device-auth.ts`, `screens/SignIn.tsx`)

Flux OAuth *device code* contra originii `localStorage["mixai.origin"]` (implicit `https://mixai.ro`):

1. `POST {origin}/api/device/code {deviceName, platform:"tizen", appVersion}` →
  `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}`.
2. `POST {origin}/api/device/token {device_code}` la fiecare `interval` s:
  `428 authorization_pending` → continuă · `403 slow_down` → +5 s · `403 access_denied` → „Conectarea a fost
  refuzată” · `410 expired_token` → „Codul a expirat” + **Cod nou** · alt cod (ex. 404) →
  „Nu am putut contacta mixai.ro (404)” + **Reîncearcă** / Înapoi.
3. La `200 {session_token, expires, user, companions[]}` sesiunea se salvează în `localStorage`
  (`mixai-tv:session`), apoi se alege **primul companion** care răspunde la `GET /health`
  (`lanUrl`, apoi `apiUrl`, timeout 2 s) → `{baseUrl, token, userId}` în `mixai-tv:server` → Acasă.
  Fără server accesibil → ecranul de descoperire.

**Deconectare din cont** (Acasă → Setări) șterge sesiunea și conexiunea → Bun venit. **Schimbă serverul**
păstrează sesiunea.

> Pentru teste: `localStorage.setItem("mixai.origin", "http://127.0.0.1:17899")` — vezi `.copilot-tmp/tizen-mock-e2e.mjs`.

## Media Home & deep links (`lib/media.ts`, `lib/launch.ts`, `lib/progress-sync.ts`)

- **Client `/media/*`** (`lib/media.ts`, tipuri copiate în `lib/media-types.ts` din `packages/sdk/src/generated/mmo-server.d.ts`):
  `mediaStatus()`, `mediaHome()`, `mediaTitle(kind, id)`, `mediaSearch(q)`, `mediaLibrary()`, `getProgress(since?)`,
  `putProgress(entries)`, `mediaEtag()`. Cache 5 min per răspuns, invalidat când `{revision, libraryEtag}` de la
  `GET /media/etag` se schimbă (etag-ul însuși e reținut 30 s). Primul **404** marchează modulul ca indisponibil →
  Acasă cade pe rândurile din `POST /video/scan`. Imaginile TMDB trec prin proxy-ul serverului
  `/video/tmdb-image/<w92|w500|w1280>/<path>`.
- **Deep link** (`lib/launch.ts#launchOffer`): URL = `offer.link` (exact, MOTN) → `offer.launch.web` → `offer.launch.search`
  (serverul trimite **string-uri concrete**, nu șabloane). Dacă `launch.tizen.appId` există și
  `tizen.application.getAppInfo(appId)` nu aruncă `NotFoundError` → `launchAppControl(new ApplicationControl(
  "http://tizen.org/appcontrol/operation/view", url, null, null, [ApplicationControlData("PAYLOAD",[payload])]?), appId)`.
  Eșec sau aplicație lipsă → același control **fără** `appId` (browserul de sistem). Eșec și acolo → **QR** cu URL-ul
  pentru telefon. Privilegii noi în `config.xml`: `application.launch`, `application.info`. Starea instalat/neinstalat
  e afișată pe buton.
- **Progres pe server** (`lib/progress-sync.ts`): Player-ul scrie local (`mixai-tv:progress`, fallback) și trimite
  `PUT /media/progress` cel mult la **10 s** + la pauză/ieșire; eșecurile intră în coada `mixai-tv:progress-queue`
  (max. 200, una per titlu), golită la următorul succes / la deschiderea Acasă. Reluarea folosește poziția de pe
  server (`/media/title` → `progress[]`) când vii din ecranul Titlu. Migrare o singură dată a vechilor poziții locale
  (fileId → titlu prin `GET /media/library`), flag `mixai-tv:progress-migrated:v1`.
- **Focus**: rândurile media au `data-focus-row`; ▲/▼ intră în rând pe **ultimul card focalizat acolo** (memorie de
  coloană în `lib/focus.ts`, ▼/▲ preferă banda cea mai apropiată).
- **Test fără TV**: `.copilot-tmp/tizen-media-e2e.ps1` (server mock `/media/*` + `window.tizen` fals injectat cu
  `addInitScript`; 22 aserțiuni: erou, ≥ 2 rânduri, memorie coloană, `launchAppControl` cu appId-ul corect,
  fallback browser/QR, `PUT` la pauză și la „Marchează văzut”, fallback server vechi). Capturi în `.copilot-tmp/shots/`.

## Cum descoperă serverul (fără mDNS)

Aplicațiile web Tizen nu au API de mDNS/Bonjour și nici SSDP, așa că discovery-ul este un **sweep HTTP**:

1. IP-ul și masca TV-ului din `webapis.network.getIp()` / `getSubnetMask()` (privilegiul `network.public`).
2. Toate adresele din `/24` (max. 254) primesc în paralel `GET http://<ip>:17899/pair/info`
  — 32 cereri simultan, timeout **400 ms** (`AbortController`). Doar portul 17899 este probat.
3. Fiecare răspuns valid (`{name, version, lanUrl, port, pairingSupported, hasToken}`) devine un card.
  Un sweep complet durează ~3–4 s; cardurile apar pe măsură ce serverele răspund.

Contractul serverului (`server/src/pair/router.ts`): `POST /pair/request {deviceName:"Samsung TV · MixAI TV", platform:"tizen"}`
→ `201 {code, secret, expiresAt, qr, approveUrl}`; apoi `GET /pair/poll?code&secret` la fiecare 3 s →
`{status: "pending" | "approved" | "expired", deviceToken?, userId?}`. Pe `approved` se salvează
`{baseUrl, token, userId}` în `localStorage` (`mixai-tv:server`).

> **Pentru dezvoltare/teste** pe desktop (unde nu există `webapis.network`), lista de hosturi se poate forța
> cu `?scanHosts=192.168.100.232,127.0.0.1` în URL sau `localStorage.setItem("mixai.scanHosts", "…")`.

## Telecomandă

| Tastă | Acțiune |
|---|---|
| ◀ ▶ ▲ ▼ | navigare între carduri · în player: ±10 s / piesa anterioară / următoarea |
| OK | deschide · în player: play/pauză |
| BACK (↩) | ecranul anterior · pe Acasă: închide aplicația |
| ⏯ ⏪ ⏩ ⏹ | play/pauză, derulare, stop |
| Galben | schimbă pista de subtitrare (off → 1 → 2 …) |

## Instalare pe Odyssey (pas cu pas)

Ținta: **Samsung Odyssey OLED G8** (smart monitor, Tizen 7/8) la `192.168.100.135`; PC-ul de dezvoltare
la `192.168.100.61`, Windows 11 + pwsh. Nu ai nevoie de Tizen Studio IDE — doar de **CLI** (`tizen`, `sdb`).

### 0. Unelte pe PC (o singură dată)

1. **Tizen Studio 6.1 CLI** (fără IDE, ~295 MB): descarcă
  [`web-cli_Tizen_Studio_6.1_windows-64.exe`](https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_windows-64.exe)
  și instalează-l în profilul utilizatorului, fără admin:

  ```powershell
  .\web-cli_Tizen_Studio_6.1_windows-64.exe --accept-license "$HOME\tizen-studio"
  ```

  > Nu pasa și al doilea argument (data dir): installer-ul ia **primul** argument ca *data dir* și
  > instalează în `tizen-studio-data`. Datele merg automat în `$HOME\tizen-studio-data`.
  > Installer-ul se termină cu „Press enter to exit…” — în scripturi rulează-l cu `< nul`.

  Rezultat: `$HOME\tizen-studio\tools\ide\bin\tizen.bat`, `$HOME\tizen-studio\tools\sdb.exe`,
  `$HOME\tizen-studio\package-manager\package-manager-cli.exe`. Include propriul JDK (Java-ul de pe PATH nu contează).

2. **Extensia Samsung TV** (pentru `sdb` pe TV, TV web API, DUID în certificat):

  ```powershell
  $pm = "$HOME\tizen-studio\package-manager\package-manager-cli.exe"
  & $pm show-pkgs | Select-String 'TV|Certificate'
   & $pm install --accept-license TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools TV-SAMSUNG-Extension-Resources cert-add-on Certificate-Manager
   ```

   `show-pkgs` listează (verificat 2026-09-18, Tizen Studio 6.1): `TV-SAMSUNG-Public` 10.0.0 (meta-pachet, include și
   emulatorul ~1 GB — nu e necesar), `TV-SAMSUNG-Public-WebAppDevelopment`, `TV-SAMSUNG-Extension-Tools`,
   `cert-add-on` 2.0.75 (Samsung Certificate Extension), `Certificate-Manager` 3.1.3. Descărcarea durează
   10–20 min. Pachete offline: [TV Extension download](https://developer.samsung.com/smarttv/develop/tools/tv-extension/download.html).
  ```powershell
   cd apps/tv-tizen
   pnpm setup:cert      # = scripts/setup-tizen-cert.ps1

  Generează o parolă aleatoare salvată **doar** în `$HOME\tizen-studio-data\mixai-cert.env` (în afara
  repo-ului), rulează `tizen certificate -a MixAI … -f mixai_author` și `tizen security-profiles add -n mixai`.
  Profilul folosește certificatul **distributor implicit Tizen** — suficient pentru sideload pe un TV în
  *Developer Mode*. Verifică: `tizen security-profiles list`.

### 1. Developer Mode pe monitor

1. Apasă **Home** pe telecomandă → **Apps** (grila de aplicații Smart Hub).
2. Cu ecranul *Apps* deschis, tastează rapid **1 2 3 4 5** pe telecomandă (pe telecomanda Solar fără
  cifre: apasă **123** / tasta numerică → apare tastatura pe ecran → 1,2,3,4,5). Se deschide fereastra
  *Developer mode*.
3. **Developer mode → On**. La **Host PC IP** scrie `192.168.100.61` (IP-ul PC-ului; verifică cu
  `Get-NetIPAddress -AddressFamily IPv4`). **OK**.
4. **Oprește și repornește monitorul** (butonul de power, nu doar standby). După repornire, pe *Apps*
  apare „Developer mode” în colț.

> Monitorul acceptă conexiuni `sdb` **doar** de la IP-ul din *Host PC IP*, pe portul **26101**.
> Dacă PC-ul primește alt IP (DHCP), refă pasul 3.

### 2. Conectare și instalare

```powershell
$sdb   = "$HOME\tizen-studio\tools\sdb.exe"
$tizen = "$HOME\tizen-studio\tools\ide\bin\tizen.bat"

& $sdb connect 192.168.100.135          # -> "connected to 192.168.100.135:26101"
& $sdb devices                          # -> 192.168.100.135:26101  device  UJ...  (serialul e prima coloană)

cd apps/tv-tizen
pnpm install
pnpm build                              # Vite -> dist/
pnpm package                            # -> dist/MixAITV.wgt SEMNAT (author-signature.xml + signature1.xml)

& $tizen install -n dist\MixAITV.wgt -s 192.168.100.135:26101
& $tizen run -p mXa1TvApp0.MixAI -s 192.168.100.135:26101
```

Sau totul într-un pas: `pnpm package -- -Install -TvIp 192.168.100.135` (face `sdb connect` + `sdb install`).

ID-urile din `config.xml`: widget `http://mixai.ro/tv`, aplicație `mXa1TvApp0.MixAI`, pachet `mXa1TvApp0`.
Dezinstalare: `& $tizen uninstall -p mXa1TvApp0 -s <serial>`.

> **De ce `required_version="2.3"` și pachet `mXa1TvApp0`?** Verificat pe Odyssey OLED G8
> (Tizen 9.0, 2026-09-18): cu `required_version="6.0"` și pachetul `MixAITV0` instalarea pică
> cu `install failed[118, -4] Load archive info fail` chiar și pentru un widget minimal semnat
> corect. Manifestul în stilul Jellyfin (`2.3`, pachet de 10 caractere alfanumerice,
> `viewmodes="fullscreen"`, `screen.size.all`) se instalează. Motivul real îl afli cu
> `sdb shell 0 vd_appinstall <appid> <path>` — `tizen install` îl ascunde.

### 3. Prima pornire pe TV

*Apps* → **MixAI TV** → **Conectare cu contul MixAI** (cod pe `mixai.ro/activate`) sau **Conectare la un
server din această rețea** → alege cardul serverului → introdu codul de 6 cifre în MMO Server → *Quick Connect*
(sau scanează QR-ul). Alternativ *Introdu adresa manual* + *Device token* din MMO Server → Settings.

### Depanare

| Simptom | Cauză | Remediu |
|---|---|---|
| `sdb connect` → `error: failed to connect to remote target '192.168.100.135'` (monitorul răspunde la ping, dar portul 26101 e închis) | Developer Mode oprit, monitorul nu a fost repornit după activare, sau *Host PC IP* ≠ IP-ul PC-ului | Refă §1; `Test-NetConnection 192.168.100.135 -Port 26101` trebuie să dea `TcpTestSucceeded: True`. Portul 26101 este deschis **numai** după repornire cu Developer Mode ON și doar pentru *Host PC IP*. |
| `sdb devices` gol după `connected to` | `sdb` a pornit un daemon vechi | `& $sdb kill-server; & $sdb connect 192.168.100.135` |
| `tizen install` → `Installing the package... failed[118, -12]` sau `certificate not matched` / `author certificate is not matched` / `Check the certificate` | Distributor implicit Tizen respins de firmware-ul TV (unele modele/Tizen 8+) → trebuie **certificat Samsung** cu **DUID-ul** monitorului | Ia DUID-ul: `& $sdb -s 192.168.100.135:26101 shell 0 getduid`. Apoi fie *Certificate Manager* (Tizen Studio IDE / `tizen-studio\tools\certificate-manager\certificate-manager.exe`): **+** → *Samsung* → *TV* → autentificare cont Samsung → adaugă DUID-ul → salvează profilul `mixai`; fie CLI cu extensia Samsung Certificate: `tizen certificate` pentru autor și pentru distributor `tizen security-profiles add -n mixai -a <author.p12> -p <pass> -d <distributor.p12> -dp <pass>` cu `distributor.p12` generat din *Certificate Manager* cu DUID-ul inclus. Re-rulează `pnpm package`. |
| `Package is already installed` / versiune veche rămâne | Același `version` în `config.xml` | `& $tizen uninstall -p mXa1TvApp0 -s <serial>` sau crește `version="0.1.x"` în `config.xml`. |
| `author signature verification failed` la reinstalare | Cert autor **diferit** față de instalarea precedentă (parolă/p12 nou) | Dezinstalează aplicația veche, apoi instalează. Păstrează `mixai_author.p12` + `mixai-cert.env`. |
| Aplicația pornește dar nu găsește serverul | Monitorul e pe alt `/24` decât MMO Server sau serverul nu e pe portul 17899 | *Introdu adresa manual*; verifică `http://<ip>:17899/pair/info` din browser. |
| `pnpm package` produce `.wgt` **nesemnat** | `tizen.bat` lipsă sau profilul `mixai` inexistent | Rulează pașii §0 (1) și (3). Un `.wgt` nesemnat **nu** se instalează pe Samsung. |
| Ecran negru / fonturi lipsă pe TV | Bundle-ul folosește `<script type="module">` | Vite build-ul include `@vitejs/plugin-legacy` cu SystemJS — nu seta `build.target` în `vite.config.ts`. |

Log pe TV în timp real: `& $sdb -s 192.168.100.135:26101 dlog -v time | Select-String 'MixAI|WRT|CONSOLE'`.
Web Inspector: `& $tizen run -p mXa1TvApp0.MixAI -s <serial>` apoi `& $sdb -s <serial> forward tcp:9222 tcp:26099`
și deschide `http://localhost:9222` în Chrome (sau `tizen debug` / Tizen Studio *Debug As*).

## Limitări

- **Doar HTTP în LAN.** MMO Server nu are TLS; aplicația permite `access origin="*"`. Nu expune serverul pe internet.
- **HEVC** funcționează doar din containere **MP4 / MKV / TS** (serverul face remux; fișierele
  pre-remuxate `hvc1 + AAC` se preferă automat). DTS / TrueHD → serverul transcodează audio în AAC.
- **Plafon FHD pe MSE.** Redarea prin `hls.js` (Media Source Extensions) este limitată la 1080p pe
  majoritatea modelelor Tizen; 4K merge doar pe calea *direct play* (`<video src>` progresiv MP4).
- Descoperirea se limitează la `/24`-ul TV-ului și la portul 17899 (fără mDNS pe Tizen). Server pe alt
  segment sau alt port → *Introdu adresa manual*.
- Testat pe Tizen 6–8 (Chromium 76–94). Modele mai vechi (Tizen 4–5) nu sunt suportate.

---

[🏠 Home](../../README.md) · [⬅️ Aplicație](README.md)
