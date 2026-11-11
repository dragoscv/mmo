# Layouts, zero scroll and the shell (WP19-30)

MixAI Decks never scrolls: not the window, not a panel. This document is the contract between the
layout engine and the panels. Code: `apps/mixai/src/layout/` (model, solver, presets, editor),
`apps/mixai/src/shell/` (title bar, workspace, governor, hotkeys).

State described: Decks 1.5.0 (2026-11-11). What is new against 1.4 is marked "1.5": the `waves` panel,
the minimum sizes, the layouts `pro` and `pro-vertical`, the default layout and the gap rule.

## Layout JSON (`LayoutDoc`, schema v1)

```json
{
  "v": 1,
  "id": "classic",
  "name": "Classic",
  "columns": [5, 3, 5],
  "rows": [1, 9, 2, 6],
  "gap": 12,
  "areas": [
    { "panel": "deckA", "col": 0, "row": 0, "rowSpan": 3 },
    { "panel": "mixer", "col": 1, "row": 1 }
  ]
}
```

- `columns` / `rows`: 1–8 weights in (0, 20] (fr semantics). `gap` 0–32 px, optional (see [Gap](#gap-15)).
- Panels (12): `deckA..deckD`, `clock`, `mixer`, `crossfader`, `library`, `automix`, `sampler`, `plugins`,
  `waves` (1.5). Each at most once; no overlaps; `deckA`, `deckB` and `mixer` are required.
- `waves` (1.5) is the band of scrolling waveforms of every deck in the layout (plus the phase meter). It
  turns itself vertical when its box is clearly taller than wide, whatever tier it got. The schema stays
  `"v": 1`, but Decks 1.4 and older do not know the panel: their validator answers
  `areas[<i>]: unknown panel` and the layout is not offered.
- The same schema is shipped in `.mixaipack` packs (`layouts/*.json`, see [packs.md](packs.md)) and is
  meant for the Compose and SwiftUI apps too.
  Installed pack layouts are addressed as `<packId>/<layoutId>` (see packs.md § Layout ids).
  Editing a pack layout forks it as the user layout `<layoutId>-custom`.

## Built-in layouts

`BUILTIN_LAYOUTS` in `presets.ts`, in picker order. None of them sets `gap`.

| id | Name | Columns × rows (weights) | Arrangement |
|---|---|---|---|
| `pro` (1.5, default) | Pro | 16, 7, 16 × 7, 12, 2, 19 | `waves` band across the top; deck A, mixer over crossfader, deck B; library across the bottom |
| `pro-vertical` (1.5) | Vertical waves | 16, 7, 9, 7 × 19, 2, 19 | deck A; `waves` (tall, between the decks) over the crossfader; deck B over two columns; below: library over three columns, mixer beside it |
| `classic` | Classic | 5, 3, 5 × 1, 9, 2, 6 | deck A; clock, mixer, crossfader; deck B; below: library, auto-mix |
| `performance` | Performance | 5, 3, 5 × 1, 9, 2, 3 | decks over the full height; clock, mixer, crossfader, sampler in the centre; no library |
| `library` | Library | 5, 3, 5 × 6, 2, 9 | decks, mixer and crossfader condensed on top; library and auto-mix below |
| `four-deck` | 4 decks | 4, 4, 3, 4, 4 × 1, 9, 2, 5 | decks C, A, centre (clock, mixer, crossfader), B, D; below: library, auto-mix, sampler |
| `ultrawide` | Ultra-wide | 4, 5, 3, 5, 3 × 1, 9, 2, 4 | library column; deck A; clock, mixer, crossfader, plugins; deck B; auto-mix and sampler column |

`stage` (Stage, 5, 2, 5 × 9, 2: deck A, mixer over crossfader, deck B) is the Stage-mode layout; it is
not in the picker list. Only `pro` and `pro-vertical` place `waves`.

**Default (1.5).** A fresh install starts on `pro` (`DEFAULT_LAYOUT`). An install whose active layout is
still `classic` (the default up to 1.4) is moved to `pro` once (`migrateDefaultLayout`, flag
`mixai-layout-v2` in localStorage); any other choice is kept.

## Gap (1.5)

The space between panels is, in this order (`useEffectiveLayout` in `shell/Workspace.tsx`):

1. the layout's own `gap` (0–32 px), when it sets one;
2. else the look's `--panel-gap`: **2 px** in the Signature look (`look/look.css`), or the value a skin
   sets with `style.sizes.panelGap` (0–16, see [packs.md](packs.md));
3. else the solver default, **12 px** (`DEFAULT_GAP`): this is what the classic look gets.

The solver itself (`solve`, `minimumSize`) only knows steps 1 and 3; the shell passes it the layout with
the gap of step 2 filled in. The Rust port used by the native apps has steps 1 and 3 only.

## Solver

`solve(layout, size, PANEL_SPECS)` (pure, `solver.ts`):

1. Split the workspace into weighted tracks.
2. Each area gets the union rect of its cells.
3. Each panel gets the richest **tier** whose minimum fits: `full` → `compact` → `icon`.
4. A panel that fits no tier is **docked**: it becomes a tab in the largest non-essential panel's
   slot. Essential panels (decks, mixer, crossfader) never dock.

`minimumSize(layout)` is the smallest workspace in which every essential panel has at least its icon
size. The native window minimum follows the active layout (`App.tsx`): width
`max(960, minimum width + 2 × shell padding)`, height
`max(600, minimum height + title bar + status bar + shell padding)`. In the Signature look the title bar
is 36 px, the status bar 22 px and the shell padding 4 px (`look.css`).

Workspace minimums at the 12 px default gap, read on 2026-11-10 from `minimum` in
`docs/decks/fixtures/layout-cases.json` (written by `node apps/mixai/scripts/gen-layout-fixtures.mjs`):

| Layout | Minimum workspace |
|---|---|
| `pro` | 860×596 |
| `pro-vertical` | 872×584 |
| `classic` | 674×288 |
| `performance` | 674×246 |
| `library` | 674×336 |
| `four-deck` | 1093×274 |
| `ultrawide` | 1048×260 |
| `stage` | 924×166 |

Tests (`node --test apps/mixai/src/layout/*.test.ts`): sweep of every built-in layout over
1024–3840 × 640–2160 (no placement outside, no overlap, no docked essential), tier minimums hold,
editor operations keep layouts valid.

## Panel contract

A panel reads its tier with `usePanelTier()` and must render without overflow inside a rect at least
`PANEL_SPECS[panel].min[tier]` (`presets.ts`), filling larger rects. No `overflow: auto/scroll`
anywhere in the shell. Controls that do not fit a smaller tier move into popovers; nothing is removed.

Minimum box per tier, width×height in px (1.5 values; deck, mixer and crossfader are lower than in 1.4
and `waves` is new):

| Panel | full | compact | icon |
|---|---|---|---|
| Deck (`deckA..deckD`) | 480×250 | 340×190 | 220×110 |
| Mixer | 240×250 | 200×190 | 150×110 |
| Crossfader | 220×84 | 180×40 | 140×28 |
| Waves | 480×110 | 320×64 | 200×36 |
| Clock | 220×72 | 160×40 | 90×28 |
| Library | 520×240 | 320×160 | 200×96 |
| Auto-mix | 230×230 | 190×130 | 120×56 |
| Sampler | 270×250 | 200×140 | 120×56 |
| Plugins | 220×160 | 160×96 | 96×48 |

Essential (never docked): the decks, the mixer and the crossfader. `waves` is a regular panel: when its
box is smaller than its icon size it becomes a dock tab.

Zero-scroll probe (run in the browser console or Playwright): every element with
`overflow-x/y: auto|scroll` and `scrollWidth/Height > client*` is a failure; every descendant of a
`.mixai-panel-box` whose rect leaves the box is a failure. Measure after the layout morph settles
(~2 s).

## Library without a scrollbar

`ScrolllessList` shows exactly `floor(height / rowHeight)` rows. Row height (`rowHeightFor` in
`library/track-view.ts`, 1.5): 22 px in compact density (what the Signature look ships with), 26 px
otherwise, 28 px in booth mode, 44 px in touch mode.
The cursor moves with the wheel (over the list), arrows, Page Up/Down, Home/End, touch drag and
`libraryNav.move(delta)` (controller browse encoder); the window follows the cursor like a hardware
browser. Enter loads to the deck that is not playing, Shift+Enter to B.

## Shell

- **Title bar** (`TitleBar.tsx`): Windows/Linux draw their own minimize/maximize/close (native
  decorations removed in Rust setup); hovering maximize on Windows 11 opens Snap Layouts
  (`window_show_snap_overlay`). macOS keeps native traffic lights (`titleBarStyle: Overlay`).
  Drag via `data-tauri-drag-region` on every non-interactive element.
- **Stage mode**: Ctrl+Shift+S or the title-bar button; layout `STAGE`.
- **Snapshots**: Alt+1…8 → layout bound to that slot (Settings → Layout), else the n-th layout.
- **Controller layouts**: Settings → Layout maps a device name to a layout; applied when a BLE MIDI
  controller connects or a USB MIDI port is opened (`mixai:midi-connected`).
- **Pop-out**: dock tab button → `window_pop_out(panel)` opens `index.html?popout=<panel>`. The
  allow-list (`POPOUT_PANELS` in `src-tauri/src/window_ctl.rs`) has all 12 panels (`waves` since 1.5).
- **Motion**: Motion `layout` morph on layout/tier changes; one gate (`shell/motion.ts`) = OS
  reduced motion, theme pref, and the governor (`shell/governor.ts`: average frame > 18.2 ms for
  1.5 s → reduced; < 17.2 ms for 8 s → back).
- **Beat accent** (opt-in): `--beat` CSS variable from the master clock phase.

## Native apps (Compose + SwiftUI) — WP19-34

The native apps use the **same layout JSON and the same solver**, ported once to Rust:
**`apps/mixai/src-tauri/crates/decks-layout`** (MSRV 1.87, MIT OR Apache-2.0) is an exact port of
`types.ts`, `solver.ts` (`tracks`, `fits` with the 0.5 px tolerance, `pick_tier`, `solve`,
`validate_layout` with identical messages, `minimum_size`), `presets.ts` (`PANEL_SPECS`, the seven
built-ins + Stage, `default_layout()` = `pro`; panel `waves` since 1.5) and the namespacing of
`src/packs/pack-layouts.ts`. The Tauri renderer keeps its synchronous TS solver (no IPC round-trip per
resize).

**Golden fixtures** keep the two in lockstep: `apps/mixai/scripts/gen-layout-fixtures.mjs` runs the TS
solver over every preset (the seven built-ins + Stage) × 9 widths × 6 heights (432 cases since 1.5, 324
in 1.4; 360×300 up to 3440×1440, so icon tiers and docking are covered), plus `minimumSize` and 13
validator cases, into
`docs/decks/fixtures/layout-cases.json`. Asserted by `src/layout/solver.test.ts` (byte-equal to a fresh
generation), by `decks-layout` (`include_str!`; mutation-checked at WP19-34, when the file had 324 cases:
a 0 px tolerance made 7 of them fail), and on the JVM by `desktopTest/LayoutFixturesTest` (Kotlin
fallback solver and the FFI solver). Any
change to the TS solver, presets or validator ⇒ regenerate the file in the same commit.

**Unknown panels.** The format has 12 panels; the native apps render deck A/B, mixer, crossfader and
library. Since 1.5 the Compose apps also place `waves` (the existing waveform lanes as a panel; the
Kotlin contract `PackPort.kt` has the 12 panels, the 1.5 minimum sizes and the presets `pro` /
`pro-vertical`, `LayoutFixturesTest` green). The SwiftUI host does not render `waves` yet: there it is
one of the unavailable panels below, which matters because the default layout `pro` places it.
The FFI solver takes the list of panels the host renders
(`layout_solve(layout_json, w, h, available)`): any other panel is *unavailable* and always goes to the
dock (a tab showing "not available in this app yet"), whatever its size. deckA, deckB and mixer stay
required by the validator, so every layout, built-in or from a pack, works on every surface.

FFI (`crates/decks-ffi/src/packs.rs`): `layout_solve` → `LayoutSolution { placements: [{ panel, rect, tier }],
docked, dock? }`, `layout_validate(json)` → messages, `layout_minimum_size(json)`, `layout_presets_json()`,
`layout_default_id()` (1.5: `pro`); the panel enum has `LayoutPanel.Waves` since 1.5.
Sizes are dp (Compose) / pt (SwiftUI), 1:1 with the CSS px of `PANEL_SPECS`.

Hosts:

- **Compose** (`apps/decks-android/ui`, Android + Desktop): `screens/LayoutHost.kt` —
  `BoxWithConstraints` → `PackPort.solve(dp)` → panels placed by `Modifier.offset/size`, dock tabs at the
  dock rect. `DecksScreen` has no `verticalScroll` any more. `DeckPanel` / `MixerPanel` take a `PanelTier`
  (icon tier added; the crossfader is its own `CrossfaderPanel`). Under 700 dp wide the native phone
  layout (`DemoPacks.phone`: decks side by side, mixer, crossfader, library) replaces the chosen one.
  `engine/PackPort.kt` defines the port plus `DemoPacks` (built-in presets + a Kotlin solver used when
  the native library cannot load, fixture-tested too); `jvmShared/engine/FfiPacks.kt` is the decks-ffi
  adapter. The chosen layout is `DecksSkin.layoutId` (`classic`… or `<packId>/<layoutId>`); the old
  `layout=classic|performance|library` preference values are the built-in ids, and a bare pack-local id
  is remapped when exactly one pack layout matches.
- **SwiftUI** (`apps/ios/DecksApp`): `UI/LayoutHost.swift` — `GeometryReader` → `layoutSolve` → panels
  positioned by rect + dock tabs; replaces the regular-size-class branch of `RootView` (compact width
  keeps its tabs). `DeckView` / `MixerView` take a `LayoutTier`; `CrossfaderView` is the crossfader
  panel. Layout / skin / pack pickers: `UI/AppearanceSettingsSection.swift`; state in
  `Engine/PackStore.swift` (`AppearanceStore`).
