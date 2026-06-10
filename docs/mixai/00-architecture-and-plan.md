# MIXAI — Native DJ Software · Architecture & Implementation Plan

> The goal: the best DJ software on the planet for bedroom/hobbyist DJs first,
> with pro-grade depth — combining the strengths of rekordbox, Serato, Traktor,
> VirtualDJ and djay, plus muzicai.ro / AI integration nobody else has.
> Beautiful, themeable, animated, low-latency, every controller, freemium.

Status: **v0.1 + v0.2 shipped; v0.3 in progress** (current build `apps/mixai` 0.1.34).
This is the canonical living doc. Last updated: 2026-06-10.

---

## 1. Product north star

| Pillar | What "best" means | How we win |
|--------|-------------------|------------|
| **Sound** | Sub-5 ms latency, true key-lock | Native Rust audio (cpal → ASIO/CoreAudio/ALSA), Signalsmith time-stretch |
| **Beauty** | Cinematic, themeable, animated | Glassmorphism+neon default + neumorphism + flat-pro themes, React/Framer Motion |
| **Hardware** | Every controller brand | Port the existing 2-layer MIDI arch + MIDI-learn + HID (later) |
| **Stems** | On-device AND cloud, user choice | Companion/cloud (BS-Roformer/Demucs) + on-device model (v0.2) |
| **Library** | Local + muzicai.ro unified | Companion file access + muzicai.ro API, account-synced |
| **Account** | Settings/themes/mappings sync | All prefs in muzicai.ro account, restored on any device |
| **Open** | Plugins, shared themes/mappings | Plugin SDK + shareable presets (later milestone) |

**Target user (first):** bedroom/hobbyist DJ — ease + beauty + cheap — but the
engine and hardware support are pro-grade from day one.

**Monetization:** freemium tied to the muzicai.ro account. Free core; paid pro
tier (advanced FX, on-device stems, unlimited cloud analysis, plugin marketplace).

---

## 2. Competitive analysis (research summary)

| App | Strength | Weakness we exploit |
|-----|----------|---------------------|
| Traktor Pro | Best sound/beatgrid/sync, stable | Dated UI, paid, NI-centric |
| Serato DJ Pro | Best live stems, huge HW support | Subscription creep, beatgrid gripes |
| rekordbox | Pioneer/CDJ ecosystem | Heavy-CPU stems, bloated, paywalls |
| VirtualDJ | Most features, smooth | Cluttered UI |
| djay Pro | Beautiful, Apple-native | Limited pro HW / HID |
| Mixxx | Free/open, all controllers | GPL (study only), rough UI |

**Our wedge:** djay beauty + Traktor sound + Serato stems + Mixxx-level open
hardware + muzicai.ro/AI + freemium.

---

## 3. Tech stack (confirmed)

```
┌──────────────────────────────────────────────────────────────┐
│  apps/mixai  (Tauri 2 app)                                    │
│                                                              │
│  ┌────────────────────────┐     IPC      ┌────────────────┐  │
│  │  Webview UI (React/TS) │ ───────────► │  Rust core     │  │
│  │  Vite + Tailwind v4    │ ◄─────────── │  (lib crate)   │  │
│  │  Framer Motion         │  events      │                │  │
│  │  - decks, mixer, FX    │              │  audio thread  │  │
│  │  - waveforms (WebGPU)  │              │  (cpal, RT)    │  │
│  │  - browser, settings   │              │  DSP, stretch  │  │
│  │  - theming             │              │  MIDI, decode  │  │
│  └────────────────────────┘              └───────┬────────┘  │
│                                                  │           │
└──────────────────────────────────────────────────┼──────────┘
                                                    │
                  ┌─────────────────────────────────┼─────────────┐
                  ▼                                  ▼             ▼
          cpal backend                     muzicai.ro API   companion (server/)
   ASIO / WASAPI (Win)                    library + stems   local files + HW
   CoreAudio (mac)                        account sync      cloud GPU stems
   ALSA/JACK/PipeWire (Linux)
```

- **Shell/runtime:** Tauri 2 (Rust). Mobile via Tauri 2 mobile + Capacitor later.
- **UI:** React + TypeScript + Vite + Tailwind v4 + Framer Motion (reuse design
  patterns from `apps/web`, but a separate, app-optimized UI).
- **Audio core:** Rust, `cpal` (ASIO feature on Windows, CoreAudio, ALSA/JACK/
  PipeWire). Real-time audio thread, lock-free command queue from UI.
- **State:** Zustand in UI; canonical audio state lives in Rust, mirrored to UI
  via throttled events (~30–60 Hz for meters, immediate for transport).

