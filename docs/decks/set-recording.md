# Set recording + automatic tracklist (WP19-22)

Crate `apps/mixai/src-tauri/crates/decks-setlog` (MIT OR Apache-2.0), exposed by `decks-ffi` as `SetRecorder` +
`tracklist_export`, used by the Compose **REC** chip and the set panel.

## Flow

1. **REC** starts the master recording (`DecksEngine.record_start`, 32-bit float WAV) and a `SetLogger`.
   Android writes to the app's `Music/sets/` folder (no storage permission); desktop to `~/Music/MixAI Decks`
   (`-Ddecks.recordDir` overrides). File name `set_YYYY-MM-DD_HH-mm.wav`.
2. Every 15 frames the logger samples the decks. The audible level of a deck is playing × channel fader ×
   crossfader side (deck A left, B right, C/D thru). The loudest track that has been dominant for **20 s** becomes
   an entry, **backdated** to when it became dominant, so previews, cue checks and short blends never appear.
   A track played again after another one gets a new entry.
3. Each loaded deck is labelled from the library row (id, title, artist, path; ISRC when the library has it).
4. **Stop** closes the last entry. Wrong entries can be removed; their time goes to the previous entry.

## Exports

| Format | Use |
|---|---|
| Text | `01. [0:00] Artist – Title` for Mixcloud / YouTube / SoundCloud descriptions |
| CUE | Sheet for the recorded WAV: `TRACK nn AUDIO`, `TITLE`, `PERFORMER`, `ISRC` (only valid 12-character codes), `INDEX 01 mm:ss:ff` (75 frames/s; minutes go past 59) |
| ORDA / UCMR-ADA | Public-performance report CSV, header `Nr,Titlu,Artist,ISRC,Start,Durata difuzare (s)`: start = offset into the set, duration = seconds on air (rounded) |
| Mixcloud | `sections-N-song`, `sections-N-artist`, `sections-N-start_time` form fields as JSON (upload API) |
| M3U8 | Playlist in set order with seconds on air; tracks not in the library keep a comment line |

Android shares the export via the system share sheet; desktop writes `set_<stamp>.<ext>` next to the WAV.

ORDA and UCMR-ADA each set their own submission forms: the CSV carries the fields both ask for (work, performer,
ISRC, time and duration of use). Check their current template before you submit.

## Tauri desktop app (`apps/mixai`): tracklist + Mixcloud upload page (WP19-27, step 1)

Not released yet (changelog: Unreleased 1.7.0). The Tauri app records the master with its own engine command
(`start_recording`, 32-bit float WAV, the file is picked in a save dialog) and does not use `decks-ffi`. Its
tracklist is a TypeScript port of the same rule, in `apps/mixai/src/setlog/`; no Rust code changed, so it works
with the 1.6.0 shell.

| File | What it holds |
|---|---|
| `set-logger.ts` | The rule of `decks-setlog` (`SetLogger`: `observe`, `stop`, `entries`, `remove`), pure |
| `export.ts` | `tracklistText(entries)`: the same bytes as the crate's `export::text` |
| `setlog-core.ts` | Deck snapshot → observation, `SetSession` (logger + saved set), the saved-set parser |
| `setlog-store.ts` | Zustand store; `startSetLog()` is called once by `App.tsx` |
| `actions.ts` | Copy, and "open Mixcloud upload" = copy, then open the page |
| `SetlogButton.tsx`, `SetlogPopover.tsx`, `setlog.css` | Title-bar button and its popover |
| `../bridge/external.ts` | `openExternal(url)`: opens a page in the default browser |

### How it differs from the crate

- The crossfader side of a deck is its own assignment (`crossfaderAssign`: A, THRU or B), not its index: a deck
  moved to the other side, or to THRU, is weighed the way it is heard. The crossfader of the mixer store already
  runs −1 (A) to +1 (B), the crate's range, so it is only clamped.
- A track without an id gets a key from title, artist and duration (rounded to the second).
- Removing the entry of the track that is still on air keeps it out until another track, or silence, takes over.
  By the crate's rule alone the next sample would list it again.
- The same track taking over on another deck (a doubled track) continues its entry; the crate compares track and
  deck and would add a second identical line.
