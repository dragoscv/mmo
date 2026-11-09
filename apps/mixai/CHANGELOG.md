# MixAI Decks changelog

## 1.3.0 — 2026-11-09

- **No scrolling, anywhere.** A new layout engine fits every panel into the window: panels step
  down from full to compact to icon size, and whatever still does not fit becomes a tab in a shared
  slot. The window cannot be made smaller than the layout needs. Checked from 1024×700 to 3440×1440.
- **Own title bar.** The native bar is gone; window buttons, Windows 11 Snap Layouts (hover on
  maximize) and native macOS traffic lights are kept. Layout, Stage mode, profile, commands, keys and
  settings live in the bar.
- **Layouts**: Classic, Performance, Library, 4 decks, Ultra-wide; a drag-and-drop layout editor
  that refuses layouts which would need scrolling; quick slots Alt+1…8; a layout per controller that
  switches by itself when the controller connects; panels morph when the layout changes.
- **Stage mode** (Ctrl+Shift+S): only decks, mixer and crossfader.
- **Pop-out windows** for the library, decks, mixer and more (for a second monitor).
- **Library without a scrollbar**: shows exactly the rows that fit and moves with the wheel, arrows,
  Page Up/Down or a controller's browse encoder; Enter loads to the free deck.
- **Decks and mixer redesigned per size**: tabs for hot cues / loops / FX / stems, popovers for the
  rest; every control is still reachable.
- **Settings in a modal with tabs on the left**: search across all settings (Ctrl+,), export and
  import with a preview of every change, settings profiles (Home / Club / Streaming), reset per
  section and undo.
- **Skins and Marketplace**: built-in skins (colour-safe decks, high contrast, Booth, Studio light),
  `.mixaipack` packs (skins, layouts, bundles) verified with Ed25519 signatures before use, try any
  skin for 30 s, and a Marketplace on mixai.ro (free and Pro packs).
- Colour-blind deck palettes, high contrast and touch mode (44 px targets).
- Optional beat-reactive accent, a performance HUD, and an animation governor that cuts animations
  when the interface drops under ~55 fps.
- First-run tour (layout, look, controller).

## 1.2.0 — 2026-11-09

- **Bluetooth MIDI controllers, built in.** Settings → Bluetooth MIDI scans for any BLE-MIDI 1.0
  controller (tested with the Pioneer DDJ-FLX4) and connects directly. No Windows driver, no
  pairing and no extra app needed, on Windows, macOS and Linux.
- The controller uses the same mapping and MIDI Learn as USB controllers (DDJ-FLX4 auto-maps).
- LED feedback over Bluetooth: PLAY / CUE follow deck state.
- Auto-connect: the last controller is remembered and reconnects when it is switched on or comes
  back in range.
- Live link stats: messages per second, packet gap (p95) and signal strength.
