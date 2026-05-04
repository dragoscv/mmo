# 🎤 Live (`/live`)

> Mod de performance live cu microfon, backing tracks, loop-uri vocale și FX rack.

[← docs/aplicatie/](README.md) · [🏠 Home](../../README.md)

---

## 🎯 Ce faci aici

- **Cânți live** la microfon cu efecte aplicate în timp real
- Pui **backing track** și mixezi vocea peste
- Înregistrezi **loop-uri vocale** (vocal layering / a cappella)
- Triggerezi **sample pads** (drum hits, FX, vocal samples)
- Monitorizezi **tunerul** (pitch detection)
- Înregistrezi întregul mix

---

## 🖼️ Layout

```
┌────────────────────────────────────────────┐
│   ┌──────────────────┐                     │
│   │   🎤 MIC ON      │   📊 L: ████░░ -8dB│
│   │   (large button) │      R: ████░ -10dB│
│   └──────────────────┘                     │
│                                            │
│  🎵 Tuner: A4 (440 Hz)  ✓ in tune          │
├────────────────────────────────────────────┤
│  🎶 Backing: "track-name.mp3"              │
│  ▶ ⏸    ──────●─────────  3:24 / 5:12      │
├────────────────────────────────────────────┤
│  🔁 Loops          🥁 Pads                 │
│  Loop1  Loop2  +   ┌──┬──┬──┬──┐          │
│  Loop3  Loop4      │1 │2 │3 │4 │          │
│                    ├──┼──┼──┼──┤          │
│                    │5 │6 │7 │8 │          │
│                    └──┴──┴──┴──┘          │
├────────────────────────────────────────────┤
│  🎛️ FX: EQ | Reverb | Delay | Comp | Pitch │
└────────────────────────────────────────────┘
```

---

## ⌨️ Acțiuni

| Acțiune | Cum |
|---------|-----|
| Pornește/oprește mic | Click MIC button (sau press `M`) |
| Load backing track | Drag drop fișier sau "Browse" |
| Play/pause backing | Spațiu |
| Înregistrează loop | Apasă "Record loop" → cântă → "Stop" |
| Trigger pad | Click pad sau tasta 1-8 |
| Salvează preset FX | "Save preset" în FX rack |
| Pornește recording mix | Click "● REC" sus dreapta |
| Mute monitor | Toggle "Monitor" (evită feedback la difuzor) |

---

## 🎙️ FX disponibile pentru voce

| Categorie | Efecte | Use case |
|-----------|--------|----------|
| **EQ** | 3-band parametric | Cut frecvențele rele (mud 200Hz, sibilance 6kHz) |
| **Compressor** | Threshold, ratio, attack, release | Egalizează dinamica vocii |
| **Reverb** | Hall / room / plate | Spațialitate (de la subtle la dramatic) |
| **Delay** | Single / ping-pong, sync la BPM | Eco-uri vocale |
| **Pitch correct** | Auto-tune light (scale-aware) | Subtle tuning în live |
| **De-esser** | Reduce sibilance | Pentru S/SH-uri agresive |
| **Doubler** | Double-track effect | Voce mai groasă |

---

## 🔁 Loop workflow (vocal layering)

1. Pune backing track la BPM cunoscut (ex: 120 BPM)
2. Click "Record Loop 1" → cântă **vers** pe 8 beats → "Stop"
3. Loop 1 se redă în buclă sincronizat
4. Click "Record Loop 2" → cântă **harmonie** → "Stop"
5. Layer cu Loop 3, 4, ... (până la 8 loop-uri)
6. Mute / solo individual din panel

---

## 🥁 Sample pads

- 8 pad-uri configurabile
- Drag-drop fișier audio pe un pad pentru assign
- Tastele 1-8 = trigger
- Modes: one-shot, loop, gate (hold to play)

> Sample pack default: vezi `app/public/samples/` — kicks, snares, vocal stabs, FX

---

## 🎛️ Routing audio

```
🎤 Mic ──► EQ ──► Comp ──► Pitch ──► Reverb ──► Delay ──┐
                                                          ├──► Master ──► Output
🎵 Backing ──────────────────────────────────────────────┤
🔁 Loops ───────────────────────────────────────────────┤
🥁 Pads ────────────────────────────────────────────────┘
                                                          │
                                                          └──► Recording
```

---

## 🔌 Sub capotă

| Aspect | Implementare |
|--------|--------------|
| Engine | `live-engine.ts` |
| Mic input | `getUserMedia({ audio: { echoCancellation: false } })` |
| FX | AudioWorklet processors |
| Tuner | FFT pitch detection (autocorrelation) |
| Loops | AudioBuffer-uri în memorie |
| Pads | AudioBuffer pool, gain node per pad |
| State | `useLive` context |
| Settings | `useLiveSettings()` — preset-uri în localStorage |

---

## ⚠️ Edge cases & tips

- **Latency mic→speaker**: minimum ~10-30ms în browser; pentru pro folosește interface audio + ASIO/CoreAudio prin Companion
- **Feedback loop**: dacă auzi screech, mute monitor sau pune cască
- **Echo cancellation**: dezactivat by default (vrem să auzim toată voce); dacă faci podcast, activează din settings
- **Browser permissions**: la prima accesare cere permisiune microfon
- **Backing track lossy sync**: ține backing-ul în WAV/FLAC pentru sync precis BPM

---

## 💡 Tips

- **Pre-show test**: testează tot setup-ul (mic, levels, FX presets, backing tracks loaded) înainte de live
- **Saved presets**: creează preset FX per "vibe" (intim ballad / energetic, etc.)
- **Backup recording**: ai mereu "● REC" activ — protecție în cazul în care ceva merge prost
- **Cu Companion**: mic input cu latență sub 5ms + sample rate 48kHz nativ

---

[← DAW Editor](daw-editor.md) · [📡 Remote →](remote.md)
