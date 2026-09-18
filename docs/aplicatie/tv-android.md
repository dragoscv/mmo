# 📺 MixAI TV — aplicație nativă Android TV / Google TV

> Client nativ (Kotlin, Jetpack Compose for TV, Media3/ExoPlayer) pentru **MMO Server**.
> Redă filme din biblioteca video și muzică prin API-ul OpenSubsonic al serverului.
> Decizia de arhitectură: [ADR-0004](../adr/0004-tv-apps-compose-media3-and-tizen-web.md).

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md) · [📚 Module](README.md)

Cod: [`apps/tv-android/`](../../apps/tv-android/) · Versiune: **1.1.0** (versionCode 3) · `applicationId`: `ro.mixai.tv`

---

## Cerințe

- Android TV / Google TV cu **Android 8.0 (API 26)** sau mai nou, Leanback.
- Un **MMO Server** pornit pe LAN (`http://<host>:17899`). Nu trebuie să tastezi nimic:
  serverul este găsit prin mDNS și împerecherea se face cu un cod de 6 cifre (Quick
  Connect). Traficul este HTTP în clar (`usesCleartextTraffic=true`,
  `network_security_config.xml`) — potrivit pentru LAN.
- Permisiuni: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE` (unele TV-uri aruncă pachetele multicast fără un
  `MulticastLock`, iar mDNS nu ar primi niciun răspuns).

## Instalare (sideload prin adb)

1. Pe TV: *Setări → Preferințe dispozitiv → Despre → apasă de 7× pe „Build”* pentru a
   activa opțiunile de dezvoltator, apoi *Depanare USB / Depanare rețea* → ON.
2. Pe PC (APK-ul din release-ul GitHub `tv-v*` sau construit local):

```powershell
adb connect 192.168.100.31          # IP-ul televizorului
adb install -r app-debug.apk
adb shell am start -n ro.mixai.tv/.MainActivity
```

Build local (JDK 17+, Android SDK 35 în `%LOCALAPPDATA%\Android\Sdk`):

```powershell
cd apps\tv-android
# local.properties (gitignored): sdk.dir=C:\\Users\\<user>\\AppData\\Local\\Android\\Sdk
.\gradlew.bat assembleDebug
# → app\build\outputs\apk\debug\app-debug.apk
```

## Conectare (Quick Connect)

Fluxul este gândit ca utilizatorul să **nu tasteze niciodată o adresă sau un token**.

### 0. Bun venit (`WelcomeScreen`) — prima pornire

Primul ecran oferă două carduri mari:

| Opțiune | Ce face |
|---|---|
| **Sign in with MixAI account** *(Recomandat)* | Autentificare cu contul de pe mixai.ro printr-un **cod de dispozitiv** (vezi §0.1). Serverele tale (companion-ii înregistrați în cont) apar automat, fără discovery. |
| **Connect to a server on this network** | Quick Connect local — discovery mDNS + cod de 6 cifre (§1–2). |

Dacă există o conexiune salvată, ecranul Bun venit e sărit și aplicația merge direct la Home (§3).
**Back** pe Bun venit închide aplicația.

#### 0.1 Autentificare cu contul MixAI (`SignInScreen`, `data/DeviceAuth.kt`)

Flux OAuth *device code* contra `BuildConfig.MIXAI_ORIGIN` (implicit `https://mixai.ro`;
la build de debug se poate suprascrie cu `-PmixaiOrigin=http://192.168.100.61:13789`):

1. `POST {origin}/api/device/code {deviceName:"<Build.MODEL> · MixAI TV", platform:"android-tv", appVersion}`
  → `{device_code, user_code:"ABCD-1234", verification_uri, verification_uri_complete, expires_in, interval}`.
2. Ecranul arată **codul de 8 caractere**, un **QR** cu `verification_uri_complete`, textul
  „Open mixai.ro/activate on your phone and enter the code” și un countdown.
