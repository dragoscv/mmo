# 📺 Casting („Redă pe…”)

> Trimite un film, un episod sau o piesă de pe MixAI către TV, Chromecast, Nest Hub
> sau orice boxă / player controlat de Home Assistant.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md) · ADR: [0003-casting-strategy](../adr/0003-casting-strategy.md)

---

## 🎯 Ce faci aici

- Butonul **Cast** (📡) apare în colțul din dreapta-sus al playerului video și în bara
  playerului de muzică, lângă coadă.
- Alegi un dispozitiv din listă → redarea locală se pune pe pauză și TV-ul / boxa preia
  fluxul **direct de la companion**, prin LAN. Browserul nu mai transportă niciun byte.
- Cât timp o sesiune e activă, în locul butonului apare pastila **„Redare pe <nume>”**
  cu Pauză / Reia / Oprește.

---

## 🧩 Tipuri de dispozitive

| În listă | Cum funcționează | Cine face transportul |
|---|---|---|
| **Chromecast (acest browser)** | Google Cast Web Sender SDK, Default Media Receiver (`CC1AD845`). Doar Chrome / Edge / Brave. | Browserul deschide sesiunea; Chromecast-ul descarcă fluxul de la companion. |
| **DLNA / UPnP** | Companion-ul face SSDP M-SEARCH (`MediaRenderer:1`), apoi SOAP `SetAVTransportURI` + `Play` pe AVTransport. Fără nicio dependență npm. | TV-ul (ex. Samsung Odyssey OLED G8, LG, Kodi) descarcă fișierul progresiv. |
| **Home Assistant** | `media_player.play_media` prin REST API-ul HA. Include și Chromecast-urile expuse de HA (grupate ca *Google Cast prin Home Assistant*). | Entitatea HA. Funcționează din orice browser, inclusiv Firefox / mobil. |

Lista vine din `GET /cast/devices` pe companion (DLNA + HA, cache 60 s; butonul ↻ forțează
o nouă căutare). Intrarea „Chromecast (acest browser)” e adăugată doar de client, când SDK-ul
Cast raportează că e disponibil.

---

## 🌐 Cerința LAN

Dispozitivul care redă trebuie să **ajungă singur** la companion. URL-urile trimise sunt
construite din `devices.lan_url` (același câmp ca `/api/devices/peers`) — adresa anunțată
de companion prin mDNS, ex. `http://192.168.100.20:17899` — cu autentificare în query
(`?t=<device-token>&u=<user-id>`), pentru că un TV nu poate seta header-e.

- Rutele companion-ului `/video/direct`, `/video/stream` (HLS), `/video/subs` și `/audio/*`
  acceptă `?t=&u=`.
- **Nu** se folosește tunelul Cloudflare: DLNA cere `http://` simplu, iar redarea ar ieși
  din LAN și s-ar întoarce.
- Dacă companion-ul nu are `lan_url` (nu a anunțat încă), se folosește `api_url`.

---

## 🏠 Configurare Home Assistant

Pe mașina companion-ului setează **fie** variabilele de mediu, **fie** cheile din
`config.json` al companion-ului (`<userData>/config.json`):

```
HA_URL=http://192.168.100.232:8123
HA_TOKEN=<long-lived access token din Profil → Securitate>
```

sau în `config.json`: `"haUrl": "...", "haToken": "..."`. Env are prioritate.

Fără configurare, `/cast/devices` întoarce `haConfigured: false` și pickerul afișează
un hint discret; DLNA și Cast-din-browser funcționează în continuare.

Entitățile listate sunt toate `media_player.*` cu feature-ul `PLAY_MEDIA`. Exemple din
casa de test: `media_player.sufragerie`, `media_player.kitchen_tv` (Chromecast HD),
`media_player.bedroom_smart_display` (Nest Hub), `media_player.34_odyssey_oled_g8_…`.

---

## 🎞️ Ce format primește fiecare dispozitiv

