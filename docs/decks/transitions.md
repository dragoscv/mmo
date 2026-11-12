# AI Transition Designer (WP19-20)

Crate `apps/mixai/src-tauri/crates/decks-transition` (MIT OR Apache-2.0, no dependencies beyond serde),
exposed by `decks-ffi` as `transition_*` functions + `TransitionRunner`, used by the Compose **AI mix** panel.
Pure and deterministic: everything runs on the device, offline, in microseconds.

## Pieces

| Function | What it does |
|---|---|
| `rank_next(playing, candidates, opts)` | Score = 0.4 key + 0.35 tempo + 0.25 energy − repetition (played < 60 min ago, up to −0.5) − same artist (−0.15). Reason tags: `key_same/relative/adjacent/boost/diagonal/clash/unknown`, `tempo_close/far`, `energy_hold/up/down/jump/against`, `recently_played`, `same_artist`, `stems_ready`. Half/double time counts as a match (87 ↔ 174). |
| `plan_transition(req)` | Chooses a style and a start on the next **8-bar phrase** (downbeat-aligned; bar-aligned and shortened when the track ends first), 16 bars by default (8 when time is short), and writes the automation. Returns cue point + tempo ratio for the incoming deck. |
| `TransitionRunner` | Samples the automation against the master clock beat at UI rate and sends only changed values to the engine; lands exactly on final values; `Done`. |
| `check_safety(input)` | 32-bar look-ahead: `ending_without_next` (severity 2 at ≤ 8 bars), `plan_does_not_fit`, `tempo_gap` (> 6 %), `key_clash`, `loudness_jump` (> 3 LU), `no_grid`. Tempo ratio aware. |
| `parse_intent(text)` | RO/EN commands, diacritics optional: "mix next in 16 bars with a bass swap", "fă tranziția în 32 de măsuri cu ecou", "ce urmează? vreau mai multă energie", "pune o buclă de 8 bătăi pe deck B", "anulează tranziția". `None` → ask codai with `LLM_INTENT_SCHEMA` (structured output), validate the answer with `parse_llm_intent`. |
| `render_riser(spec)` | Seeded noise + saw riser on the incoming key's root and fifth, N bars at the tempo, −6 dBFS peak, faded end. Instant offline alternative to the server `audio-gen` loops. |

## Styles

| Style | Chosen when | Automation |
|---|---|---|
| `bass_swap` | key score ≥ 0.85, tempo within 8 % | B in with low cut, basses swap at half-way (never both full), A highs down, A fades out, A paused at the end |
| `filter_sweep` | compatible key, not close | B rises through a low-pass, A leaves through a high-pass |
| `echo_out` | tempo gap > 8 % or key clash | A echoes out (beat FX echo), B starts dry on the half-way downbeat (no sync) |
| `stem_swap` | both tracks have stems | B drums → bass (on the half) → melody → vocal; A drums out, bass swapped, vocal rides to the end |
| `cut` | requested | hard cut on the downbeat (1 bar) |

## Automation format (JSON, editable)

```json
{
  "length_beats": 64, "echo_beats": 0.75,
  "lanes": [
    { "target": { "kind": "eq", "deck": 1, "band": 0 },
      "keys": [ { "beat": 0, "value": -26, "curve": "step" }, { "beat": 32, "value": 0, "curve": "linear" } ] }
  ],
  "events": [ { "beat": 0, "event": "play", "deck": 1 }, { "beat": 64, "event": "pause", "deck": 0 } ]
}
```

Targets: `volume` 0–1, `eq` (band 0 low / 1 mid / 2 high) −26…+6 dB, `filter` −1…1, `stem` (0 vocals, 1 drums,
2 bass, 3 melody) 0–1.5, `echo_wet` 0–1. Curves: `linear`, `smooth` (sine ease), `step`. Events: `play`, `pause`,
`sync`, `stems{on}`. Beats are relative to the transition start. `Automation::normalise` sorts, clamps, merges lanes;
`set_key` and `retime` are the edit primitives.

## App flow (Compose)

1. **Suggest next** ranks the visible library rows against the live deck (louder playing deck, crossfader-aware);
   **Load** puts a suggestion on the other deck.
2. **Auto mix** plans, cues the incoming deck on its first downbeat, sets its tempo ratio, then starts the runner at
   `clock.beat + beats_until_start`. Progress shows in the panel; **Cancel mix** stops it.
3. Safety warnings refresh every 30 frames while the live deck plays.
4. The command field accepts the same RO/EN phrases (voice input feeds the same function).

FFI additions: `DecksEngine.set_stems_active(deck, on)` and `set_stem_gain(deck, stem, gain)` (needed by stem swap).

## Keys

`Camelot::parse` reads Camelot only (`8A`, `12b`, full-width `８Ａ`) and returns `None` for anything else,
whatever the text holds: it walks characters, never byte offsets, so a tag that ends in a multibyte character
(`A♭`, `Am♭` from ID3 `TKEY`) cannot panic. Musical names are not converted here; a key that is not Camelot counts
as unknown (`key_unknown`, score 0.5). Callers may pass tags as they come.

