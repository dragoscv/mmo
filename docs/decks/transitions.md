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

## Tests

- `cargo test -p decks-transition`: 31 (Camelot parsing/scores/pitch classes, ranking incl. half/double time,
  energy direction, penalties, determinism; curves, normalise, edits, runner; plan styles, phrase alignment, bass
  never doubled, short-track fallback, full run; safety; RO/EN intents and LLM validation; riser length/level/swell/
  determinism).
- `cargo test -p decks-ffi --lib`: rank → plan → safety round trip, intents + schema + riser, runner on a stopped engine.
- `:decks-ui:desktopTest` `TransitionTest` (5): demo engine refuses, suggestions + load, safety, command → plan → run →
  finish, cancel.

## Not in this slice

codai call for unrecognised commands (the schema and validator are ready; the app-side HTTP call needs the MixAI
account token), speech-to-text capture, SwiftUI panel, the automation lane editor UI (the JSON + edit primitives exist).
