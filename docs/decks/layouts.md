# Layouts, zero scroll and the shell (WP19-30)

MixAI Decks never scrolls: not the window, not a panel. This document is the contract between the
layout engine and the panels. Code: `apps/mixai/src/layout/` (model, solver, presets, editor),
`apps/mixai/src/shell/` (title bar, workspace, governor, hotkeys).

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

- `columns` / `rows`: 1–8 weights in (0, 20] (fr semantics). `gap` 0–32 px.
- Panels: `deckA..deckD`, `clock`, `mixer`, `crossfader`, `library`, `automix`, `sampler`, `plugins`.
  Each at most once; no overlaps; `deckA`, `deckB` and `mixer` are required.
- The same schema is shipped in `.mixaipack` packs (`layouts/*.json`, see [packs.md](packs.md)) and is
  meant for the Compose and SwiftUI apps too.

## Solver

`solve(layout, size, PANEL_SPECS)` (pure, `solver.ts`):

1. Split the workspace into weighted tracks.
2. Each area gets the union rect of its cells.
3. Each panel gets the richest **tier** whose minimum fits: `full` → `compact` → `icon`.
4. A panel that fits no tier is **docked**: it becomes a tab in the largest non-essential panel's
   slot. Essential panels (decks, mixer, crossfader) never dock.

`minimumSize(layout)` is applied as the native window minimum, so an essential panel always has at
least its icon size.

Tests (`node --test apps/mixai/src/layout/*.test.ts`): sweep of every built-in layout over
1024–3840 × 640–2160 (no placement outside, no overlap, no docked essential), tier minimums hold,
editor operations keep layouts valid.

## Panel contract

A panel reads its tier with `usePanelTier()` and must render without overflow inside a rect at least
`PANEL_SPECS[panel].min[tier]` (`presets.ts`), filling larger rects. No `overflow: auto/scroll`
anywhere in the shell. Controls that do not fit a smaller tier move into popovers; nothing is removed.

| Panel | full | compact | icon |
|---|---|---|---|
| Deck | 460×560 | 340×330 | 220×150 |
| Mixer | 240×440 | 200×260 | 150×150 |
| Crossfader | 220×100 | 180×56 | 140×36 |
| Clock | 220×72 | 160×40 | 90×28 |
| Library | 520×240 | 320×160 | 200×96 |
| Auto-mix | 230×230 | 190×130 | 120×56 |
| Sampler | 270×250 | 200×140 | 120×56 |
| Plugins | 220×160 | 160×96 | 96×48 |

Zero-scroll probe (run in the browser console or Playwright): every element with
`overflow-x/y: auto|scroll` and `scrollWidth/Height > client*` is a failure; every descendant of a
`.mixai-panel-box` whose rect leaves the box is a failure. Measure after the layout morph settles
(~2 s).

## Library without a scrollbar

`ScrolllessList` shows exactly `floor(height / rowHeight)` rows (40 px, 32 px in compact density).
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
- **Pop-out**: dock tab button → `window_pop_out(panel)` opens `index.html?popout=<panel>`.
- **Motion**: Motion `layout` morph on layout/tier changes; one gate (`shell/motion.ts`) = OS
  reduced motion, theme pref, and the governor (`shell/governor.ts`: average frame > 18.2 ms for
  1.5 s → reduced; < 17.2 ms for 8 s → back).
- **Beat accent** (opt-in): `--beat` CSS variable from the master clock phase.
