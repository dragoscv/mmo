# 🎛️ DAW & Sound Editor (`/daw`, `/editor`)

> Două module legate: **DAW** (multi-track timeline) și **Sound Editor** (waveform per track).
> Ambele folosesc același `DAWProvider` context.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎛️ DAW (`/daw`) — Multi-track

### Ce faci

- Compui muzică pe **timeline** cu multiple tracks
- Adaugi **clip-uri** (samples, recordings, MIDI) și le rearanjezi
- Înregistrezi audio direct (mic / instrument)
- Procesezi cu efecte per-track sau master
- Exporți ca WAV / MP3

### Layout

```
┌─────────────────────────────────────────────────┐
│  ⏮ ⏯ ⏺ ⏭   00:01:23 / 00:04:00   ♩=128 ▼      │
├──────┬──────────────────────────────────────────┤
│Track1│ ▓▓▓▓░░▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│Track2│ ░░░░▓▓▓▓░░░░▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░ │
│Track3│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓ │
│Track4│ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
├──────┴──────────────────────────────────────────┤
│ Tools: [▶ Select] [✎ Draw] [✂ Slice] [✗ Erase]│
└─────────────────────────────────────────────────┘
```

### Acțiuni cheie

| Acțiune | Shortcut | Descriere |
|---------|----------|-----------|
| Play / Stop | Space / Enter | Toggle transport |
| Record | R | Armează & start record pe tracks armate |
| Add track | Click "+" | Adaugă track audio sau MIDI |
| Load sample | Drag drop fișier audio pe track | |
| Slice clip | Tool "Slice" + click pe clip | |
| Cut clip | Ctrl+X | |
| Paste | Ctrl+V | |
| Undo / Redo | Ctrl+Z / Ctrl+Y | History infinit |
| Set tempo | Click ♩=128 | |
| Set time signature | Click 4/4 | |
| Save project | Ctrl+S | Salvează în browser storage |
| Export | Ctrl+E | Render WAV/MP3 |

---

## 🎚️ Sound Editor (`/editor`) — Single-track

### Ce faci

- Editezi un **singur fișier audio** la un moment dat
- Trimuiești, fade-uiești, aplici efecte (EQ, filter, compressor)
- Vezi **waveform** + **spectrogram** simultan
- Procesezi voce (vocal cleanup experimental)

### Layout

```
┌────────────────────────────────────────────┐
│  ⏮ ⏯ ⏭   00:00:42 / 00:03:18    ⊕ ⊖ ⛶   │
├────────────────────────────────────────────┤
│  ╱╲╱╲╱╲╱╲╱╲╱╲╱▏╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲    │
│  ╲╱╲╱╲╱╲╱╲╱╲╱╲▕╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱╲╱    │
├────────────────────────────────────────────┤
│  Spectrogram (FFT live)                    │
├──────┬─────────────────────────────────────┤
│ FX   │ EQ │ Filter │ Comp │ Reverb │ Voice │
│ Chain│                                      │
└──────┴─────────────────────────────────────┘
```

### Acțiuni cheie

| Acțiune | Cum |
|---------|-----|
| Load track | Drag-drop sau "Load from library" |
| Select region | Click + drag pe waveform |
| Cut / Copy / Paste / Delete | Edit menu sau shortcuts |
| Apply EQ | Drag knob → preview live |
| Apply filter | HPF / LPF / BPF cu slope variabil |
| Apply compressor | Threshold + ratio + attack + release |
| Apply reverb | Wet/dry + room size |
| Voice processor | Experimental: noise reduction + de-esser |
| Undo / Redo | Ctrl+Z / Ctrl+Y |
| Export | "Export edited" → WAV/MP3 |

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Engine DAW | `daw-engine.ts` (timeline, tracks, clips, automation) |
| Engine Editor | `audio-analyzer.ts` + `audio-fx-engine.ts` |
| FX | AudioWorklet processors în `public/worklets/` |
| State | `useDAW` context (Zustand) — partajat între /daw și /editor |
| History | `history-engine.ts` — undo stack în memorie |
| MIDI input | `midi-engine.ts` |
| Persistență | Browser storage (IndexedDB) pentru proiecte; export ca .json |

---

## 💡 Tips

- **DAW vs Editor**: DAW pentru compoziție multi-track; Editor pentru cleanup/repair la un singur fișier
- **Performance**: dezactivează spectrogram-ul live dacă ai stuttering
- **MIDI controller**: poți folosi keyboard MIDI (Web MIDI API) pentru a înregistra MIDI direct în DAW
- **Browser storage limit**: proiectele mari (>500 MB de samples) → exportează & re-importă la nevoie

---

## ⚠️ Limitări cunoscute

- **Cross-track clip drag**: nu funcționează stabil între tracks (drag în același track OK)
- **Slice tool**: stabilitate variabilă — folosește Cut+Paste ca alternativă
- **Voice Processor**: experimental, calitate variabilă
- **Export**: WAV bun, MP3 dependent de bibliotecă (uneori cu artefacte)

> Roadmap full DAW v1: vezi [`concept/functionalitati.md`](../concept/functionalitati.md)

---

[← Drive Manager](drive-manager.md) · [🎤 Live →](live.md)
