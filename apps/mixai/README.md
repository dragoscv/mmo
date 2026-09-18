# @mmo/mixai — MixAI DJ native DJ software

The flagship native DJ app of the mixai.ro suite. Built to combine the best of
rekordbox, Serato, Traktor, VirtualDJ and djay — beautiful, themeable, animated,
low-latency, every controller — with mixai.ro / AI integration nobody else has.

> Architecture & roadmap: [`docs/mixai/00-architecture-and-plan.md`](../../docs/mixai/00-architecture-and-plan.md)

## Stack

- **Shell:** Tauri 2 (Rust) — desktop (Windows/macOS/Linux), mobile later.
- **Audio core:** Rust crate `mixai-core` — `cpal` (ASIO/CoreAudio/ALSA),
  `symphonia` decode, real-time DSP graph, lock-free command queue.
- **UI:** React 19 + TypeScript + Vite 8 + Tailwind v4 on the shared design
  system (`@mmo/design-tokens` + `@mmo/ui`, Base UI primitives, lucide icons,
  `motion`). See `docs/design-system.md`.
- **Bridge:** Tauri commands (UI → core) + events (core → UI meters/state).

## Appearance (surface presets)

MixAI DJ shares one theme model with mixai.ro, the Companion and the TV apps:
`mode` (light/dark/system) · `accent` · `surface` · `density` · `radius` ·
`motion` · `locale`, persisted under `mixai:prefs:v1` and applied before first
paint by `public/prehydrate.js`. The three original DJ skins live on as
**surface presets** — the old `mixai-ui.theme` value is migrated automatically:

| Old skin | Surface | Notes |
|---|---|---|
| Neon Glass | `glass` | translucent panels, blur, accent glow, background gradient (full motion only) |
| Studio Metal | `solid` | opaque panels, soft shadows |
| Flat Pro | `flat` | hairline borders, no blur/shadows |

Deck colours (`--deck-a/b/c/d`) are fixed per deck and never follow the accent
(decision D9). Legacy tokens (`--bg`, `--panel-bg`, `--accent`, `--accent-deck-*`,
`.panel`, `.mono`) are aliased onto the shared tokens in `src/styles.css` while
inline styles migrate to Tailwind utilities.

App strings are RO/EN via a tiny `t()` (`src/i18n/`) layered over the shared
`uiMessages`; `Ctrl/⌘ K` opens the command palette, `?` the shortcuts overlay
(which doubles as the keybind editor).

## Why native (not the web mixer)

The existing web mixer (`apps/web`) is Web Audio + WebMIDI with a ~10–30 ms
latency ceiling and a key-lock stub. MixAI DJ runs the realtime path in Rust for
sub-5 ms latency and true time-stretch / key-lock. We **port the concepts**
(signal-chain topology, the two-layer MIDI architecture, Camelot harmonic-mixing
logic, Pioneer SysEx device knowledge) but reimplement the DSP natively.

## Licensing note (important)

The shipped binary links **permissive-only** DSP (Signalsmith Stretch, symphonia,
rubato, hand-written biquads). GPL/AGPL analysis libraries (aubio, Essentia,
Rubber Band) are **never statically linked** — any such analysis runs in a
separate process (companion or cloud). The repo is dual-licensed
(AGPL + `COMMERCIAL-LICENSE.md`); commercial builds must keep the in-app
dependency graph permissive.

## Local development

```sh
cd apps/mixai
pnpm install
pnpm tauri:dev        # build the Rust core + run the desktop app
# or, UI only (no audio core):
pnpm dev
```

First Rust build is slow (compiles cpal + symphonia + tauri). Subsequent builds
are incremental.

## Layout

```
apps/mixai/
  index.html              # webview entry
  vite.config.ts          # dev server on :14420
  src/                    # React/TS UI
    main.tsx
    App.tsx
    bridge/               # typed Tauri command/event wrappers
    state/                # zustand stores
    components/           # decks, mixer, waveforms, browser, settings
    i18n/                 # app RO/EN messages + t() over @mmo/ui uiMessages
    styles.css            # tailwind + shared tokens + legacy token aliases
  public/prehydrate.js    # copied from packages/design-tokens/dist (pre-paint theme)
  src-tauri/
    Cargo.toml            # tauri app crate (depends on mixai-core)
    tauri.conf.json
    src/
      main.rs
      lib.rs              # tauri commands + event pump
    crates/
      mixai-core/         # the audio engine (cpal, dsp, decks, midi)
```
