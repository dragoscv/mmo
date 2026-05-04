# 🎚️ Mixer (`/mixer`)

> Mixer DJ 2-deck cu waveform live, EQ 3 benzi, FX, hot cues și suport hardware MIDI.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- Mixezi două track-uri (deck A + deck B) cu crossfader
- Sincronizezi BPM (sync sau manual)
- Aplici efecte (Beat FX, Color FX, filter)
- Setezi & lansezi hot cues
- Înregistrezi mixul (opțional)
- Folosești controller MIDI (DDJ-FLX4) sau doar mouse/keyboard

---

## 🖼️ Layout

```
┌─────────────────────┬─────────────────────┐
│   DECK A            │   DECK B            │
│  ┌───────────────┐  │  ┌───────────────┐  │
│  │ Waveform live │  │  │ Waveform live │  │
│  └───────────────┘  │  └───────────────┘  │
│  Track Title  03:42 │  Track Title  04:18 │
│  ┌───┐ ┌─┐ ┌─┐ ┌─┐  │  ┌───┐ ┌─┐ ┌─┐ ┌─┐  │
│  │JOG│ │T│ │M│ │B│  │  │JOG│ │T│ │M│ │B│  │
│  └───┘ └─┘ └─┘ └─┘  │  └───┘ └─┘ └─┘ └─┘  │
│   1 2 3 4 5 6 7 8   │   1 2 3 4 5 6 7 8   │
│   (hot cues)        │   (hot cues)        │
├─────────────────────┴─────────────────────┤
│        ◄───── CROSSFADER ─────►            │
├────────────────────────────────────────────┤
│  Master | Headphone | Beat FX | Color FX  │
└────────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Acțiune | Cum (mouse / tastatură) | Cum (DDJ-FLX4) |
|---------|--------------------------|------------------|
| Load track în deck | Click "Browse" → selectează | Knob LOAD A/B |
| Play / Pause | Spațiu (deck A) / Shift+Spațiu (B) | PLAY/PAUSE |
| Cue (back-to-cue) | Q (deck A) / W (deck B) | CUE |
| Sync BPM | Click "SYNC" | SYNC button |
| Scratch / nudge | Mouse drag pe jog wheel | JOG WHEEL touch+turn |
| Crossfader | Drag mouse | Hardware fader |
| EQ Treble/Mid/Bass | Knob virtual | Hardware knobs |
| Filter | Knob virtual (HPF dreapta, LPF stânga) | FILTER knob |
| Set hot cue | Click "SET" + cue 1-8 (sau Shift+Click) | HOT CUE button |
| Trigger hot cue | Click cue 1-8 | HOT CUE button |
| Beat FX activate | Toggle FX on/off | BEAT FX ON/OFF |

---

## 🎛️ Beat FX disponibile

| Efect | Ce face |
|-------|---------|
| Reverb | Spațialitate (configurabil dry/wet) |
| Delay | Eco sincronizat la BPM (1/4, 1/2, 1, 2 beats) |
| Echo | Delay multiplu cu feedback |
| Phaser | Sweep modulat |
| Flanger | Doubling cu feedback |
| Bitcrusher | Reduce sample rate / bit depth |
| Roll | Loop foarte scurt (1/16, 1/8, etc.) |
| Trans | Tremolo gated |

---

## 🔊 Audio routing

```
Deck A ──┐
         ├──► Crossfader ──► Master ──► Output (Speakers)
Deck B ──┘                       │
                                 └──► Recording (dacă activat)

Headphone Cue ◄── Cue Mix Selector ── Deck A / Deck B / Both
```

---

## 🎮 Suport MIDI

MMO suportă nativ:
- **Pioneer DDJ-FLX4** (mapping complet pre-configurat)
- **Controllere MIDI generic** (cu MIDI learn)

Pentru low-latency real (~5ms vs ~20ms în browser-only):
→ instalează [MMO Companion](../companion/README.md)

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Engine audio | `mixer-engine.ts` + `audio-fx-engine.ts` + AudioWorklet |
| State mixer | `useMixer` context (Zustand) |
| MIDI | `midi-engine.ts` + `controllers/drivers/ddj-flx4.ts` |
| Playback time | RAF scheduler partajat (60 FPS render) |
| Sync | Beat detection cu offset corection |

---

## 💡 Tips

- **Harmonic mixing**: filtrează biblioteca după key compatibile înainte să intri în mixer (vezi [`biblioteca.md`](biblioteca.md))
- **CPU usage**: dacă ai stuttering, dezactivează vizualizările sau redu la 30 FPS în Settings
- **Hot cues memorate**: cue-urile setate aici se salvează în DB și apar în export USB pentru CDJ
- **Dual headphone monitor**: pentru cuing profesional, ai nevoie de un mixer hardware sau interface cu split cue

---

[← Bibliotecă](biblioteca.md) · [🎛️ DAW Editor →](daw-editor.md)
