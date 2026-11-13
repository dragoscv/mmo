# MixAI Decks changelog

## 1.7.0 — 2026-11-14

### Added

- **Set tracklist** (Tracklist button in the title bar, next to REC; also "Set tracklist" in the
  command palette): while the master mix is recorded, the app writes the tracklist by itself. A
  track is listed once it has been the loudest one in the mix for 20 seconds, with the time it took
  over; cue checks and short previews are left out. The level of a deck is playing × channel fader
  × its crossfader side (a deck on THRU is always heard). A track doubled on a second deck stays
  one line. A wrong entry can be removed; its time goes to the entry before it.
- **Copy tracklist**: puts the list on the clipboard as text, one line per track
  (`01. [0:00] Artist – Title`), ready for a Mixcloud, YouTube or SoundCloud description.
- **Open Mixcloud upload**: copies the tracklist and opens the Mixcloud upload page in your
  browser. You paste the tracklist there and pick the WAV file yourself: the app does not sign in
  to Mixcloud and does not upload anything itself.
- The last recorded set (date, length, WAV file name, tracks) is kept on this computer until a
  later recording lists its first track or you press Clear, so a set can be uploaded the next day
  and a sound check does not erase it. During a recording the list is also saved once a minute.
- **"Now playing" page for OBS** (Connect in the status bar, tab Stream): a page that shows the
  title and artist of the track on air, made for an OBS Browser source. Press Copy and paste the
  address as the URL of the source (1200 × 240 is a good size; the background is transparent). A
  track is on air once it has been the loudest one in the mix for 8 seconds, and the page clears
  after 8 seconds of silence. Options in the address: `align`, `scale`, `plate`, `label`, `lang`.
  The address has its own code that can only read that title; it cannot control anything.
- **Gig lock** (GIG chip in the status bar, left of Practice; also "Gig lock" in the command
  palette and Ctrl+Shift+G): lock the app before a set so nothing changes or interrupts by itself.
  While locked, Settings stay closed whichever way you try to open them, settings profiles and the
  cloud profile sync wait, a controller that connects does not switch the layout, skin tries end
  and the skin and layout editors close, plugin notifications are hidden (the chip counts them and
  the popover keeps their texts), closing the window asks first, and on Windows the computer and
  the display stay awake. The decks, the mixer, layout hotkeys, stage mode and the phone remote are
  not locked. Locking is one click; unlocking takes two steps (Unlock, then Confirm within five
  seconds, or the hotkey twice), so it cannot happen by accident. A crash or a restart during a set
  comes back locked (a lock older than 12 hours is dropped when the app starts, and says so).
- **Checklist before a set** (GIG chip → Checklist): audio device, buffer and sample rate, mains or
  battery, room on the recording drive in hours of recording, dropouts measured over ten seconds,
  the music server, the controller. Each row shows OK, Warning, Problem or Unknown in words, when it
  was checked, and what to do about a warning. You can lock with warnings; the DJ decides.
- **Key-shift suggestions in the co-pilot** (copilot button in the Library toolbar): a track whose
  key clashes with the playing one is no longer buried at the bottom of the list. When shifting it
  by one or two semitones would make it fit, the row says so ("Key +1 → 9A fits") and one extra
  small button (`B+1`) loads that track on the other deck and sets the shift for you. The pitch
  changes only once the engine really has the track, never under a deck that is already playing,
  and a copilot shift goes back to 0 when that deck receives another track, unless you changed it
  yourself. A track a shift would fix never ranks above a track that already fits, "Mix next" never
  picks such a track by itself, an "in key" set request lists the tracks that fit untouched first,
  and the row's key chip always agrees with the reason next to it. Desktop only: the ranking the
  Android and iOS apps get is unchanged.

### Changed

- **Connect always starts on its usual port** (47831). If that port is busy it uses another one for
  that run only, says so on the Stream tab, and tries the usual port again at the next start.
