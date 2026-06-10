# @mmo/audio-gen

Generative audio core for MMO. Three tiers:

| Tier | Where | Latency | Tech |
|------|-------|---------|------|
| T0 — instant | Browser main + AudioWorklet | <50 ms | DSP synths, drum machines, MIDI generators (Markov + music-theory) |
| T1 — fast | Browser WebGPU + WASM | <2 s | Stable Audio Open (small), Riffusion-style spectrogram diffusion |
| T2 — heavy | Companion Python sidecar OR remote worker (Cloud Run / RunPod) | 5–60 s | MusicGen, Stable Audio Open full, ACE-Step, DiffRhythm |

T0 ships first; T1/T2 wired through the same `generate.*` tool surface.

## Layout

```
src/
  synth/   ← FM, subtractive, wavetable, granular polysynths
  drum/    ← 808/909/linear synth + per-genre kit randomizers
  loop/    ← bar-level loop builder (chord + rhythm + render)
  midi/    ← chord progression / bassline / melody / drum-pattern generators
  render/  ← OfflineAudioContext → WAV encoder
```

## Status

Scaffolded in P0. Implementation lands in P5 (T0) and P7 (T1/T2).