3. `POST {origin}/api/device/token {device_code}` la fiecare `interval` secunde:

  | Răspuns | Ce face TV-ul |
  |---|---|
  | `428 authorization_pending` | continuă |
  | `403 slow_down` | mărește intervalul cu 5 s |
  | `403 access_denied` | „Sign-in was declined on your phone.” + Retry / Back |
  | `410 expired_token` (sau countdown 0) | „The code expired.” + **New code** / Back |
  | `200 {session_token, expires, user, companions[]}` | salvează sesiunea (`session_token`, `user.{id,name,image}`) în DataStore |
  | alt cod (ex. 404 — endpoint neinstalat) | „Could not reach mixai.ro (404)” + Retry / Back; fără rețea: „… (network)” |

4. Din `companions[]` (`{id,name,lanUrl,apiUrl,tunnelHostname,token}`) alege **primul care răspunde**
  la `GET /health` — întâi `lanUrl`, apoi `apiUrl`, timeout 2 s fiecare — și salvează `{baseUrl, token, userId}` → Home.
  Dacă niciunul nu răspunde → ecranul de discovery (§1).

Pe Home, când există sesiune, numele utilizatorului apare sus-dreapta și lângă **Change server**
există **Sign out** (șterge sesiunea *și* conexiunea → Bun venit). **Change server** singur
păstrează sesiunea și duce la discovery.

### 1. Autodiscovery (`DiscoverScreen`)

La prima pornire aplicația caută pe LAN serviciul mDNS **`_mmo-companion._tcp`** cu
`NsdManager` (ține un `WifiManager.MulticastLock` cât durează căutarea). Fiecare
serviciu găsit este rezolvat la host + port + TXT; numele afișat este TXT `name`, altfel
numele instanței mDNS (`MMO Companion (homepi)` → `homepi`), altfel IP-ul. Pentru fiecare
server se apelează și `GET /pair/info` → `{name, version, pairingSupported, …}` ca să
afișeze versiunea și dacă suportă Quick Connect.

Serverele apar ca **carduri mari, focusabile** („homepi · 192.168.100.232:17899 ·
v2.0.0 · Quick Connect”). Jos există butonul secundar **„Enter address manually”**.

### 2. Împerechere (`PairScreen`)

La selectarea unui card aplicația face
`POST /pair/request {deviceName:"<Build.MODEL> · MixAI TV", platform:"android-tv"}` și
primește `{code, secret, expiresAt, qr, approveUrl}`. Ecranul afișează:

- **codul de 6 cifre** (`320 906`), mare;
- un **cod QR** cu `approveUrl` (generat local cu `com.google.zxing:core` — doar
  `BitMatrix`, desenat cu Compose `Canvas`; fără cameră);
- textul „Scan with your phone or open mixai.ro/pair and enter the code”;
- un **countdown** până la `expiresAt`.

Apoi interoghează `GET /pair/poll?code=&secret=` la fiecare 3 s:

| `status` | Ce face TV-ul |
|----------|---------------|
| `pending` | continuă să aștepte |
| `approved` | salvează `{baseUrl, deviceToken, userId}` în DataStore și merge la Home |
| `expired` | afișează „The code expired” + **Retry** (cere un cod nou) / Back |

Dacă `POST /pair/request` eșuează (ex. 404 pe un server vechi) ecranul spune că serverul
nu suportă încă Quick Connect și oferă Retry / Back — de acolo se poate folosi calea
manuală.

### 3. Pornirile următoare

Dacă există o conexiune salvată, aplicația sare **direct la Home**. Înainte însă verifică
`GET /health`; dacă serverul nu răspunde, revine la ecranul de discovery cu serverul
salvat **preselectat** (cardul „Saved server · <ip>:<port>”), ca să poți re-împerechea
cu un singur OK.

### 4. Calea manuală (fallback, `ConnectScreen`)

Din butonul „Enter address manually”:

