# MixAI Decks changelog

## 1.5.0 — 2026-11-11

### Added

- **Waveform band**: a new panel with the scrolling waveforms of every deck, drawn in three bands
  (bass, mids, treble), with a centre playhead, beatgrid, hot cues, loops, tempo-change flags and the
  number of bars to the next cue. It has a beat keeper and a phase meter, zooms from 4 to 32 seconds,
  seeks by drag or arrow keys, stands upright in a tall box, can show all decks in one lane, and
  shows stem lanes when stems are on.
- **Two new layouts**: **Pro** (waveform band on top, decks around the mixer, library below) and
  **Vertical waves** (tall waveforms between the decks).
- **Deck**: remaining time as the main time readout, an end-of-track warning (30 s and 15 s before
  the end), an overview waveform with a phrase band (intro / build / main / break / outro, an
  estimate), a key chip in Camelot colours with a mark showing whether the key fits the other deck,
  and an optional virtual platter (Settings → Appearance, off by default).
- **Library**: columns for a preview waveform, energy and date added; played tracks are dimmed (a
  track counts as played after 30 s); filters **Matches deck A / B** (compatible key and tempo within
  ±6 %), **Not played tonight** and **Favourites**.
- **Status bar**, always visible: engine state, master level, audio load in percent, late audio
  buffers (x-runs), sample rate and buffer, output device, library connection, clock, and the active
  skin and layout.
- **Booth mode** (title bar or Settings → Appearance): bigger readouts and stronger contrast.
- **Colour-blind-safe hot cue colours** (Settings → Appearance).
- **First-run tour**: a "Coming from another app?" step that picks a familiar look and layout.
- **Skins**: Mainroom, Crate and Pilot (looks that read like other DJ applications; neutral names, not
  affiliated with or endorsed by their makers, no logos) and **Glass (classic)**, the look of Decks 1.x.
- **Skins can change more**: a skin can now choose the base look, the layout it opens with, the
  waveform arrangement, waveform / control / hot cue colours and a few sizes (new `style` block, pack
  manifest version 2). Your own layout comes back when you leave such a skin.
- **Skin editor** (Settings → Appearance → Create / edit a skin): a floating panel that changes
  colours, sizes, layout and waveform arrangement on the running app, warns about unreadable colour
  pairs, saves the result as your own skin and exports it as a `.mixaipack`.
- **Crossfader curve** (linear, smooth, sharp) and **crossfader side per deck** (A, THRU, B) now act on
  the audio; before, the mixer showed them but the engine ignored them.
- The waveform band can be popped out to its own window, like the other panels.
- Built-in skin names and descriptions are translated.
- Inter and JetBrains Mono are bundled with the app (SIL Open Font License 1.1).

### Changed

- **New default look, "MixAI Signature"**: black-green, flat and dense; green marks everything that is
  on, and colour is kept for the decks, waveforms and hot cues. Existing installs move to it once; an
  accent colour you had picked is kept. The previous look stays available as the skin Glass (classic).
- **Default layout is Pro.** An install still on Classic moves to Pro once; any other layout you chose
  is kept.
- **Decks, mixer and crossfader are more compact** and fit smaller boxes: flat transport, tempo fader,
  two-size BPM in the deck colour; the mixer is laid out as A | MASTER | B with segmented level meters
  and peak hold, with routing and beat FX in a popover.
- **Library rows are denser** (22 px in the default look), with a sortable header.
- **Title bar** is flat, 36 px high.
- **Packs made for 1.5 need 1.5**: a pack with manifest version 2 is refused by Decks 1.4
  ("unsupported manifest version 2 (expected 1)"). Version 1 packs are unchanged and work everywhere.
  A layout that uses the waveform band is not accepted by Decks 1.4 either.

### Fixed

- Tempo controls did nothing in the desktop app; they now change the tempo.
- Loading a track from a library on another computer failed ("track has no filepath").
- A track that fails to load is now reported in the library instead of failing silently.
- Lower processor use while idle: panels no longer redraw on every engine update when nothing changed.
- Hover, zebra and selection tints kept the wrong hue on tinted grey skins (pink rows, an olive
  selection); tints are now mixed in OKLab.
- Colour FX controls reach the 44 px touch size in touch mode.
- Arrow keys used inside the track list, a waveform lane or the beatgrid marker row also moved the
  crossfader; they now act only where the focus is.
- Crossfader curve, crossfader side and beat FX type are one tab stop each; arrow keys, Home and End
  move the selection.
- A setting changed while a skin was active (language, reduced motion, accent) was undone at the
  next start, on a skin switch or when the skin was removed.
- Opening a local file that fails to load left the deck's waveform blank and the old key on the key
  chip; the previous track's display is restored and the library shows the error.
- Beat lines, bars to the next cue and loop marks used 20 BPM and a first beat at 0 for a track
  without a saved grid; they follow the detected tempo and first beat.
- CUE on a newly loaded track could jump to the previous track's cue point.
- A right or middle click on a fader no longer moves it.
- An audio file declaring a sample rate under 240 Hz closed the app while its waveform was built.
- A pack made for a later manifest version is refused with "needs a newer MixAI Decks" instead of
  an "unknown field" error.
- Development builds only: key lock overloaded the audio callback (the time-stretcher was built
  without optimisation).

## 1.4.0 — 2026-11-10

- **Flexible beatgrid**: tracks whose tempo changes (live drummers, edits, old records) get a grid
  that follows them, with tempo-change markers only where the tempo really changes. Markers can be
  added at the playhead, nudged, retuned and deleted (new **Grid** tab on each deck), and a
  **fixed grid** switch flattens the grid without losing the markers.
- **Encoder-drift correction on import**: MP3s from Traktor whose cues and grids land one MP3 frame
  (~26 ms) off are shifted back automatically. The offset is confirmed against rekordbox converters,
  not yet measured against Decks' own decoder; other apps are left unchanged until measured (see
  docs/decks/beatgrid.md).
- **Import from rekordbox, Serato and Traktor** (Android, Windows/macOS/Linux desktop and iPhone/iPad
  apps): preview before anything is written, choose who wins when a track already exists, find moved
  files under folders you pick, and get a report. Many real-export quirks are handled (Windows and
  macOS paths, Traktor volume names, Serato `database V2`, FLAC/AIFF markers). No subscription is
  needed to bring your library or to use your controller. OneLibrary stays unavailable: there is no
  public specification and no partner access.
- **Library safety**: an automatic snapshot every day and before every import or upgrade,
  "Snapshot now", one-click restore (the current state is kept as a snapshot first), and a
  **Protect library** switch that blocks every change except play history. A damaged library file is
  detected when it opens.
- **Skins and layouts on the native apps**: `.mixaipack` skins and layouts now work in the Android,
  desktop and iPhone/iPad apps with the same solver as this app, so nothing scrolls there either.
  Panels the native apps do not have yet go to the dock.

## 1.3.1 — 2026-11-09

- **Safer webview**: a strict Content Security Policy replaces the empty one: only the app's own
  scripts run, and the network is limited to Tauri and mixai.ro (Marketplace).
- **Faster pack install**: `.mixaipack` bytes travel to the Rust core as raw binary instead of a
  JSON number array (a 25 MB pack was ~100 MB of text).
- **Pack layouts can not clash**: layouts from packs are now named `<pack id>/<layout>`, so a pack
  can never replace a built-in or your own layout, and two packs can share a layout name. Choices
  saved by 1.3.0 (and 1.3.0 settings files) move over automatically. With cloud sync on, update
  every device to 1.3.1: a 1.3.0 device does not know the new names and falls back to Classic.

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
