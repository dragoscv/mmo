# 🧩 Browser Extension — Ghid utilizator

> Extensia Chrome care detectează audio/video pe platforme streaming și îl capturează în biblioteca MMO cu un click.

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

## 📚 Documente

| Document | Subiect |
|----------|---------|
| [platforme-suportate.md](platforme-suportate.md) | Lista celor 15 platforme + ce funcționează unde |
| [cum-functioneaza.md](cum-functioneaza.md) | Cum lucrează extensia cu web app + companion |

> Aceste ghiduri sunt în curs de scriere. Pentru setup dev → [`extension/README.md`](../../extension/README.md).

---

## ⚡ Instalare rapidă (development build)

> **Notă**: extensia nu e încă publicată pe Chrome Web Store. Momentan se instalează manual.

1. Descarcă / clonează folderul `extension/` din [github.com/dragoscv/mmo](https://github.com/dragoscv/mmo)
2. Deschide Chrome → `chrome://extensions`
3. Activează **Developer mode** (toggle dreapta sus)
4. Click **Load unpacked** → selectează folderul `extension/`
5. Extensia apare cu iconul MMO în toolbar

---

## 🌐 Platforme suportate

15 platforme:
- 🟥 YouTube + YouTube Music
- 🟧 SoundCloud
- 🟢 Spotify (doar metadate, fără download direct — DRM)
- 🟦 Bandcamp
- 🟪 Mixcloud
- 🟦 Vimeo
- ⬛ TikTok
- 🟦 Twitter / X
- 🟪 Instagram
- 🟦 Facebook
- 🟪 Twitch
- 🟧 Dailymotion
- 🟪 Deezer (doar metadate)

→ Detalii [platforme-suportate.md](platforme-suportate.md)

---

## 🎯 Cum o folosești

1. Deschide o pagină pe orice platformă suportată (ex: youtube.com/watch?v=...)
2. Vei vedea un buton **"Capture to MMO"** lângă track / video
3. Click → extensia trimite metadatele la MMO Web App
4. În MMO Web App, track-ul apare în coada de download (`/download`)
5. Dacă ai **MMO Companion** instalat, descărcarea pornește automat
6. Când e gata, track-ul apare în bibliotecă (`/library`)

---

## ⚙️ Configurare

Click dreapta pe iconul extensiei → **Options**:

- **MMO Web App URL**: implicit `https://muzicai.ro`; pentru dev local pune `http://localhost:3000`
- **Auto-download**: dacă da, descarcă imediat ce ai dat capture; dacă nu, doar adaugă în coadă
- **Calitate audio**: 128 / 192 / 256 / 320 kbps (când e posibil)

---

## 🔐 Permisiuni cerute

Extensia cere **doar**:
- `storage` — pentru config local
- `activeTab` — pentru a rula scripturi temporar

**NU** are acces la istoric browser, parole, sau alte tab-uri.

`host_permissions` e limitat la **doar cele 15 domenii muzicale** — nu wildcard `*://*/*`.

---

## ⚠️ Considerații legale

> Extensia capturează doar **metadate** și deleagă descărcarea efectivă către MMO Web App / Companion. Tu ești responsabil să respecți termenii fiecărei platforme și legile copyright din țara ta.
>
> Nu folosi extensia pentru a redistribui muzică deținută de alții. Pentru utilizare profesională în club, asigură-te că ai licență/dreptul de a reda track-urile (PRO licensing).

---

[🏠 Home](../../README.md)
