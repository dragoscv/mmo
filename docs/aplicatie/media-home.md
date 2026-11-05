# Media Home — filme, seriale, muzică și Live TV

> Partea video + muzică din MixAI: profiluri, pagina Acasă, bibliotecă, pagina de titlu, player, „Redă pe TV”,
> Watch Together, muzică cu versuri, Live TV cu ghid și înregistrări, descărcări offline.
> Același lucru pe **web** (`/media`), **Android TV / Google TV** și **Samsung Tizen**.
> Creierul este **MMO Server** (≥ 3.8.0 pentru tot ce e descris aici); aplicațiile doar afișează și redau.
> Decizii: [ADR-0009](../adr/0009-remove-third-party-embed-sources.md) (fără embed-uri pirat),
> [ADR-0010](../adr/0010-media-module-and-media-home.md) (modulul media), [ADR-0011](../adr/0011-hub-remote-and-watch-together.md)
> (hub, telecomandă, Watch Together), [ADR-0012](../adr/0012-live-tv-iptv-dvr.md) (Live TV, DVR).
> Plan și stare: [tracker §10–§11 și WP16](../mixai-design-tracker.md).

[Home](../../README.md) · [Navigare](../../NAVIGARE.md) · [Aplicație](README.md)

---

## Pe scurt

| Vrei să… | Unde |
|---|---|
| alegi cine se uită | ecranul „Cine se uită?” la pornire (web `/media`, ambele TV-uri) |
| continui un film sau un episod | Acasă → rândul „Continuă vizionarea” |
| pornești un film pe televizor din browser | pagina titlului → **Redă pe TV** |
| te uiți împreună cu cineva | player → **Watch Together** → trimite linkul sau codul QR |
| asculți muzică cu versuri | Muzică → album / artist → „Se redă acum” |
| vezi televiziune live | Live TV (după ce adaugi o sursă proprie) |
| iei un film cu tine offline | web: butonul **Descarcă** → `/media/downloads` |

## Profiluri, PIN și copii

- La pornire apare **„Cine se uită?”**. Profilurile sunt ținute pe MMO Server, deci sunt aceleași pe web, Android TV
   și Tizen: progresul, lista „Lista mea”, preferințele de audio/subtitrare și istoricul merg cu profilul.
- Un profil poate avea **PIN de 4 cifre**. După **5 încercări greșite** profilul se blochează **5 minute** (ecranul arată
   câte încercări mai ai și cât mai durează blocarea). Pe TV poți tasta PIN-ul și cu tastele numerice ale telecomenzii.
- Profil **copil**: are vârstă maximă (0, 7, 12, 14, 15 sau 18 ani). Titlurile sunt filtrate după clasificarea TMDB
   convertită la vârstă (în România scala CNC: AG, AP-12, I.C.-14, N-15, IM-18). **Titlurile fără clasificare nu apar**
   pentru copii.
- Gestionare: web `/profiles` (și **Setări → Profiluri**), pe TV din meniul lateral (schimbare profil) și din Setări.

## Acasă

- Fundalul ocupă tot ecranul și **urmărește focusul** (sau mouse-ul pe web); sus e un „erou” cu logo-ul titlului,
   informații scurte și o acțiune principală (Redă / Continuă). Pe web trailerul pornește fără sunet după 3 secunde.
- Rânduri: **Continuă vizionarea** (filme, următorul episod), **Lista mea**, colecții (francize), recomandări
   („Alese pentru tine”, „Pentru că ai văzut…”), noutăți din bibliotecă și ce e în trend pe platformele tale.
- Acasă se deschide din cache instantaneu și se reîmprospătează în fundal. Pe web, `/` deschide acum `/media`;
   vechea pagină cu toate serverele rămâne la `/?classic=1`.
- Navigare: pe TV săgețile telecomenzii; pe web săgețile tastaturii mută focusul între carduri și rânduri, iar `/`
   deschide căutarea.

## Bibliotecă și căutare

- **Filme** și **Seriale**: grilă cu sortare, genuri, deceniu, rezoluție, „nevizionate” și o bară A–Z pentru salt rapid;
   funcționează și cu peste 1000 de titluri.
- **Căutare**: rezultate din bibliotecă, din TMDB (titluri pe care nu le ai), muzică și canale Live TV. Pe TV ai
   tastatură pe ecran; pe Android TV și căutare vocală. Căutările recente sunt ținute per profil.

## Pagina titlului