### Why Tauri over Electron
Native Rust audio thread sits in-process (no IPC across a Node boundary for the
RT path), tiny bundle, built-in mobile, already scaffolded in this repo.

---

## 4. Audio engine design (Rust)

### 4.1 Threading model
- **RT audio thread** (owned by cpal callback): pulls from a lock-free ring of
  per-deck sample providers, runs the DSP graph, writes to output device(s).
  NEVER allocates, locks, or blocks. No `println!`. No GPL code.
- **Worker threads:** decode (symphonia), offline analysis (BPM/key/beatgrid),
  time-stretch pre-roll, peak/waveform precompute, file IO.
- **UI thread (webview):** sends commands via `crossbeam` channel → audio thread
  reads commands at the top of each callback (parameter smoothing applied).

### 4.2 Signal chain (port the topology, replace the DSP)
Per deck (from existing `mixer-engine.ts`, re-implemented natively):

```
source(decoded + time-stretch/key-lock)
  → stem mixer (4 gains, v0.2)
  → auto-gain
  → EQ low/mid/high (real biquads)
  → filter (LPF/HPF bipolar)
  → color FX
  → beat FX (real delay/reverb/flanger/…)
  → channel volume
  → VU analyser tap
  → crossfader assign (A/thru/B) → master bus
                                 → (pre-fader) cue bus → headphone out
```

Master: `sum(decks) → master gain → limiter → output device`.
Cue: separate device/channel (full flexible routing matrix — any device, any ch).

### 4.3 Key DSP components & licensing (per-component decision)
| Component | Choice | License | Where |
|-----------|--------|---------|-------|
| Decode | `symphonia` | MPL/Apache | in-app (RT-safe pre-decode) |
| Resample | `rubato` | MIT | in-app |
| Time-stretch / key-lock | **Signalsmith Stretch** | permissive | in-app |
| EQ / filter / FX | hand-written biquads + FDN reverb | own code | in-app |
| BPM / beatgrid / key | **offline in companion/cloud** (aubio/Essentia/QM ok there) OR permissive Rust analyzer | GPL stays out of shipped binary | companion / worker |
| Stems | companion/cloud (Demucs/BS-Roformer) + on-device ONNX (v0.2) | model-dependent | companion/cloud |

**Licensing rule:** the shipped MIXAI binary links **only permissive** DSP.
Any GPL/AGPL analysis (aubio/Essentia/Rubber Band) runs as a **separate process**
(companion or cloud) so it never statically links into the proprietary app.
The repo itself is dual-licensed (AGPL + `COMMERCIAL-LICENSE.md`); the commercial
distribution must keep its dependency graph permissive.

### 4.4 Anti-glitch & timing (port these proven patterns)
- Parameter ramping (cancel → setValue → linearRamp ~8–15 ms) for every knob.
- Equal-power crossfader curves (linear / smooth / sharp).
- Sample-clock driven loops/sync (NOT UI timers) → jitter-free.
- VU peak-hold smoothing (fast attack / slow decay, ~700 ms hold).

---

## 5. MIDI / HID controller system (port the crown jewel)

Two independent, registry-based, auto-detecting layers (from `midi-engine.ts` +
`controller-driver.ts`):

1. **Input mapping:** `hardware msg → semantic action → handler`. Data-driven
   presets (`{status, midino, action, deck, type}`), 14-bit CC, note-off
   normalization, **MIDI-learn**, JSON import/export, regex auto-detect.
2. **Output feedback:** state-diffing driver registry (`BaseControllerDriver` +
   per-LED cache + `DriverMixerState` subset + color presets + capability flags).

Carry over **device knowledge**: Pioneer SysEx wake-up + 200 ms keep-alive,
monochrome-LED velocity handling, FLX4/400/1000 channel/note maps.

- v0.1: `midir` (Rust MIDI) + generic MIDI-learn + DDJ-FLX4 port.
- Later: HID (`hidapi`) for CDJ/jog precision + screen feedback.

Roadmap of families: Pioneer/AlphaTheta, generic MIDI-learn, Denon/Numark,
NI Traktor Kontrol, Hercules/Reloop, HID advanced.

---

## 6. Library & companion integration

- **Local files:** companion (`server/`) already exposes local files + audio HW.
  MIXAI talks to it over the existing local HTTP + device-token auth.
- **muzicai.ro:** unified browse, load, and (later) stream. Account-synced.
- **Stems:** user choice — on-device model OR companion/cloud GPU (existing
  `cloud-gpu-stems.ts` / `stems-engine.ts` patterns). Taxonomy: vocals/drums/
  bass/melody.