- Time is the start of the recording plus a monotonic timer (`sessionClock`), so a change of the system clock in
  the middle of a set neither stops the logger nor moves the stamps away from the WAV. The logger is fed from the
  engine snapshots, at most four times a second, and only while a recording runs.

### What the DJ sees

- **Tracklist** in the title bar, right after REC (native app only), with the number of entries. It shows while a
  recording runs or a recorded set is saved. Below 1180 px the word is dropped; icon and number stay. The command
  palette item "Set tracklist" opens the same popover at any time.
- The popover: date, length and WAV file name; the entries (number, start, artist – title, deck letter, remove);
  **Copy tracklist**; **Open Mixcloud upload**; **Clear** (asks once, in place). Only the list scrolls, so the
  popover fits the smallest window. What a button did is said in a sentence that screen readers announce.
- **Open Mixcloud upload** copies the tracklist, then opens `https://www.mixcloud.com/upload/` in the default
  browser. The DJ pastes the tracklist and picks the WAV. There is no sign-in and no upload from the app. The
  sentence that says what happened stays in the popover until something else is said (the browser takes the DJ
  away from the window).
- The last set is kept in `localStorage` under `mixai-setlog` (version 1: start, length, file name, entries; at
  most 1000 entries; read back entry by entry, junk is dropped). A new recording replaces it when it lists its
  first track: a sound check, or REC pressed by mistake, keeps the earlier set. While a recording runs the set is
  also written once a minute and when the window goes away, so a crash keeps the tracks and the length so far.

### Opening the browser

`openExternal` accepts only the URLs of a constant list (today the one Mixcloud address) and answers `opened`,
`refused` or `failed`; it never throws. In the Tauri shell it invokes `plugin:shell|open` with `{ path: url }`
through `@tauri-apps/api/core` (`tauri-plugin-shell` 2.6: `open(path: String, with: Option<Program>)`; permission
`shell:allow-open` in `capabilities/main.json`). The plugin's scope is the default, because `tauri.conf.json` sets
no `plugins.shell.open`: `^((mailto:\w+)|(tel:\w+)|(https?://\w+)).+`. The JS package `@tauri-apps/plugin-shell`
is not a dependency. Outside Tauri it is `window.open(url, "_blank", "noopener")`.

### Tests

`cd apps/mixai; node --test "src/setlog/*.test.ts" src/bridge/external.test.ts`

- `set-logger.test.ts`: the crate's five scenarios with the same numbers, plus a THRU deck, an id-less track, the
  same track again later, time going backwards, NaN.
- `export.test.ts`: the crate's `text_tracklist` bytes, stamps, the `ID – ID` rules.
- `setlog-core.test.ts`: observation from a deck snapshot, the saved-set parser, a whole recording session.
- `actions.test.ts`: copy, then open; every outcome has its own sentence.
- `external.test.ts`: the allowed URL reaches the plugin with exactly `{ path }`; every other URL is refused.
- `contract.test.ts`: arrow keys stay in the popover, no native `disabled`, wiring, every string in EN and RO.

### Not in this step

CUE, ORDA / UCMR-ADA CSV and M3U8 exports in the Tauri app (the crate has them), ISRC, an upload through the
Mixcloud API with sign-in, and FLAC.

## Tests

- `cargo test -p decks-setlog`: 10. Covers crossfader weights; a backdated crossfader transition; previews and
  silence ignored; a track played again; removal merging time; time going backwards or arriving after stop. Exports:
  text, ISRC validation, CUE frames and ISRC, CSV escaping and rounding, Mixcloud and M3U8.
- `cargo test -p decks-ffi --lib setlog`: detached logger → tracklist → CUE/CSV; `start` needs a running engine;
  `stop` is idempotent.
- `:decks-ui:desktopTest` `SetRecordTest` (2): demo engine refuses; labels, tracklist, export, stop, remove.

## Not in this slice

Direct Mixcloud upload (needs the user's Mixcloud OAuth token; the section fields are ready), MMO Server publish,
crowd-energy microphone, per-venue profiles, DMX/Art-Net, practice coach, multichannel out. Those are the remaining
WP19-22 items.
