# 🔴 Live Hybrid — Rekordbox + Circuit Tracks + MIDI

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md) · [🔴 Profesional](../../README.md#-profesional)

| ← Prev | Next → |
|:---|---:|
| [← Multi-Device](03-multi-device.md) | [Backup & Recovery →](05-backup-disaster.md) |

---

> **Pe scurt:** Cum combini rekordbox (DJ) cu Circuit Tracks (live synth/drums)
> și opțional un MIDI keyboard. Setup-ul hibrid definitiv al lui mwrty.

---

## 🎯 Conceptul Hybrid

```mermaid
graph TD
    subgraph DJ["🎛️ DJ Layer — Rekordbox + DDJ-FLX4"]
        RB["Track-uri pregătite<br/>Techno, Manele, Bounce"]
        MIX["Mix cu EQ, FX, tranziții"]
    end
    
    subgraph LIVE["🎹 Live Layer — Circuit Tracks"]
        DRUMS["Drum patterns live"]
        SYNTHS["Synth lines live"]
        FX_CT["FX & filters"]
    end
    
    subgraph MIDI["🎹 MIDI Layer — Keyboard (opțional)"]
        KEYS["Acorduri live"]
        MELODY["Melodii improvizate"]
    end
    
    DJ --> MIXER["🎚️ Mixer Extern"]
    LIVE --> MIXER
    MIDI --> MIXER
    MIXER --> PA["🔊 PA / Boxe"]
    
    style DJ fill:#60a5fa,stroke:#2563eb,color:#000
    style LIVE fill:#4ade80,stroke:#16a34a,color:#000
    style MIDI fill:#c084fc,stroke:#9333ea,color:#000
    style PA fill:#ef4444,stroke:#dc2626,color:#fff
```

---

## 🔌 Setup-uri de Conexiune

### Setup A — Minimal (Fără Mixer Extern)

```
CT Audio Out ──→ Laptop Audio In ──→ rekordbox (ca sample)
DDJ-FLX4 ──→ Laptop USB ──→ rekordbox
Laptop ──→ DDJ Audio Out ──→ 🔊 Boxe
```

> **Limitare:** CT trece prin laptop = latency posibilă.

### Setup B — Cu Mixer Extern (RECOMANDAT)

```
CT Main Out ────→ Mixer Canal 1/2
DDJ-FLX4 Out ──→ Mixer Canal 3/4
MIDI Keys ──────→ CT MIDI In (sau Mixer canal separat)
Mixer Main ────→ 🔊 PA / Boxe
```

### Setup C — Cu Audio Interface

```
CT ─────────→ Audio Interface Input 1/2
DDJ-FLX4 ──→ Audio Interface Input 3/4
Audio IF ──→ Laptop (DAW monitor / recording)
Audio IF ──→ 🔊 Monitors
```

---

## 🔄 MIDI Sync — CT și Rekordbox pe Același Tempo

```mermaid
sequenceDiagram
    participant CT as Circuit Tracks
    participant USB as USB-C
    participant LAP as Laptop
    participant RB as Rekordbox
    
    CT->>USB: MIDI Clock Out
    USB->>LAP: USB MIDI
    LAP->>RB: External MIDI Clock
    Note over RB: BPM urmează CT!
    RB-->>CT: Sincronizat!
```

### Configurare:

1. **CT** → Settings → MIDI Clock → **Send** = ON
2. **CT** → USB → Laptop
3. **Rekordbox** → Preferences → MIDI → External Clock = Circuit Tracks
4. Setezi BPM pe CT → rekordbox urmează automat

### Alternativ: Rekordbox ca Master

1. **Rekordbox** → MIDI Clock → **Send** = ON
2. **CT** → Settings → MIDI Clock → **Receive** = ON
3. CT urmează BPM-ul din rekordbox

---

## 🎹 Performance Flow: DJ + Live

### Scenariul Tipic:

```mermaid
graph LR
    A["🎛️ DJ Mix<br/>(2 track-uri rekordbox)"] -->|"tranziție"| B["🎹 CT Layer<br/>Intră cu drums CT"]
    B --> C["🎛️ + 🎹 Hybrid<br/>Track RB + CT simultan"]
    C --> D["🎹 CT Solo<br/>Break live"]
    D --> E["🎛️ DJ Mix<br/>Revii la track-uri"]
    
    style A fill:#60a5fa,stroke:#2563eb,color:#000
    style B fill:#4ade80,stroke:#16a34a,color:#000
    style C fill:#facc15,stroke:#ca8a04,color:#000
    style D fill:#4ade80,stroke:#16a34a,color:#000
    style E fill:#60a5fa,stroke:#2563eb,color:#000
```

### Workflow Detaliat:

1. **Mixezi normal** cu rekordbox (Track A → Track B)
2. În timp ce Track B merge, **pornești CT** cu un pattern complementar
3. **Ridici volumul CT** pe mixer — publicul aude drums/synths live
4. **Oprești/coborzi Track B** — rămâi pe CT (solo live)
5. **Improvizezi** pe CT (schimbi patterns, filtre, FX)
6. **Încarcă Track C** în rekordbox, sincronizat cu CT
7. **Ridici Track C** + coborzi CT → întorci la DJ mode
8. **Repeti** ciclul

---

## 🎹 MIDI Keyboard Integration

Dacă ai acces la o claviatură MIDI (de la vărul tău):

### Conexiune:

```
MIDI Keyboard ──→ CT MIDI In (5-pin DIN)
                   sau
MIDI Keyboard ──→ Laptop USB ──→ Software Synth
```

### Ce Poți Face:

- **Acorduri live** peste un track de rekordbox
- **Melodii** improvizate în Key-ul track-ului curent
- **Pads** — trigger samples sau one-shots

> **💡 Sfat:** Verifică Key-ul track-ului curent în rekordbox (ex: 8A = A minor)
> și cântă în A minor pe keyboard!

---

## 📋 Checklist Setup Hybrid

- [ ] CT sincronizat cu rekordbox (MIDI Clock)
- [ ] Mixer extern (sau routing prin laptop)
- [ ] Știu să intru/ies din CT layer în timpul mixului
- [ ] Am patterns pe CT care merg cu genurile mele
- [ ] (Opțional) MIDI keyboard conectat la CT sau laptop

> **📋 Referință CT:** [circuit-tracks-mwrty](../../../circuit-tracks-mwrty/) — Ghidul complet CT

---

| ← Prev | Next → |
|:---|---:|
| [← Multi-Device](03-multi-device.md) | [Backup & Recovery →](05-backup-disaster.md) |

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)
