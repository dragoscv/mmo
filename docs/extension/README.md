# 🧩 Browser Extension — Ghid utilizator

> Extensia Chrome / Firefox care detectează audio/video pe platforme streaming și îl trimite în biblioteca MixAI cu un click.

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

## 📚 Documente

| Document | Subiect |
|----------|---------|
| [platforme-suportate.md](platforme-suportate.md) | Lista celor 15 platforme + ce funcționează unde |
| [cum-functioneaza.md](cum-functioneaza.md) | Cum lucrează extensia cu web app + companion |

> Pentru setup dev → [`apps/extension/README.md`](../../apps/extension/README.md).

---

## ⚡ Instalare rapidă (development build)

> **Notă**: extensia nu e încă publicată pe Chrome Web Store. Momentan se instalează manual.

1. Descarcă / clonează folderul `apps/extension/` din [github.com/dragoscv/mmo](https://github.com/dragoscv/mmo)
2. Deschide Chrome → `chrome://extensions`
3. Activează **Developer mode** (toggle dreapta sus)
4. Click **Load unpacked** → selectează folderul `apps/extension/`
5. Extensia apare cu iconul MixAI în toolbar

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
2. Vei vedea un buton **„MixAI”** lângă track / video (sau plutitor, jos-dreapta)
3. Click → se deschide pagina `/download` din MixAI cu linkul precompletat
4. Cu *Descărcare automată* activă, descărcarea pornește imediat
5. Dacă ai **MixAI Companion** instalat, fișierul ajunge direct pe disc
6. Când e gata, track-ul apare în bibliotecă (`/library`)

---

## ⚙️ Configurare

Click dreapta pe iconul extensiei → **Options**:

- **URL-ul aplicației MixAI**: implicit `https://mixai.ro`; pentru dev local pune `http://localhost:13789`
- **Descărcare automată la click**: dacă da, descărcarea pornește imediat ce se deschide pagina
- **Doar audio**: cere doar pista audio (`audio=1`)

---

## 🔐 Permisiuni cerute

Extensia cere **doar**:
- `storage` — pentru config local
- `activeTab` — pentru a rula scripturi temporar

**NU** are acces la istoric browser, parole, sau alte tab-uri.

`host_permissions` e limitat la **doar cele 15 domenii muzicale** — nu wildcard `*://*/*`.

---

## ⚠️ Considerații legale

> Extensia capturează doar **metadate** și deleagă descărcarea efectivă către MixAI / MMO Server (Companion). Tu ești responsabil să respecți termenii fiecărei platforme și legile copyright din țara ta.
>
> Nu folosi extensia pentru a redistribui muzică deținută de alții. Pentru utilizare profesională în club, asigură-te că ai licență/dreptul de a reda track-urile (PRO licensing).

---

[🏠 Home](../../README.md)