---

## 7. Account sync (settings/themes/mappings)

All preferences persist to the muzicai.ro account and restore on any device:
MIDI presets + driver/color choices, themes, deck/FX defaults, jog sensitivity,
tempo range, crossfader curve, audio routing matrix, library prefs. Local cache
for offline; reconcile on login. Reuse `apps/web` auth/session + a `mixer_setups`
-style schema.

---

## 8. UI / UX

- **Themeable from day 1**, 3 shipped themes:
  1. **Neon Glass** (default) — dark glassmorphism + neon accents + cinematic motion.
  2. **Studio Metal** — neumorphism / realistic hardware.
  3. **Flat Pro** — minimal, function-first (Traktor/Ableton-like).
- Theme = CSS variable token set + motion profile; user-swappable, shareable.
- Layouts: 2-deck (default) and 4-deck. Touch-friendly for tablet later.
- Components: decks (jog, transport, tempo, key), waveforms (overview + scrolling
  GPU), mixer strip (EQ/filter/volume/cue/xfader), FX racks, hot cues, loops,
  browser, settings (audio routing, MIDI, themes, account).

---

## 9. Milestones

### v0.1 — "It mixes, beautifully" (first shippable)
- [x] Scaffold `apps/mixai` (Tauri 2 + Vite/React/TS + Rust lib).
- [x] Rust audio core: cpal device enumeration + master output.
- [x] Deck engine: decode (symphonia), play/stop/seek, gain, tempo (resample).
- [x] Signal chain: 3-band EQ + filter + crossfader + cue bus.
- [x] Key-lock/tempo (pure-Rust WSOLA time-stretch; Signalsmith deferred).
- [x] IPC: Tauri commands + throttled state/meter events.
- [x] UI: themed 2-deck mixer (Neon Glass theme).
- [x] Waveform render + beatgrid from in-app analyzer.
- [x] MIDI: generic MIDI-learn + DDJ-FLX4 input + LED feedback.
- [x] muzicai.ro library browse + load track; companion local files.
- [x] Hot cues + loops.
- [x] Theming system (custom + shareable themes) + account-synced settings.
- [ ] Full flexible audio routing matrix (cue bus done; per-device matrix TODO).

### v0.2 — "Stems & record"
- [x] Live stems (companion/cloud; on-device ONNX still TODO).
- [x] Master recording + remote streaming. [x] 4-deck. [x] Sampler.
- [x] Beat-synced FX (echo/reverb). Real FDN/flanger expansion TODO.

### v0.3+ — "Pro & open"
- [x] HID foundation + input mapping/learn + device presets + LED feedback.
  (per-model CDJ jog/screen DECODE still TODO.)
- [x] More controller families (11 MIDI + 6 HID presets across all major brands).
- [x] Plugin SDK + built-in plugins + external (declarative) plugins + visual
  builder + one-click catalog. (Code-bearing plugin sandbox still TODO.)
- [x] Shareable themes/mappings + account sync (themes, MIDI, **HID**, **plugins**).
- [x] AI assist: harmonic mix-assist (Camelot) + auto-mix/auto-queue "AI DJ".
- [ ] Mobile (Android/iOS — `apps/native` has capacitor + tauri scaffolding).
- [ ] Real marketplace backend (currently local + companion account blob).

---

## 10. Repo conventions (must follow)
- New app: `apps/mixai`, package `@mmo/mixai`, own `pnpm-lock.yaml`
  (`.npmrc shared-workspace-lockfile=false`).
- Rust crate `mixai-core` under `apps/mixai/src-tauri` (or a `packages/` crate).
- Add `apps/mixai` to `pnpm-workspace.yaml` (already covered by `apps/*`).
- Version bump + CHANGELOG entry on every shippable change.
- Do not `git add -A` blindly (repo has untracked secrets / vendored repos).
- Keep CI green; permissive-only dependency graph in the shipped binary.

---

## 11. Engineering risks & mitigations
| Risk | Mitigation |
|------|------------|
| GPL contamination of proprietary binary | Permissive-only in-app; GPL analysis in separate process |
| ASIO build complexity on Windows | `cpal` `asio` feature is opt-in; fall back to WASAPI shared/exclusive |
| Time-stretch quality vs latency | Signalsmith tuned per-mode; pre-roll on load |
| RT-thread safety | No alloc/lock/log in callback; lock-free command queue; fuzz/soak tests |
| Cross-platform audio device quirks | Abstract device layer; soak-test per OS; expose routing matrix to user |
| Scope (v0.1 is large) | Strict order below; each step independently runnable |
```
