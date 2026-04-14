# 🟡 Mixaj Armonic — Camelot Wheel & Key Compatibility

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md) · [🟡 Avansat](../../README.md#-avansat)

| ← Prev | Next → |
|:---|---:|
| [← Playlisturi Inteligente](03-playlisti-inteligente.md) | [Efecte Avansate →](05-efecte-avansate.md) |

---

> **Pe scurt:** Cum mixezi track-uri care sună bine împreună folosind
> sistemul Camelot. Diferența dintre un DJ ok și unul profesionist.

---

## 🎯 De Ce Contează Key-ul?

Două track-uri cu key-uri **incompatibile** sună dizarmonic (urât) când se suprapun.
Două track-uri cu key-uri **compatibile** sună natural — ca și cum ar fi fost create împreună.

---

## 🎡 Camelot Wheel — Complet

```mermaid
graph TD
    subgraph WHEEL["🎡 Camelot Wheel"]
        direction TB
        subgraph MINOR["A = Minor (melancolie, energie dark)"]
            A1["1A<br/>Ab min"]
            A2["2A<br/>Eb min"]
            A3["3A<br/>Bb min"]
            A4["4A<br/>F min"]
            A5["5A<br/>C min"]
            A6["6A<br/>G min"]
            A7["7A<br/>D min"]
            A8["8A<br/>A min"]
            A9["9A<br/>E min"]
            A10["10A<br/>B min"]
            A11["11A<br/>F# min"]
            A12["12A<br/>Db min"]
        end
        
        subgraph MAJOR["B = Major (vesel, energic, uplifting)"]
            B1["1B<br/>B maj"]
            B2["2B<br/>F# maj"]
            B3["3B<br/>Db maj"]
            B4["4B<br/>Ab maj"]
            B5["5B<br/>Eb maj"]
            B6["6B<br/>Bb maj"]
            B7["7B<br/>F maj"]
            B8["8B<br/>C maj"]
            B9["9B<br/>G maj"]
            B10["10B<br/>D maj"]
            B11["11B<br/>A maj"]
            B12["12B<br/>E maj"]
        end
    end
    
    style MINOR fill:#1e293b,stroke:#475569,color:#e2e8f0
    style MAJOR fill:#fefce8,stroke:#ca8a04,color:#1e293b
```

---

## 📋 Reguli de Compatibilitate

### Cele 3 Reguli de Aur:

```mermaid
graph LR
    TRACK["🎵 Track-ul tău<br/>ex: 8A"] --> R1["✅ Regula 1<br/>Același key<br/>8A → 8A"]
    TRACK --> R2["✅ Regula 2<br/>±1 pe aceeași literă<br/>8A → 7A sau 9A"]
    TRACK --> R3["✅ Regula 3<br/>Switch A↔B<br/>8A → 8B"]
    
    style TRACK fill:#667eea,stroke:#764ba2,color:#fff
    style R1 fill:#4ade80,stroke:#16a34a,color:#000
    style R2 fill:#4ade80,stroke:#16a34a,color:#000
    style R3 fill:#4ade80,stroke:#16a34a,color:#000
```

| Regulă | Din | Merge Cu | Efect |
|--------|-----|----------|-------|
| **Same Key** | 8A | 8A | Identic — perfect |
| **±1 Same Letter** | 8A | 7A, 9A | Subtil, natural |
| **A↔B Switch** | 8A | 8B | Schimbare mood (minor↔major) |

### Opțiuni totale de la **8A**:

```
  7A ← 8A → 9A     (±1 same letter)
        ↕
       8B           (A↔B switch)
  7B ← 8B → 9B     (±1 pe 8B)

  = 5 opțiuni 100% sigure per track
```

---

## 🔥 Tehnici Avansate

### Energy Boost (+2 sau +7)

- **+2:** 8A → 10A = salt energetic dramatic
- **+7:** 8A → 3A = "perfect fifth" — sună epic

> **⚠️ Risc:** +2 și +7 sunt avansate. Key-urile se suprapun mai puțin.
> Folosește doar pe tranziții scurte sau cu tracks instrumentale.

### Mood Shift (A↔B)

- **8A** (A minor — melancolie) → **8B** (C major — bucurie)
- Efect: ridici mood-ul publicului
- Perfect pentru: build-up → drop

---

## 📊 Key-uri Frecvente per Gen (pentru tine)

| Gen | Key-uri Frecvente | Camelot |
|-----|-------------------|---------|
| **Techno** | Am, Em, Dm, Gm | 8A, 9A, 7A, 6A |
| **Tech House** | Cm, Gm, Dm | 5A, 6A, 7A |
| **Bounce** | Cm, Fm, Gm, Bb | 5A, 4A, 6A, 6B |
| **Acid** | Am, Dm, Em | 8A, 7A, 9A |
| **Psy** | Em, Am, Bm | 9A, 8A, 10A |
| **Manele** | Dm, Am, Gm, Hicaz* | 7A, 8A, 6A |
| **Balkanică** | Dm, Gm, Am | 7A, 6A, 8A |
| **Latino** | Am, Dm, Cm | 8A, 7A, 5A |

> \* Manelele folosesc adesea scale orientale (Hicaz, Nikriz) care nu se mapează perfect pe Camelot. Ascultă cu urechea!

---

## 🎧 Workflow Practic de Harmonic Mixing

```mermaid
graph TD
    A["🎵 Track A pe deck<br/>Key: 8A, BPM: 130"] --> B["🔍 Caută Track B<br/>Key: 7A, 8A, 9A sau 8B"]
    B --> C["📊 Filtrează și BPM<br/>125-135 BPM"]
    C --> D["🎧 Pre-listen<br/>Sună bine împreună?"]
    D -->|"✅ Da"| E["🎯 Mix it!"]
    D -->|"❌ Nu"| F["Alege alt track"]
    F --> B
    
    style A fill:#667eea,stroke:#764ba2,color:#fff
    style E fill:#4ade80,stroke:#16a34a,color:#000
```

### În Rekordbox:

1. Track A pe deck. Notează **Key** (ex: 8A)
2. În Collection, sortează coloana **Key**
3. Caută track-uri 7A, 8A, 9A, 8B
4. Filtrează și după **BPM** (±5 BPM)
5. Ascultă cu **Dual Players** (Export Mode) sau **pre-listen** (Performance Mode)
6. Alege track-ul care sună cel mai bine → mix!

> **💡 Sfat:** Collection Radar face exact asta automat!

---

## 📖 Tabel Complet de Compatibilitate

| Key | ✅ Perfect | ✅ Bun | ⚠️ Risky |
|-----|-----------|--------|----------|
| 1A | 12A, 1A, 2A, 1B | 11A, 3A | Rest |
| 2A | 1A, 2A, 3A, 2B | 12A, 4A | Rest |
| 3A | 2A, 3A, 4A, 3B | 1A, 5A | Rest |
| 4A | 3A, 4A, 5A, 4B | 2A, 6A | Rest |
| 5A | 4A, 5A, 6A, 5B | 3A, 7A | Rest |
| 6A | 5A, 6A, 7A, 6B | 4A, 8A | Rest |
| 7A | 6A, 7A, 8A, 7B | 5A, 9A | Rest |
| **8A** | **7A, 8A, 9A, 8B** | **6A, 10A** | Rest |
| 9A | 8A, 9A, 10A, 9B | 7A, 11A | Rest |
| 10A | 9A, 10A, 11A, 10B | 8A, 12A | Rest |
| 11A | 10A, 11A, 12A, 11B | 9A, 1A | Rest |
| 12A | 11A, 12A, 1A, 12B | 10A, 2A | Rest |

> Același principiu se aplică pentru B-uri (major).

---

## ✅ Checklist

- [ ] Înțeleg sistemul Camelot (A = minor, B = major, numere 1-12)
- [ ] Știu cele 3 reguli de compatibilitate
- [ ] Folosesc coloana Key în rekordbox
- [ ] Sortez/filtrez track-uri după key compatibil
- [ ] Am experimentat cu energy boost (+2, +7)
- [ ] Știu că manelele/populara au limitări cu Camelot

---

| ← Prev | Next → |
|:---|---:|
| [← Playlisturi Inteligente](03-playlisti-inteligente.md) | [Efecte Avansate →](05-efecte-avansate.md) |

[🏠 Home](../../README.md) · [🗺️ Navigare](../../NAVIGARE.md)
