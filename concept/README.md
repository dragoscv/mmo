# 💡 Concept — MMO Multi Media Organizer

> **Scopul acestei secțiuni:** capturăm deciziile produs și arhitecturale care definesc MMO ca **suite**, nu doar ca aplicație web.

[🏠 Home](../README.md) · [🗺️ Navigare](../NAVIGARE.md)

---

## 🎯 Viziunea pe scurt

MMO = un **ecosistem deschis** pentru DJ-i și producători care vor:

1. **Să dețină** propria bibliotecă (no vendor lock-in, fișiere locale, schemă deschisă)
2. **Să combine** workflow rekordbox cu unelte moderne (web, AI, colaborare remote)
3. **Să cânte live** flexibil (DJ + DAW + sample triggers + MIDI hardware)
4. **Să rămână self-hostable** (web app + companion + TURN se pot rula independent)

Componentele lucrează împreună, dar **fiecare are sens singură** — poți folosi doar web app-ul, doar companion-ul, doar extensia, sau toate.

---

## 🧱 Componente (din perspectivă produs)

| Componentă | Rol în experiența utilizatorului | Audiență primară |
|---|---|---|
| **Web App** ([`app/`](../app/)) | Centrul experienței: bibliotecă, mixaj, DAW, live, settings, recordings | Toți DJ-ii / producătorii |
| **MMO Companion** ([`server/`](../server/)) | "Punte" nativă pentru audio/MIDI/file system care nu funcționează în browser | Useri pro care vor latență joasă, hardware MIDI, watch folders OS-level |
| **Browser Extension** ([`extension/`](../extension/)) | "One-click capture" din 15+ platforme streaming în bibliotecă | Curatori, crate-diggeri, oameni care descoperă tracks online |
| **Infra TURN** ([`infra/terraform/`](../infra/terraform/)) | Relay WebRTC pentru remote/colaborare când peers sunt în spatele NAT-uri stricte | Useri care fac mixuri colaborative, B2B, lecții remote |

---

## 📚 Documente în această secțiune

| Document | Subiect |
|----------|---------|
| [arhitectura.md](arhitectura.md) | Arhitectura tehnică umbrella (web + companion + extension + infra) |
| [functionalitati.md](functionalitati.md) | Feature matrix complet + roadmap versiuni |
| [ui-ux.md](ui-ux.md) | Sistem design vizual (paletă, typography, layout, dark mode) |
| [drive-manager.md](drive-manager.md) | Modul Drive Manager — detectare, format, export USB CDJ |
| [scanner.md](scanner.md) | Modul Scanner — watch folders, formate suportate, pipeline analiză |

### Documente legacy (păstrate ca referință istorică)

| Document | De ce e legacy |
|----------|----------------|
| [legacy-app-readme.md](legacy-app-readme.md) | Vechiul `concept/README.md` — vorbește doar de "music organizer app" (înainte de DAW/live/remote/companion/extension) |
| [legacy-arhitectura.md](legacy-arhitectura.md) | Vechea arhitectură doar pentru web app monolit — payload util pentru istorie ERD/Drizzle |

---

## 🔄 Cum se leagă această secțiune de restul docs

```
concept/  ─── DE CE & CE construim ────────────►  produsul
   │
   ▼
docs/arhitectura/  ─── CUM se conectează componentele
   │
   ▼
docs/aplicatie/, docs/companion/, docs/extension/  ─── CUM le folosești
   │
   ▼
app/README.md, server/README.md, extension/README.md  ─── CUM le rulezi în dev
```

Dacă vrei să **înțelegi viziunea** → rămâi aici (`concept/`).
Dacă vrei să **înțelegi codul** → mergi la `docs/arhitectura/`.
Dacă vrei să **înveți să folosești** → mergi la `docs/aplicatie/` (sau `docs/companion/`, `docs/extension/`).
Dacă vrei să **contribui** → mergi la README-ul componentei (ex. `app/README.md`).

---

[🏠 Home](../README.md)
