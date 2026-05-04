# 🌈 Visualizations (`/visualizations`)

> Vizualizări audio-reactive (~50+) pentru fundal de party, streaming sau monitor de scenă.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- Pornești o vizualizare reactivă la audio (waveform / FFT / energie)
- Răsfoiești ~50+ vizualizări organizate pe categorii
- Creezi playlist-uri de vizualizări (cycle automat)
- Adaptezi paleta de culori după vibe-ul setului

---

## 🖼️ Layout

```
┌──────┬───────────────────────────────────┐
│      │                                   │
│ Cat. │                                   │
│ Fav  │         (Canvas full)             │
│ Lst  │                                   │
│      │      🌀 Vizualizare activă        │
│ ──── │                                   │
│ ▢ 1  │                                   │
│ ▢ 2  │                                   │
│ ▢ 3  │                                   │
│ ...  │                                   │
├──────┴───────────────────────────────────┤
│  ⏮ ⏯ ⏭   🔀 Shuffle    🎨 Palette  ⛶   │
└──────────────────────────────────────────┘
```

---

## 🎨 Categorii

| Categorie | Stil | Exemple |
|-----------|------|---------|
| **Particles** | Particle systems | "Plasma rain", "Star field", "Sparkle" |
| **Geometric** | Forme matematice | "Tunnel", "Mandala", "Sacred geometry" |
| **Organic** | Curbe naturale | "Liquid", "Smoke", "Fluid sim" |
| **Retro** | 80s/90s nostalgia | "VHS scan lines", "Vaporwave grid", "CRT" |
| **Minimal** | Liniștite | "Bars", "Pulse", "Wave" |
| **Psychedelic** | Trippy | "Kaleidoscope", "Acid wash", "Fractal zoom" |
| **3D** | WebGL shaders | "Raymarched", "Volumetric clouds" |

---

## ⌨️ Acțiuni

| Acțiune | Cum |
|---------|-----|
| Pornește vizualizare | Click pe card în sidebar |
| Adaugă favorită | Hover card → click ⭐ |
| Creează playlist | Sidebar tab "Playlists" → "+ New" |
| Adaugă în playlist | Right-click vizualizare → "Add to..." |
| Shuffle play | Click 🔀 — comută aleatoriu la fiecare track |
| Cycle pe BPM | Auto la fiecare N măsuri |
| Schimbă paletă | "🎨 Palette" → presets sau custom |
| Fullscreen | F11 sau click ⛶ |
| FPS limit | Settings → 30 / 60 / 120 FPS |

---

## 🎵 Sync cu audio

Vizualizările folosesc:
- **FFT spectrum** (32 / 64 / 128 / 256 / 512 bins)
- **BPM** detectat de mixer / library
- **Beat events** (kick detection)
- **Energy level** (low / mid / high)
- **Volume RMS** (loudness instant)

Sursa audio:
- 🎚️ **Mixer** → când e activ pe `/mixer`
- 🎤 **Live** → când e mic activ
- 🎛️ **DAW** → când e playing
- 🎵 **Track player** → din `/library` sau `/playlists`

---

## 🎨 Personalizare paletă

Fiecare vizualizare suportă:
- **Preset palettes**: 20+ predefinite (Sunset, Cyberpunk, Forest, Ocean, etc.)
- **Custom**: 3-5 culori HEX, gradient liniar / radial
- **Match track**: ia paleta din album art (k-means)
- **Energy responsive**: culorile se schimbă cu energy level

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Renderer | Canvas 2D (clasic) sau WebGL (3D / shaders) |
| FFT | `AnalyserNode` din Web Audio API |
| Registry | `src/lib/visualizations/registry.ts` |
| BPM sync | Subscribe la mixer / track player events |
| State | localStorage pentru favorite / playlists / settings |

---

## 💡 Tips

- **Performance**: pentru laptop slab → folosește vizualizări 2D (Particles, Minimal); evită 3D / WebGL
- **Streaming**: în OBS folosește "Browser Source" → URL `localhost:3000/visualizations?id=...&fullscreen=1`
- **Multi-monitor**: deschide într-un browser tab fullscreen pe monitorul al 2-lea pentru audience
- **Dark venue**: paletele "high contrast" merg cel mai bine pe ecrane mari în club

---

## 🔮 Roadmap

- Custom visualizations user-uploaded (GLSL shaders)
- MIDI control pentru parametri (cu DDJ-FLX4 pad-uri)
- Export ca video timpilapse
- Layering (2 vizualizări blend mode)

---

[← Remote](remote.md) · [📋 Playlists →](playlists.md)