| Țintă | Video | Audio |
|---|---|---|
| Cast (browser sau HA) | MP4 H.264/AAC direct **dacă** fișierul e compatibil; altfel **HLS** remuxat de companion (`/video/stream`, fmp4). **MKV nu e suportat** de Default Media Receiver. | Fișierul original (`/audio/<path>`), MIME după extensie. |
| DLNA | **Întotdeauna progresiv** (`/video/direct`), cu MIME-ul containerului (`video/x-matroska` etc.). TV-urile Samsung/LG redau MKV/H.264/AC3 nativ; HLS nu e implementat de majoritatea rendererelor. | La fel. |

Subtitrări: pistele text încorporate (SRT/ASS/mov_text) sunt trimise ca **WebVTT** din
`/video/subs/:fileId/:idx` (companion-ul le convertește la cerere). Cast le primește ca
`Track` TEXT/SUBTITLES cu prima pistă activă; DLNA le primește în DIDL-Lite
(`<res protocolInfo="http-get:*:text/vtt:*">` + `sec:CaptionInfoEx`, respectat de Samsung).
Subtitrările imagine (PGS/VobSub) nu sunt disponibile în faza 1.

Reluarea de la poziția curentă: Cast folosește `currentTime` la load; DLNA/HA primesc un
`Seek`/`media_seek` ~1,5 s după `Play`.

---

## ⚠️ Limitări (faza 1)

- Cast-din-browser: doar Chromium. Pe Firefox / iOS folosește ruta prin Home Assistant.
- Cast: fără MKV, HEVC-in-TS, DTS, TrueHD → cade automat pe HLS remux (video copiat, audio → AAC).
- DLNA: doar `http://` (renderer-ele nu validează TLS); fără control de volum (nu implementăm
  RenderingControl încă); starea nu se sincronizează în UI (pastila e optimistă).
- Companion-ul trebuie să fie **pornit și în aceeași rețea** cu dispozitivul.
- Un singur companion e folosit pentru descoperire (cel „curent”, online-first).
- Fără flux invers de progres: `watch_history` nu se actualizează în timpul redării remote.

Faza 2 (ADR-0003): sidecar Rust `rust_cast` ca serverul să conducă Chromecast-urile singur;
faza 3: receiver CAF propriu + aplicație Tizen (ASS/PGS).

---

## 🛠️ Depanare

| Simptom | Cauză probabilă | Fix |
|---|---|---|
| Lista e goală, doar „Chromecast (acest browser)” | Companion offline sau `/cast/devices` a eșuat | Verifică `GET <lanUrl>/cast/devices` cu header `x-device-token`. Mesajul de eroare apare roșu în picker. |
| TV-ul nu apare la DLNA | Multicast SSDP blocat (VLAN separat, Wi-Fi „AP isolation”, firewall Windows pe UDP 1900) | Pune companion-ul și TV-ul în aceeași rețea; permite `node.exe`/Electron pe UDP în firewall. Apasă ↻. |
| „DLNA SetAVTransportURI failed (500)” / TV-ul afișează „format nesuportat” | Codec neredat de TV (ex. HEVC 10-bit pe TV vechi) | Folosește pre-remux (`.mmo.mp4`) sau castează prin HA/Cast (HLS). |
| Chromecast pornește apoi se oprește imediat | URL LAN inaccesibil (companion pe altă subrețea) sau MKV livrat direct | Verifică `lan_url` în Devices; pentru MKV se alege HLS automat — dacă nu, raportează containerul din DB. |
| HA: „401”/„403” | Token expirat / greșit | Regenerează token-ul long-lived în HA și repornește companion-ul. |
| HA: „Home Assistant not configured” | Env/config lipsă pe companion | Vezi secțiunea de configurare. |
| Pastila rămâne „Redare pe…” după ce TV-ul s-a oprit | Starea remote nu se sincronizează în faza 1 | Apasă ■ (Stop). |
| Subtitrările nu apar pe Chromecast | Pista nu e text (PGS) sau `/video/subs` nu răspunde | Verifică URL-ul WebVTT în browser; PGS nu e suportat. |

Log-uri: companion → consola Electron / `dist/headless.js` (erori SOAP/HA sunt returnate ca
`502 {error}` către web); web → toast-ul roșu conține mesajul companion-ului.
