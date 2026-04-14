# 🔍 Workflow Scanare — Auto-Scan & Watch Folders

[🏠 Home](../README.md) · [📁 Organizare](README.md)

---

> **Pe scurt:** Cum monitorizezi automat folderele pentru muzică nouă
> și workflow-ul de integrare cu rekordbox.

---

## 🔄 Conceptul Watch Folder

```mermaid
graph TD
    subgraph WATCH["👁️ Monitorizare"]
        INBOX["📥 H:\Music\_Inbox\"]
        DJ["🎧 H:\Music\DJ\"]
    end
    
    WATCH --> DETECT["🔔 Fișier nou detectat!"]
    DETECT --> NOTIFY["📢 Notificare"]
    NOTIFY --> IMPORT["📥 Import în rekordbox"]
    IMPORT --> ANALYZE["🔬 Auto-analyze"]
    ANALYZE --> TAG["🏷️ Clasificare"]
    TAG --> READY["✅ Gata de mix!"]
    
    style DETECT fill:#fb923c,stroke:#ea580c,color:#000
    style READY fill:#4ade80,stroke:#16a34a,color:#000
```

---

## 📋 Workflow Scanare Manuală (Actual)

Până când vei avea aplicația, workflow-ul manual:

### Săptămânal:

1. **Verifică `_Inbox/`** — ce e nou?
2. **Import în rekordbox** — drag & drop folder
3. **Verifică analiză** — BPM și Key corecte?
4. **Setează taguri** — gen, energie, mood
5. **Setează cue points** — minim Hot Cue 1 (First Beat)
6. **Mută** din `_Inbox/` în `DJ/[Gen]/`
7. **Relocalizează** în rekordbox dacă ai mutat fișierul

### La Fiecare Download:

1. **Save** direct în `H:\Music\_Inbox\`
2. Task: procesează în sesiunea următoare

---

## 🤖 Auto-Monitor cu Aplicația (Viitor)

Aplicația Music Organizer va automatiza:

```mermaid
sequenceDiagram
    participant FS as File System
    participant APP as Music Organizer
    participant RB as Rekordbox
    
    FS->>APP: Fișier nou în _Inbox/
    APP->>APP: Analiză automată (BPM, Key)
    APP->>APP: Sugestie gen (pe baza BPM)
    APP->>APP: Mută în DJ/[Gen]/
    APP->>RB: Import/Update XML
    APP-->>FS: ✅ Organizat!
```

> **📋 Detalii:** [App Music Organizer](../app/README.md)

---

## 📁 Foldere de Monitorizat

| Folder | Scop | Frecvență Verificare |
|--------|------|---------------------|
| `H:\Music\_Inbox\` | Muzică nouă descărcată | Zilnic/Săptămânal |
| `H:\Music\DJ\` | Biblioteca principală | La fiecare import |
| `Downloads\` | Descărcări browser | Verificare → mută în _Inbox |
| USB export drives | Verificare sincronizare | Înainte de gig |

---

## ✅ Checklist

- [ ] Am un workflow clar de scanare (săptămânal)
- [ ] _Inbox e golită regulat (nimic nu stă mai mult de 2 săptămâni)
- [ ] Fiecare track importat e complet procesat (analiză + taguri + cues)
- [ ] Nu am track-uri orfane (file not found) în rekordbox

---

[🏠 Home](../README.md) · [📁 Organizare](README.md)
