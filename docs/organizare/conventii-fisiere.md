# 📝 Convenții Fișiere — Naming Conventions

[🏠 Home](../../README.md) · [📁 Organizare](README.md)

---

> **Pe scurt:** Cum denumești fișierele audio pe disk pentru consistență.

---

## 📏 Format Recomandat

```
Artist - Titlu (Remix) [Label].format
```

### Exemple:

```
✅ BINE:
Charlotte de Witte - Overdrive (Original Mix) [KNTXT].flac
Salam - Ce Frumoasa Esti (DJ Edit) [Manele Records].mp3
Deborah de Luca - Techno Bunny [Solamente].wav

❌ GREȘIT:
track_2025_final_v3.mp3
New Recording.wav
Unknown Artist - Track 1.mp3
01 - song.flac
```

---

## 📋 Reguli

| Regulă | Exemplu |
|--------|---------|
| **Artist - Titlu** separat cu " - " | `Artist - Titlu` |
| **(Remix)** în paranteze | `(Boris Brejcha Remix)` |
| **[Label]** în brackets | `[Drumcode]` |
| **Fără caractere speciale** | Nu: `/ \ : * ? " < > \|` |
| **Unicode OK** pentru română | `Ș, Ț, Ă, Î, Â` OK |
| **Format:** .flac, .wav, .mp3 | Preferă FLAC |

---

## 🔍 Metadata ID3

Pe lângă numele fișierului, setează și **metadata** internă:

| Tag ID3 | Ce Pui |
|---------|--------|
| **Title** | Numele track-ului |
| **Artist** | Artist(i) |
| **Album** | Label sau compilation |
| **Genre** | Genul principal |
| **Year** | Anul lansării |
| **BPM** | (rekordbox o setează automat) |
| **Key** | (rekordbox o setează automat) |

> **💡 Tool:** [Mp3tag](https://www.mp3tag.de/) (gratuit) — cel mai bun editor de metadata.

---

[🏠 Home](../../README.md) · [📁 Organizare](README.md)