## Desktop co-pilot (WP19-39)

MixAI Decks desktop (`apps/mixai`) uses the same crate through `src-tauri/src/copilot.rs` (commands `copilot_rank`,
`copilot_plan`, `copilot_run`, `copilot_cancel`, `copilot_status`, `copilot_safety`, `copilot_intent`,
`copilot_intent_schema`) and the popover behind the **Copilot** button of the Library toolbar (`src/copilot/`).

**It is a rule-based helper, not a model.** Suggestions are the fixed-weight score above on key, tempo and energy;
plans come from the style table above; typed requests are read by two small parsers. The same input always gives
the same answer, offline, with no network call. The UI never calls it "AI".

| Part | What it does |
|---|---|
| Next track | Ranks the tracks the Library has loaded against the playing deck (its tempo with the pitch fader applied, on a 0.5 BPM grid) and shows up to 8 with their reasons; **A** / **B** load one. Energy direction: hold / up / down. |
| Set builder | A typed RO / EN request becomes filters on those tracks: free words (title, artist, genre, album, file name; diacritics optional), a tempo window (`95-105 bpm`, `peste 130`, `până la 128`, `around 124`; half / double time counts), decades (`90s`, `anii '90`, `anii 80 și 90`), key relation (`in key` / `harmonic` = compatible, `same key`, `relative key`), `more energy` / `mai lent`, `with stems`, favourites, not played tonight. The chips under the field show what was understood. |
| Mix next | Plans a phrase-aligned transition from the playing deck to the other one (length and style can be chosen), **Go** runs it, **Cancel** stops it. Typed commands do the same (`mix next in 8 bars with echo`, `fă tranziția în 16 măsuri`). |
| Set safety | The 32-bar look-ahead above, every 2 s while a deck plays. A warning that asks for action now is also announced to screen readers. |

Behaviour that protects a live set:

- A run belongs to the two tracks its decks held at the start. When either deck gets another track mid-run the run
  stops as cancelled on its next tick (20 ms) and puts nothing on the new track. Loading the very same track again
  is not seen as a change.
- A run is refused when the crossfader cuts the incoming deck by more than 6 dB, when a deck is empty or the
  outgoing one is not playing, and when the thread that plays runs is not there (instead of waiting for ever).
- A cancelled run leaves the mixer where it is; an echo and a sync lock it switched on are switched off (a lock
  left on would keep the incoming deck following the other deck's tempo). A finished run gives the outgoing deck
  its fader, EQ, filter and stem gains back once the plan has paused it.
- A bare `stop` / `oprește` cancels the running transition. For 8 s after one ends it answers "nothing to cancel"
  instead of pausing the deck that has just gone on air; after that it is the ordinary deck command again.
- Arrow keys inside the popover never reach the global shortcuts (bare arrows move the crossfader).

Limits:

- It works on the rows the Library has loaded: at most 2 000, in the Library's current search and sort order. When
  the library holds more, the popover says "searched the first N of M tracks"; narrow the Library list (search,
  playlist) to reach the rest. Free words that are not genre / album words are also sent to the Library search,
  which covers the whole library.
- Key, tempo and energy come from the library analysis. A track without them is ranked as "unknown" (neutral
  score), not excluded. A key relation in a request does exclude tracks without a key, as long as the playing deck
  has a key to compare with; without one the relation keeps every track.
- Keys must be Camelot. Decades need the `year` tag. Only 4/4 is modelled.
- The score knows nothing about the room, the genre or what was played before tonight: it is a short list to choose
  from, not a decision.
- Requests longer than 200 characters are cut (by character, never through one).
- No voice input and no codai call on desktop: a text the parsers do not understand gets "not understood".

Tests: `cargo test -p mixai copilot::` (shell: validation, hostile keys end to end, runs against a recording engine,
track change, missing runner thread), and `node --test src/copilot/*.test.ts` in `apps/mixai` (request parser,
plural forms RO / EN, row fit incl. touch mode, the wire contract against the Rust source, and a scan that keeps
regular-expression lookbehind out of the shipped sources: WKWebView before Safari 16.4 cannot parse it).

## Tests

- `cargo test -p decks-transition`: 33 (Camelot parsing/scores/pitch classes and keys that are not Camelot, ranking
  incl. half/double time, energy direction, penalties, determinism; curves, normalise, edits, runner; plan styles,
  phrase alignment, bass never doubled, short-track fallback, full run; safety; RO/EN intents and LLM validation;
  riser length/level/swell/determinism).
- `cargo test -p decks-ffi --lib`: rank → plan → safety round trip, intents + schema + riser, runner on a stopped engine.
- `:decks-ui:desktopTest` `TransitionTest` (5): demo engine refuses, suggestions + load, safety, command → plan → run →
  finish, cancel.

## Not in this slice

codai call for unrecognised commands (the schema and validator are ready; the app-side HTTP call needs the MixAI
account token), speech-to-text capture, SwiftUI panel, the automation lane editor UI (the JSON + edit primitives exist).
