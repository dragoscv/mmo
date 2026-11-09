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