- Fundal, logo, an, durată, clasificare, gen; **Redă / Continuă**, **Lista mea**, marcare ca văzut, trailer.
- **Versiuni**: dacă ai mai multe fișiere (de ex. 1080p și 4K HDR, sau ediții diferite), alegi versiunea.
- Seriale: tab-uri pe sezoane și lista de episoade cu imagine, rezumat, durată și progres per episod.
- Distribuție, „Mai multe ca acesta” și **Unde vezi** (platformele de streaming unde e disponibil titlul, dacă nu îl ai
   local — vezi [Platforme](#platforme-registru-serversrcmediaprovidersts)).
- Pe web: **Redă pe TV** și **Descarcă** (offline).

## Player

Comun pe toate suprafețele: bară de derulare (cu miniaturi pe TV), piste audio, subtitrări (și stil: mărime, fundal),
viteză, format ecran (încadrat / umplut / zoom), **Sari peste intro / rezumat / generic** (sau sărire automată, din
setări), **Up Next** (cardul următorului episod apare cu 30 s înainte de final, apoi numărătoare inversă de 10 s),
**„Încă te uiți?”** după mai multe episoade redate automat la rând și **temporizator de somn** (15, 30, 60, 90 minute
sau la finalul episodului/filmului). Calitatea este cea originală: video nu se recodează niciodată.

| Tastă (web) | Acțiune |
|---|---|
| Spațiu / K | redă / pauză |
| Săgeată stânga / J, săgeată dreapta / L | înapoi / înainte 10 s |
| Săgeată sus / jos | volum |
| M | sunet oprit / pornit |
| F | ecran complet |
| C | subtitrări |
| Esc | înapoi |

Pe TV: OK afișează meniul (OSD), stânga/dreapta derulează ±10 s (ținut apăsat accelerează), Înapoi ascunde întâi
meniul, apoi iese din player. Pe web există și Picture-in-Picture.

## Redă pe TV (telecomandă)

1. TV-ul trebuie să fie pornit cu aplicația MixAI deschisă și conectat la același MMO Server (apare automat în listă).
2. Pe web, pagina titlului → **Redă pe TV** → alegi televizorul. Filmul pornește pe TV.
3. Pagina devine telecomandă: pauză, derulare, oprire, următorul. TV-urile acceptă prin hub și o comandă `text`
   (deschide căutarea cu textul primit), pentru telecomenzi care o trimit prin `POST /hub/command`.

Dispozitivele online și ce redă fiecare se văd în indicatorul de hub din bara de sus a `/media`.

## Watch Together

- Din player (web sau TV) → **Watch Together** → se creează o cameră. Primești un **link de invitație** (pe TV și cod QR).
- Invitatul deschide linkul în browser (pagina publică `/together`); nu are nevoie de cont. Linkul e valabil **24 de ore**
   și dă acces **doar** la titlul redat în cameră. Funcționează și din afara casei, prin tunelul serverului.
- Toți pornesc în același moment: serverul programează redarea puțin în viitor și fiecare player își corectează singur
   decalajul (accelerează sau încetinește imperceptibil, iar peste 1,5 s sare direct la poziția corectă). Dacă cineva
   încarcă (buffering), camera așteaptă (maximum 8 s).
- Chat și reacții (reacțiile apar la momentul din film la care au fost trimise). Maximum 16 participanți.

## Muzică și versuri

- **Muzică**: albume recente, cele mai noi, cele mai ascultate, playlisturi, genuri, „Amestecă tot”; pagini de artist și
   album; căutare fără diacritice.
- **Se redă acum**: copertă pe tot ecranul, **versuri sincronizate** (din tag-uri, fișier `.lrc` alăturat sau LRCLIB,
   salvate de server), coada de redare. Coada și redările se sincronizează între web și TV.
- Pe Android TV muzica merge în fundal (poți naviga sau ieși din aplicație); pe toate suprafețele ai mini-player.

## Live TV

**MixAI nu include nicio listă de canale.** Adaugi tu sursele la care ai drept (abonamentul tău IPTV, tunerul tău).

1. **Surse** — web `/media/live/sources`, pe TV Live TV → Surse. Tipuri:
    - **M3U** (link sau fișier) + opțional link **XMLTV** pentru ghid;
    - **Xtream Codes** (server, utilizator, parolă — parola nu mai este afișată după salvare);
    - **HDHomeRun** (adresa IP a tunerului).
    Butonul **Testează** verifică sursa; prima listă de canale și ghidul se încarcă în fundal.
2. **Canale** — listă cu previzualizare live, grupuri, favorite per profil, canale ascunse, numerotare proprie.
3. **Ghid (EPG)** — grilă pe ore cu linia „acum”; web `/media/live/guide`. Programele trecute se pot reda ca
    **catch-up** dacă sursa are arhivă (Xtream, sau M3U cu `catchup`).
4. **Zapping** — canalul următor/anterior pornește aproape instant (vecinii sunt preîncărcați). Pe web:
    săgeată sus / PageUp = următorul, jos / PageDown = anteriorul, cifre = număr de canal, Backspace / L = ultimul canal,
    G = ghid, R = înregistrează. Pe TV: CH+/CH- sau sus/jos, tastele numerice, butonul de ultimul canal.
5. **Înregistrări** — din ghid (un program) sau regulă de serie (după titlu, opțional pe un canal, cu „păstrează
    ultimele N”); web `/media/live/recordings`. Serverul înregistrează **fără recodare** (calitate identică) și le pune
    în primul folder de tip „recordings” → `Live TV/`. O înregistrare terminată se redă din orice aplicație și se poate
    descărca.
    - **Tunere**: fiecare sursă are un număr maxim de fluxuri simultane (HDHomeRun = numărul de tunere, Xtream = limita
       contului, M3U = 2, modificabil). Înregistrările care nu încap sunt marcate **conflict** și eșuează vizibil la ora de
       start, nu dispar.
    - Dacă serverul a fost oprit în timpul unei înregistrări, ea apare ca eșuată, cu motivul.

## Descărcări offline (web)

- Pe titlu, episod, piesă sau înregistrare: **Descarcă**. Fișierul original se salvează în browser, per profil.
- Lista și redarea offline: `/media/downloads`. Fără internet, aplicația deschide o pagină offline de unde ajungi la
   descărcări.
- Spațiul depinde de browser; aplicația cere stocare persistentă ca descărcările să nu fie șterse automat.

## Pe fiecare suprafață

| | Web | Android TV / Google TV | Samsung Tizen |
|---|---|---|---|
| Unde | `/media` (meniu sus: Acasă, Căutare, Filme, Seriale, Muzică, Live TV) | aplicația MixAI TV 2.0, meniu în stânga | aplicația MixAI TV 2.1, meniu în stânga |
| Ghid de instalare | [README web](../../apps/web/README.md) | [tv-android.md](tv-android.md) | [tv-tizen.md](tv-tizen.md) |
| Redă pe TV | trimite către TV | primește comenzi | primește comenzi |
| Watch Together | da, plus pagina pentru invitați `/together` | da (link + QR) | da (link + QR) |
| Muzică în fundal | da (Media Session) | da (serviciu în fundal) | da, cât aplicația e deschisă |
| Descărcări offline | da | nu | nu |
| Particularități | tastatură completă, Picture-in-Picture | căutare vocală, screensaver ambiental | numele dispozitivului se schimbă din Setări |

## Probleme frecvente

| Simptom | Cauză și soluție |
|---|---|
| Watch Together / Redă pe TV spune „Server prea vechi” sau hub-ul nu se conectează | Hub-ul există din MMO Server 3.5.0. Un companion mai vechi răspunde **400** la `/hub`. Actualizează serverul; pentru tot ce e în acest ghid ai nevoie de **≥ 3.8.0** (versiunea apare în aplicația companion și în `GET /pair/info`). |
| Înregistrările nu se pot reda pe web | Ruta `/livetv/recordings/:id/file` există din 3.8.0. Actualizează serverul. |
| TV-ul nu apare în lista „Redă pe TV” | Aplicația de pe TV trebuie să fie deschisă și conectată la **același** server; verifică în Setări → Server pe TV. |
| Profilul copil nu vede un film | Filmul nu are clasificare sau depășește vârsta maximă a profilului. |
| PIN blocat | 5 încercări greșite → așteaptă 5 minute. |
| Live TV: canalul nu pornește pe Android TV | Pentru canalele HLS, Android TV redă direct de la furnizor, deci TV-ul trebuie să poată ajunge la adresa furnizorului (nu doar serverul). |
| Live TV: înregistrare „tuner conflict” | Prea multe înregistrări simultane pe aceeași sursă; mărește limita de tunere a sursei (dacă abonamentul permite) sau renunță la una. |
| Ghidul e gol | Sursa nu are XMLTV sau numele canalelor nu se potrivesc; adaugă linkul XMLTV la sursă și apasă Reîmprospătează. |
| Rândurile din Acasă sunt goale | Serverul nu are cheie TMDB (`TMDB_API_KEY`); vezi referința de mai jos. |

---

## Referință tehnică (WP10–WP12)

### Ce este

| Concept | Detaliu |
|---|---|
| **Titlu** | Un film sau serial identificat prin `kind/tmdbId` (ex. `tv/66732` = Stranger Things). Metadatele (poster, sinopsis, gen, rating) vin din TMDB prin server, cu cache 30 zile. |
| **Rânduri** | `continue` (progres ≥ 2 %), `top_picks` (recomandări din istoricul tău), `because_you_watched_*`, `trending_on_your_providers`, `upcoming`, `new_in_library`. Serverul le construiește în `buildHomeRows` (cache 24 h). |
| **Oferte („Unde vezi”)** | Pentru fiecare titlu, lista platformelor unde e disponibil în regiunea ta (RO): MOTN (link exact, dacă există `MOTN_API_KEY`) → TMDB *watch/providers* (date JustWatch) → URL de căutare al platformei. Fiecare ofertă poartă date de lansare pe web / Android / Tizen. |
| **Progres** | Poziția în secunde per profil, ținută pe server (`PUT /media/progress`), trimisă și către web (`/api/media/sync`) când `webAppUrl` e accesibil. TV-urile au coadă locală de rezervă. |
| **Fără embed-uri** | Nu există player pentru surse externe: un titlu se **redă** doar dacă e în biblioteca unui server MMO, altfel se **deschide aplicația platformei**. |

### Suprafețe

| Suprafață | Unde | Ce face |
|---|---|---|
| **Web** | `/` (`app/page.tsx` → `MediaHome`), `/media/[kind]/[tmdbId]`, `/settings/media`, vechiul panou la `/dashboard` | Agregă toate serverele utilizatorului (`aggregateAcrossCompanions`), dedup pe `tmdbId`, cipuri per server, stare *offline* per server. Serverele sunt căutate la `devices.lan_url` — un server local nepublicat nu apare. |
| **TV Android** | `apps/tv-android` — `MediaRepository`, `ui/MediaRows.kt`, `ui/TitleScreen.kt`, `ProviderLauncher` | Erou + rânduri; ecranul de titlu are „Redă de pe <server>” pentru fișiere locale și un buton per ofertă. Deep link `mixai://title/<kind>/<tmdbId>` (Watch Next). Profil implicit `default`. |
| **TV Tizen** | `apps/tv-tizen` — `lib/media.ts`, `lib/launch.ts`, `screens/Title.tsx` | Aceeași structură; ofertele se deschid cu `tizen.application.launchAppControl` către `appId`-ul platformei. Profil = `userId` din config, altfel `default`. |
| **MMO Server** | `GET /media/home?profile=`, `/media/title/:kind/:id`, `/media/search?q=`, `/media/progress` (GET/PUT), `/media/plays`, `/media/status`, `/media/library` | Toate cer `x-device-token`. `/media/status` arată `tmdb`, `motn`, `region`, `revision`, `sync.last`. |

### Platforme (registru `server/src/media/providers.ts`)

Datele de lansare returnate în `availability.offers[].launch`. „Verificat” = deschis efectiv pe Google TV (2026-09-18).

| Platformă | TMDB id | Android (pachet) | Tizen (`appId`) | Link | Verificat pe Google TV |
|---|---|---|---|---|---|
| Netflix | 8, 1796 | `com.netflix.ninja` | `3201907018807` | `netflix.com/search?q=` → **nu** e acceptat de aplicația TV (doar `/title/*`, `/watch/*`, `/browse`, `nflx://`) → se deschide browserul | Browser deschis (`ProviderLauncher: started * → netflix.com/search…`); aplicația Netflix cere `/title/<id>` (link exact = MOTN) |
| Disney+ | 337 | `com.disney.disneyplus` | `3201901017640` | `disneyplus.com/search/<q>` | Da: `topResumedActivity=com.disney.disneyplus/…MainActivity` |
| HBO Max | 1899, 384 | `com.wbd.stream` | `3202301029760` | `play.max.com/search?q=` | pachet lipsă pe TV (are `com.hbo.hbonow`) |
| Amazon Prime Video | 9, 10, 119 | `com.amazon.amazonvideo.livingroom` | `3201910019365` | `primevideo.com/search/…` | pachet lipsă pe TV |
| Apple TV+ | 350, 2 | `com.apple.atve.androidtv.appletv` | `3201807016597` | `tv.apple.com/ro/search?term=` | neverificat |
| SkyShowtime | 1773 | `com.skyshowtime.skyshowtime.google` | `3202208028071` | `skyshowtime.com/ro/search?q=` | pachet lipsă pe TV |
| YouTube | 192 | `com.google.android.youtube.tv` | `111299001912` | `youtube.com/results?search_query=` | `resolve-activity` → `ShellActivity` (acceptă orice URL youtube) |
| Voyo | 1002 | `net.cme.voyo.ro.tvapp` | `111299000769` | `voyo.protv.ro/cauta?q=` | neverificat |
| AntenaPLAY | 1932 | `ro.antenaplay.app` | `3201611011005` | `antenaplay.ro/cauta?q=` | neverificat |
| Google Play Movies | 3 | `com.google.android.videos` | — | `play.google.com/store/search?c=movies` | neverificat |

Ordinea în `ProviderLauncher.launch`: URL fixat pe pachet → orice handler (browser) → Play Store. Netflix pică la pasul 2
pentru că filtrul lui de intent nu include `/search`; cu `MOTN_API_KEY` oferta primește `link` exact (`/title/<id>`) și
intră direct în aplicație.

### Cum verifici (recipe 2026-09-18, server local 3.1.0 pe `127.0.0.1:17899`)

Token-ul de dispozitiv e în `%APPDATA%\mixai-companion-headless\config.json` → `deviceToken`. Nu-l afișa.

1. **Server**: `GET /media/status` → `"tmdb":true`, `"configured":true`. `GET /media/home?lang=en` → rânduri
   `continue / top_picks / trending_on_your_providers / upcoming / new_in_library`. `GET /media/title/tv/66732` →
   `availability.offers[0].launch.android.package = com.netflix.ninja`.
2. **Google TV** (`adb -s 192.168.100.31:38017`): `am start -a android.intent.action.VIEW -d mixai://title/tv/84958 ro.mixai.tv`
   → `uiautomator dump` conține `Where to watch | Disney Plus | Subscription`; focusul e pe prima ofertă →
   `input keyevent KEYCODE_DPAD_CENTER` → `dumpsys activity activities | Select-String topResumedActivity` arată pachetul
   platformei; `logcat -d | Select-String ProviderLauncher`. Prima deschidere a Disney+ afișează dialogul Google
   *assisted sign-in* (`com.google.android.gms/.auth…AtvAssistedSignInActivity`) deasupra — a doua apăsare ajunge în aplicație.
3. **Progres**: titlu local (`mixai://title/movie/<id>` cu „Play from <server>”), CENTER, 25 s, `KEYCODE_BACK` →
   `GET /media/progress?profile=default` arată `positionSec` crescut și `revision` incrementat (600 → 619 s, rev 3 → 5);
   `/media/home` rândul `continue` conține titlul. Evidență de redare: `logcat` `ExoPlayerImpl: Init` +
   `MediaCodec … setting surface` (screencap-ul e negru).
4. **Tizen** (`sdb connect 192.168.100.135`, portul 26101 doar cu Developer Mode + repornire completă):
   `sdb shell 0 was_execute mXa1TvApp0.MixAI` → `resumed`; pe PC `Get-NetTCPConnection -LocalPort 17899 | ? RemoteAddress -eq 192.168.100.135`
   arată ~6 sesiuni `Established`. Serverul **nu** loghează cererile HTTP, dlog e gol pentru aplicații web → asta e
   toată dovada automată. Deschiderea unei platforme de pe Tizen e **manuală** (fără injectare de taste peste sdb):
   telecomandă → Acasă → rândul „Alese pentru tine” → un titlu → „Unde vezi” → OK pe ofertă → aplicația platformei apare.
5. **Web autentificat** (`http://localhost:13797`, sesiune Auth.js): `/` la 390/1440/3440 light+dark → h1 „Acasă”,
   rânduri „Continuă vizionarea”, „Albume noi”; axe pe `main` (fără `color-contrast`) → 1 încălcare `aria-allowed-role`.
   `/media/movie/<id>` afișează „Titlu indisponibil — niciun MixAI Server online” dacă `devices.lan_url` al serverelor
   nu răspunde (aici: `192.168.100.61:17899` vechi, serverul local nu s-a re-anunțat pentru că `api.mixai.ro` nu
   rezolvă DNS). Push-ul server→web (`/media/status` → `sync.last.status`) e `offline` cât `webAppUrl` rămâne
   `https://mixai.ro` și DNS-ul lipsește.

### Limite cunoscute

- Rândul `continue` apare doar la ≥ 2 % vizionat; profilul TV Android este `default`, cel Tizen este `userId` —
  progresul nu se împarte între ele până TV Android nu trimite `userId`.
- Fără `MOTN_API_KEY` nu există link exact: Netflix TV nu acceptă URL-uri de căutare, se deschide browserul.
- Web-ul depinde de `devices.lan_url`; un server local care nu ajunge la `api.mixai.ro` rămâne „offline” pe web.