| Câmp | Ce introduci |
|------|--------------|
| **Server** | `192.168.1.20` (se completează automat `http://…:17899`) sau URL complet |
| **Device token** | *opțional* — valoarea `deviceToken` din `config.json` al serverului |

„Connect” apelează `GET /health` (fără autentificare) și apoi `GET /video/flags` cu
`x-device-token`. Rezultate posibile:

- ✓ **Server OK — <hostname> v<version>** și trece la Home → împerechere reușită.
- ✓ Server OK + **„Not paired yet”** → dacă serverul raportează `pairingSupported`
  apare butonul **„Quick Connect with a code”** (intră în `PairScreen` pentru acea
  adresă); altfel trebuie introdus tokenul din `config.json`.
- ✗ **mesaj de eroare** → serverul nu răspunde (IP/port greșit, firewall).

Conexiunea se salvează în DataStore; „Change server” pe Home o șterge (sesiunea de cont rămâne).

## Media Home & deep links (v1.1.0, WP12-01)

Home-ul este condus de **serverul MMO** prin `/media/*` (tracker §10–11): serverul este „creierul”
(TMDB, disponibilitate, recomandări), TV-ul doar randează. Autentificare: header `x-device-token`
(fără `x-user-id` — aplicația TV nu are un user id).

| Piesă | Fișier | Ce face |
|---|---|---|
| Client `/media/*` | `data/MediaRepository.kt` | `status()`, `home()`, `title(kind, tmdbId)`, `search(q)`, `getProgress(since)`, `putProgress(list)`, `postPlay`, `library(since)`. Folosește **exclusiv** modelele generate din `server/openapi.yaml` (`data/generated/Models.kt`). `home()` are cache în memorie 5 min: întâi `GET /media/etag`, refetch doar dacă `revision`/`libraryEtag` s-au schimbat. |
| Home | `ui/HomeScreen.kt`, `ui/MediaRows.kt` | `HeroBillboard` (backdrop `w1280` prin proxy-ul `/video/tmdb-image/{size}/{path}?t=`, meta, CTA **Redă** dacă `inLibrary` altfel **Unde vezi**, rotește la 12 s, buton „Următorul”) + un `LazyRow` cu `focusRestorer()` per `HomeRow` (postere 2:3 `w342`, scale focus din `Tokens.CARD_SCALE_FOCUSED`, bară de progres, badge „În bibliotecă”). Rândul `continue` vine de la server (Continue-ul local dispare când există rânduri server). Rândurile de **muzică** (albume) rămân dedesubt. **Fallback**: dacă `/media/status` e 404/501 (server vechi) sau `tmdb=false`, se afișează vechile rânduri din `POST /video/scan`. |
| Pagina de titlu | `ui/TitleScreen.kt` | backdrop + poster + logo (`logoPath`) sau titlu, tagline, meta, genuri, distribuție; **Surse** = un buton „Redă de pe <serverName>” per fișier local (`/video/file/{id}/info` → `PlayerScreen`, reluare din `progress`); **Unde vezi** = butoane per ofertă (logo `w92`, nume, tip abonament/închiriere/…; greyed + „Instalează” când aplicația lipsește — `getLaunchIntentForPackage`), atribuire JustWatch/MOTN; **Marchează văzut** (`PUT /media/progress completed=true`); „Titluri similare”. *Lista de urmărit* există doar pe web — nu apare buton pe TV. |
| Lansare provider | `data/ProviderLauncher.kt` | `Intent(ACTION_VIEW, link ?: launch.android.uri ?: launch.web)` + `setPackage(launch.android.package)` + `FLAG_ACTIVITY_NEW_TASK` → la `ActivityNotFoundException` reîncearcă fără `setPackage` (browser) → toast + `market://details?id=<pkg>`. Manifestul declară `<queries>` cu cele 10 pachete din registru + un `<intent>` VIEW/BROWSABLE/https. |
| Progres | `player/PlayerScreen.kt`, `data/ProgressSync.kt` | `PlayRequest.Video.ref: MediaRef(kind, tmdbId, season, episode)`; `PUT /media/progress` (secunde) la 10 s și la pauză/stop, în paralel cu DataStore-ul local (5 s). La eroare intrarea intră în `progress_queue_json` și e golită la următorul PUT reușit. **Migrare one-shot**: la prima pornire cu un server care are `/media/status`, harta veche `progress_json` (fileId → ms) e mapată prin `/media/library` la `tmdbId` și trimisă în secunde, apoi `media_progress_migrated=1`. |
| Watch Next | `data/WatchNext.kt` | `androidx.tvprovider:tvprovider:1.1.0` (stabil) — rândul `continue` devine `WatchNextProgram` (titlu, poster, tip, `internalProviderId=<kind>:<tmdbId>`), actualizat/șters la fiecare Home; intent `mixai://title/<kind>/<tmdbId>` (intent-filter cu schema `mixai`) → `MainActivity` deschide `TitleScreen` peste Home (`onNewIntent` când aplicația rulează). |

