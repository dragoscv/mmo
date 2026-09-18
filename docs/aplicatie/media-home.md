# 🎬 Media Home

> Pagina de start MixAI (`/` pe web, „Acasă” pe TV): un singur ecran cu **Continuă vizionarea**, recomandări,
> ce e în trend pe platformele tale și ce e nou în bibliotecă — de pe **toate** serverele MMO conectate.
> Creierul este **MMO Server** (≥ 3.1, modulul `server/src/media/`); web-ul și TV-urile doar afișează.
> Decizii: [ADR-0009](../adr/0009-remove-third-party-embed-sources.md) (fără embed-uri pirat), [ADR-0010](../adr/0010-media-module-and-media-home.md).
> Plan și stare: [tracker §10–§11](../mixai-design-tracker.md).

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md) · [⬅️ Aplicație](README.md)

---

## Ce este

| Concept | Detaliu |
|---|---|
| **Titlu** | Un film sau serial identificat prin `kind/tmdbId` (ex. `tv/66732` = Stranger Things). Metadatele (poster, sinopsis, gen, rating) vin din TMDB prin server, cu cache 30 zile. |
| **Rânduri** | `continue` (progres ≥ 2 %), `top_picks` (recomandări din istoricul tău), `because_you_watched_*`, `trending_on_your_providers`, `upcoming`, `new_in_library`. Serverul le construiește în `buildHomeRows` (cache 24 h). |
| **Oferte („Unde vezi”)** | Pentru fiecare titlu, lista platformelor unde e disponibil în regiunea ta (RO): MOTN (link exact, dacă există `MOTN_API_KEY`) → TMDB *watch/providers* (date JustWatch) → URL de căutare al platformei. Fiecare ofertă poartă date de lansare pe web / Android / Tizen. |
| **Progres** | Poziția în secunde per profil, ținută pe server (`PUT /media/progress`), trimisă și către web (`/api/media/sync`) când `webAppUrl` e accesibil. TV-urile au coadă locală de rezervă. |
| **Fără embed-uri** | Nu există player pentru surse externe: un titlu se **redă** doar dacă e în biblioteca unui server MMO, altfel se **deschide aplicația platformei**. |

## Suprafețe

| Suprafață | Unde | Ce face |
|---|---|---|
| **Web** | `/` (`app/page.tsx` → `MediaHome`), `/media/[kind]/[tmdbId]`, `/settings/media`, vechiul panou la `/dashboard` | Agregă toate serverele utilizatorului (`aggregateAcrossCompanions`), dedup pe `tmdbId`, cipuri per server, stare *offline* per server. Serverele sunt căutate la `devices.lan_url` — un server local nepublicat nu apare. |
| **TV Android** | `apps/tv-android` — `MediaRepository`, `ui/MediaRows.kt`, `ui/TitleScreen.kt`, `ProviderLauncher` | Erou + rânduri; ecranul de titlu are „Redă de pe <server>” pentru fișiere locale și un buton per ofertă. Deep link `mixai://title/<kind>/<tmdbId>` (Watch Next). Profil implicit `default`. |
| **TV Tizen** | `apps/tv-tizen` — `lib/media.ts`, `lib/launch.ts`, `screens/Title.tsx` | Aceeași structură; ofertele se deschid cu `tizen.application.launchAppControl` către `appId`-ul platformei. Profil = `userId` din config, altfel `default`. |
| **MMO Server** | `GET /media/home?profile=`, `/media/title/:kind/:id`, `/media/search?q=`, `/media/progress` (GET/PUT), `/media/plays`, `/media/status`, `/media/library` | Toate cer `x-device-token`. `/media/status` arată `tmdb`, `motn`, `region`, `revision`, `sync.last`. |

## Platforme (registru `server/src/media/providers.ts`)

Datele de lansare returnate în `availability.offers[].launch`. „Verificat” = deschis efectiv pe Google TV (2026-09-18).

| Platformă | TMDB id | Android (pachet) | Tizen (`appId`) | Link | Verificat pe Google TV |
|---|---|---|---|---|---|
| Netflix | 8, 1796 | `com.netflix.ninja` | `3201907018807` | `netflix.com/search?q=` → **nu** e acceptat de aplicația TV (doar `/title/*`, `/watch/*`, `/browse`, `nflx://`) → se deschide browserul | Browser deschis (`ProviderLauncher: started * → netflix.com/search…`); aplicația Netflix cere `/title/<id>` (link exact = MOTN) |
| Disney+ | 337 | `com.disney.disneyplus` | `3201901017640` | `disneyplus.com/search/<q>` | ✅ `topResumedActivity=com.disney.disneyplus/…MainActivity` |
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

## Cum verifici (recipe 2026-09-18, server local 3.1.0 pe `127.0.0.1:17899`)

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

## Limite cunoscute

- Rândul `continue` apare doar la ≥ 2 % vizionat; profilul TV Android este `default`, cel Tizen este `userId` —
  progresul nu se împarte între ele până TV Android nu trimite `userId`.
- Fără `MOTN_API_KEY` nu există link exact: Netflix TV nu acceptă URL-uri de căutare, se deschide browserul.
- Web-ul depinde de `devices.lan_url`; un server local care nu ajunge la `api.mixai.ro` rămâne „offline” pe web.
