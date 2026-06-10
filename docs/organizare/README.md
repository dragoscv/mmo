# 📁 Sistem de Organizare Muzică — Overview

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)

---

> **Pe scurt:** Sistemul complet de organizare a muzicii tale.
> De la structura pe disk, la taguri în rekordbox, la export USB.

---

## 🧠 Filozofia

```mermaid
graph TD
    DISK["💿 DISK (H:\Music)<br/>Organizare fizică a fișierelor"] --> RB["🎧 REKORDBOX<br/>Organizare logică (playlisturi, taguri)"]
    RB --> USB["💾 USB<br/>Export pentru performance"]
    
    DISK -.->|"referințe"| RB
    RB -.->|"copiere"| USB
    
    style DISK fill:#60a5fa,stroke:#2563eb,color:#000
    style RB fill:#667eea,stroke:#764ba2,color:#fff
    style USB fill:#4ade80,stroke:#16a34a,color:#000
```

**3 niveluri de organizare:**

1. **Disk** — Fișierele pe H:\Music (structura de foldere)
2. **Rekordbox** — Playlisturi, taguri, cue-uri (organizare logică)
3. **USB** — Export selectiv pentru gig-uri

---

## 📋 Ghiduri

| Document | Ce Rezolvă |
|----------|-----------|
| [📂 Structură Foldere](structura-foldere.md) | Cum organizezi fișierele pe disk |
| [🏷️ Sistem Taguri](sistem-taguri.md) | Clasificare multi-dimensională în rekordbox |
| [📝 Convenții Fișiere](conventii-fisiere.md) | Cum denumești fișierele |
| [🔍 Workflow Scanare](workflow-scanare.md) | Scanare automată, watch folders |
| [💿 Gestionare Drive-uri](gestionare-drive-uri.md) | Multiple drive-uri & surse |
| [💾 Export USB](export-usb.md) | Export complet pe USB |
| [📊 BPM / Key / Energy](bpm-key-energy.md) | Categorizare completă |

---

[🏠 Home](../../README.md)