Toate stringurile noi sunt în `res/values/strings.xml` **și** `res/values-ro/strings.xml`.

## Ce face v0.1.0

| Zonă | Detalii |
|------|---------|
| **Home** | rânduri *Movies* (rezultatul `POST /video/scan` pe rădăcinile configurate ale serverului — nu există încă endpoint de listare, deci prima încărcare rulează un scan) și *Albums* (`getAlbumList2?type=newest&size=50`). Focus D-pad pe primul card. |
| **Film** | detalii tehnice (rezoluție, codec, HDR, subtitrări), **Play (direct)** când containerul/codecul sunt redabile nativ (`/video/direct/:fileId` — HTTP range, fără ffmpeg) sau **Play (transcode)** prin HLS (`/video/stream/:fileId?q=720p`). |
| **Subtitrări** | fiecare pistă încorporată e atașată ca `SubtitleConfiguration` WebVTT (`/video/subs/:fileId/:idx`) — selectabilă din meniul playerului. |
| **Album** | lista de piese (`getAlbum?id=`), *Play all* sau redare de la o piesă; coadă Media3 cu Next/Previous, coperta prin `getCoverArt`. |
| **Player** | Media3 ExoPlayer 1.5 + `PlayerView`. D-pad: **OK/Play-Pause** = play/pause, **◀/▶** = ±10 s, **Back** = ieșire, media keys (next/prev/stop) pentru muzică. |
| **Autentificare** | header `x-device-token` pe apelurile JSON; `?t=<token>` pe URL-urile media (Media3 nu setează headere per item); `apiKey=<token>` pe OpenSubsonic. `u` (userId) nu este necesar pentru `/video/*` — `authMiddleware` nu îl citește. |

## Ce NU face încă (roadmap)

- **Continue watching** — nu există încă poziții de redare per utilizator pe server.
- **Seriale** — episoadele (`parsed.season != null`) sunt filtrate din rândul *Movies*.
- **Postere TMDB** — `/video/tmdb-image/w500/<path>` există pe server, dar `/video/scan`
  nu întoarce `posterPath`; cardurile de film afișează titlul.
- **Offline / descărcări**, **profil de dispozitiv** (codecuri suportate → alegere
  automată direct vs. transcode pe server), **passthrough audio** configurabil.
- **Căutare** (`search3` este deja în client, fără UI).

## Release

Workflow: [`.github/workflows/tv-android-release.yml`](../../.github/workflows/tv-android-release.yml)
— la tag `tv-v*` sau manual. Produce `app-debug.apk` și `app-release.apk` (semnat doar
dacă există secretele `TV_KEYSTORE_B64`, `TV_KEYSTORE_PASSWORD`, `TV_KEY_ALIAS`,
`TV_KEY_PASSWORD`; altfel release-ul rămâne nesemnat).

---

[🏠 Home](../../README.md) · [📚 Module](README.md)