- The Connect server answers only requests that name it by an IP address or `localhost`; anything
  else gets 403. The stream address keeps its code between starts, so OBS keeps working after a
  restart; "New code" revokes the old address at once and disconnects it, while phones stay
  connected.
- The "Now playing" page names a fallback font stack: it uses the fonts of the computer it runs on.

### Fixed

- A device that was let in a moment before a pairing code was changed stayed connected with the
  revoked code (the phone / second-screen codes since 1.6.0, and the stream overlay). The code and
  its revision are now read together.
- `remote_set` applies or refuses its whole batch (deck labels, party switch, a new overlay code)
  as one.
- **Close anyway** in the gig lock question stops a running recording and waits for the file to be
  finalised before the window closes, so the WAV is not left with a zero length.

## 1.6.0 — 2026-11-12

### Added

- **Stem crossfader** (STEMS tab, or "More stem controls" in a small tab): a small crossfader per
  stem. At the centre the stem follows its deck; towards the crossfader side the deck is not on, it
  fades out, using the mixer's crossfader curve. Double-click returns it to the centre. A deck on
  THRU has no side, so its stem crossfaders do nothing and show a THRU tag.
- **MUTE FX** (STEMS tab): a stem muted while the deck plays leaves an echo tail at 1/4, 1/2, 1 or
  2 beats, which ends by itself after 12 repeats. It needs a tempo: on a track without BPM or
  beatgrid, on a paused deck and in reverse a mute is a plain mute.
- **Cue loops**: a hot cue can store the running loop. Press the loop button next to the pads,
  then a pad, or Alt+click the pad (Alt+Enter on a focused pad). The pad shows a loop sign and the
  length in beats; pressing it jumps there and starts the loop. With no loop running the same
  button takes a loop off a pad and keeps the cue. Needs a tempo; like hot cues, cue loops are not
  kept when another track is loaded.
- **Tempo sync between Decks instances** (LINK in the status bar): instances on this computer or
  on the local network share one tempo and beat. The instance that started the session leads, the
  others follow; decks with SYNC on follow the shared clock. Followers can nudge by a quarter beat.
  An optional 4-digit PIN groups instances; it is a grouping code, not a password. This is MixAI's
  own protocol and does not work with Ableton Link. Audio latency between computers is not
  compensated.
- **Co-pilot** (Copilot button in the Library toolbar): up to 8 next-track suggestions with the
  reason (key, tempo, energy), taken from the tracks the Library has loaded (at most 2,000); a set
  builder that reads a typed request in English or Romanian ("90s hip-hop 95-105 BPM"); Mix next,
  which plans a phrase-aligned transition to the other deck that you start with Go and can cancel;
  and set-safety warnings while a deck plays. Suggestions and plans are worked out in the app by
  fixed rules, with no online service; the words of a request also go to the Library search.
- **Connect** (status bar): phones on the same network scan a QR code to get a remote for the
  decks and mixer, a read-only second screen, or a guest page for song requests and votes. Only the
  guest code is shown at first. Requests can be accepted, rejected, marked played or looked up in
  the library. "Lock phones" blocks deck and mixer commands from phones; "New code" disconnects
  the devices paired with the old one, and every start makes new codes. A deck playing because a
  phone holds CUE goes back to its cue point if that phone drops off (within about 5 s), and your
  own PLAY, PAUSE and CUE (on screen, keyboard or controller) always win over a phone's held CUE.
  Windows asks for network permission the first time: allow it on private networks.
- **Practice mode** (status bar): while two decks play and are heard, scores the mix 0–100 from
  tempo match, beats aligned, key match and steady level, with a meter for each, up to three tips
  and a small bonus for slow crossfades in time. It is an estimate, not a verdict on a mix.

### Changed

- Unmuting a stem brings it back at the level it had before the mute, not at full level.

### Fixed

- On a track without a beatgrid the loop state in the tooltip and for screen readers said "Loop on,
  0:02.0 beats"; it now gives the length as a time.

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
