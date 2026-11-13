# AI Transition Designer (WP19-20)

Crate `apps/mixai/src-tauri/crates/decks-transition` (MIT OR Apache-2.0, no dependencies beyond serde),
exposed by `decks-ffi` as `transition_*` functions + `TransitionRunner`, used by the Compose **AI mix** panel.
Pure and deterministic: everything runs on the device, offline, in microseconds.

## Pieces

| Function | What it does |
|---|---|
| `rank_next(playing, candidates, opts)` | Score = 0.4 key + 0.35 tempo + 0.25 energy − repetition (played < 60 min ago, up to −0.5) − same artist (−0.15). Reason tags: `key_same/relative/adjacent/boost/diagonal/clash/unknown`, `tempo_close/far`, `energy_hold/up/down/jump/against`, `recently_played`, `same_artist`, `stems_ready`. Half/double time counts as a match (87 ↔ 174). |
| `rank_next_with(playing, candidates, opts, extras)` | The same ranking with extras a caller asks for. `RankExtras { key_shift: true }` adds the key-shift proposal and keeps a proposed track below every track that fits as it is (see "Key-shift proposal"); `RankExtras::default()` is exactly `rank_next`. Only the desktop shell passes it. |
| `propose_key_shift(from, to)` | The smallest key shift of `to` (±1, then ±2 semitones) that turns a clashing pair into one that fits, or `None`. |
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

## Key-shift proposal (WP19-61, desktop only)

A candidate whose key clashes with the playing deck may fit after a key shift of one or two semitones. The desktop
co-pilot says so, ranks the track accordingly, and one button loads it and sets the shift.

**The rule** (`camelot.rs`, `propose_key_shift`; one semitone = 7 wheel steps, letter kept: 8A + 1 = 3A):

- Asked only for a **clash**: key score below 0.45 (`KEY_CLASH_BELOW`, the same line `check_safety` warns at and
  `plan_transition` echoes out at). A boost (0.6), a diagonal (0.5) and an unknown key (0.5) get no proposal.
- A shift is accepted when the pair then **fits as it is**: key score ≥ 0.85 (`KEY_FITS_FROM`), i.e. same key,
  relative or adjacent.
- Tried in the order ±1, then ±2. Tie rule: the smaller shift first; at the same size the better resulting relation
  (same > relative > adjacent); then the upward one (8A against 2A: +1 → 9A and −1 → 7A are both adjacent, +1 is
  proposed). With these two levels no pair has both a one- and a two-semitone fix (tested over all 576 pairs), so
  in practice only the upward rule ever decides.
- Of the 576 ordered pairs of the 24 keys, 264 get a proposal; the rest either do not clash or cannot be fixed
  within two semitones (8A against 2B). The whole table is `fixtures/key-shift-proposals.txt`; the crate and the
  desktop port (`src/copilot/key-shift.ts`, used by the set builder) are both tested against it.

**Where a proposed track ranks** (`rank.rs`). Two rules, in this order:

1. Its **key term** is no longer its clash value (0.24 at most) but

| Shift | Key term | Why there |
|---|---|---|
| ±1 semitone | `KEY_SHIFT_ONE` = 0.7 | Below the key term of every pair that fits untouched (adjacent 0.85): the DJ has to do something and the deck then plays through the pitch shifter. Above boost (0.6), diagonal and unknown (0.5): after the shift it is a real harmonic fit, and one semitone is hard to hear. |
| ±2 semitones | `KEY_SHIFT_TWO` = 0.55 | Below boost (0.6): two semitones are heard on voices and bass, so a pair that works untouched comes first. Above diagonal and unknown (0.5): once shifted it fits for certain. |

  The reason tag `key_shiftable` replaces `key_clash` and comes first; the result carries `key_shift` (±1 / ±2)
  and `key_after` (Camelot). Both values are judgement calls, not measurements: nobody has listened to a ranked
  list to tune them.

2. **A row with a proposal never ranks above a track that fits as it is.** The key term alone does not give that:
  the score also holds tempo and energy, so a proposal dead on tempo (0.4 × 0.7 + 0.35 + 0.25 = 0.880) would
  outrank an adjacent-key track 3 BPM off (0.4 × 0.85 + 0.35 × 0.803 + 0.25 = 0.871). So, after scoring and
  **before** the list is cut to its limit, every proposal row that scores at or above the *lowest-scoring* fit
  row of the candidate list is capped to just below that row's score ("fit" = natural key term ≥ 0.85,
  `KEY_FITS_FROM`: same, relative, adjacent; lowest, so the proposal lands below *all* of them). The `score` a
  row reports is the capped one (the score it is sorted by). Capped rows keep the order they had among
  themselves (one float step apart); rows that tied still tie-break by id. Rows **without** a proposal are never
  moved: their order among themselves is exactly the plain ranking's.

  What the rule does *not* promise, on purpose: with no fit row in the candidate list nothing is capped, and a
  proposal **can** rank above a natural "boost" (0.6), a diagonal pair and an unknown key (0.5); those are not
  fits (see the table). Example with the dev library (11 tracks, reference 6B): before the cap two `+1`
  proposals stood at 1 and 2 above the only adjacent-key track (0.605 against 0.519, the fit being 7.6 BPM off);
  with the cap that track is first.

`rank_next` (extras off) does none of this and is tested bit for bit against a copy of the ranking as it was before
proposals existed.

**Desktop only.** `copilot_rank` takes `keyShift` (default off, so a caller that does not send it gets the old
ranking) and always returns `keyShift` / `keyAfter` (null without a proposal). `decks-ffi` still calls `rank_next`:
Android and iOS rank exactly as before and their generated bindings are unchanged. A newer UI on an older shell
sees rows without the field, shows no button and keeps the old set-builder behaviour.

**The reference key is the key the deck sounds in**: the track's key moved by the deck's own key shift, rounded to
a whole semitone, the same rule as the deck's key display. The ranking, the rows' key chips, the plan, the safety
check and the set builder's key filter all use it, so shifting the playing deck by +1 changes what fits. Limit:
with key lock off a tempo change bends the pitch too (about 6 % per semitone); that drift is not counted, as it is
not in the deck's key display either. The phone remote differs here: the key it shows for a deck (`remote.rs`
`effective_key`) does include the tempo drift when key lock is off, so with key lock off and the pitch fader away
from zero a phone can name another key for the same deck than the desktop deck and the co-pilot do.

**One key verdict inside the co-pilot.** The row's key chip, the set builder's "in key" filter and the ranking judge
a pair of keys by the same score, the crate's `key_score` (TS mirror `crateKeyScore`, exposed as `keyVerdict`:
fits from 0.85, clash below 0.45, "workable" between). The rest of the app (the Library's own chips, auto-mix)
uses `src/lib/harmonic.ts`, which differs on exactly one class of pairs: the same letter five wheel steps apart,
i.e. keys one semitone apart (8A against 1A or 3A). The Library calls that pair workable ("energy boost"); the
co-pilot calls it a clash and proposes the one semitone that turns it into the *same* key. Inside the co-pilot a
row therefore never shows a "workable" chip next to "Key +1 fits", and such a track is in an "in key" request
only through its proposal. The same track can still carry a "workable" chip in the Library list behind the
popover; aligning `lib/harmonic.ts` with the crate is a follow-up.

**In the popover** a row with a proposal starts its reasons with "Key +1 → 8A fits" and has one more button
(e.g. `B+1`) between the title and the tempo: it loads the track on the other deck and sets the shift. **A** / **B**
still load without a shift. A line under the list says which deck carries a co-pilot shift. The button is never
natively disabled; it shows three more states, each named in its accessible name:

- **loading** (`B…`): its load is in flight; the key follows the moment the engine has the track. A second press
  for that deck, on this or another row, is answered with "Deck B: still loading" and starts nothing.
- **done**: the track is on the deck with this shift.
- **the deck is playing**: the incoming deck is on air. The button is off (pressing it says "Deck B is playing:
  nothing was loaded and no key was shifted"): loading over the deck on air stays the DJ's call through the
  normal **A** / **B** buttons, not through a button that also changes pitch.

**No button in a pop-out window.** A panel popped out into its own window is a separate page with its own co-pilot
state: a shift applied there would be recorded where the main window never looks, would not go back to 0 on the
next track and would be forgotten when the pop-out closes. So in a pop-out the row keeps its reason text ("Key +1
→ 8A fits") but has no key-shift button, and the store refuses the action there.

**Apply and undo** (`key-shift.ts`, `applyProposal` and `createShiftKeeper`), decided on what the engine holds:

- The shift is set **as soon as the engine reports that very track on the deck**, never before. It does not wait
  for the rest of the load: for a track with stems the loader goes on to fetch them (an HTTP call with a 15 s
  limit, then four decodes), seconds after the deck is playable, and a pitch that jumped then could jump on air.
  While the load runs the engine is asked every 100 ms (for a minute at most; after that the load's own answer
  decides). A failed load, or a load another one overtook, changes no key shift. A track already on the deck is
  not loaded again, only shifted.
- **Never under a deck that is already playing.** If the deck is playing the new track when that moment comes (the
  DJ was faster), nothing is shifted and the status line says "Key +1 not applied: deck B was already playing".
  "Playing" is the engine's own transport state, read the same on two looks 100 ms apart (right after a load the
  engine can still report the transport of the track that was there before).
- The deck gets another track (or is emptied): the shift goes back to 0, but only when it still is the value the
  co-pilot set. A DJ who changed it in between keeps the value.
- The DJ changes the shift by hand on the same track: the co-pilot forgets it applied one; nothing is reset.
- A transition (plan, Go, its run, Cancel, its end) never touches a key shift.
- The UI store and the engine briefly disagree after a shift is set (a clock answer that predates the command
  writes the old value back for about 70–110 ms; measured live). A decision is made only when both say the same on
  two looks in a row, 120 ms apart, at most 8 looks; a reading that never settles resets nothing.
- Every question to the engine waits 2 s at most. A call that never answers ends that look with nothing decided,
  so it cannot keep a deck's later checks (and so its undo) waiting behind it.
- What was applied is kept in session storage (`mixai-copilot-key-shifts`), so a page reload keeps the undo; an app
  restart starts with empty decks and no record.

**"Mix next" never picks a clash by itself.** With an empty incoming deck, "Mix next" (the button and the typed
command) loads a suggestion there first. It takes the first row that carries **no** proposal: a row with one would
go on the deck unshifted (the automatic load changes no key: nothing changes the sound without a gesture), as a
key clash, and be planned as an echo-out. Only when every row on the list carries a proposal is the first one
loaded, and then the status line says so and names the way out: "… is on deck B and clashes in key as loaded. Its
B+1 button shifts it to 8A." (the track is on the deck, so that button only shifts).

**The set builder**: `in key` / `harmonic` keeps a track a proposal can make compatible; a clash no shift within
two semitones fixes is still dropped. In the list, **every row without a proposal comes before every row with
one**, whatever they score: the two groups are ranked one after the other (the tracks that pass as they are fill
the list first, the ones that need a shift get the rows that are left; ranked as one list a one-semitone proposal
would outscore a natural "boost" at the same tempo). `same key` and `relative key` stay strict. On a shell
without proposals no track that needs a shift is listed.

Not tested: a track with ready stems on a real engine (the dev library has none: the "engine has the track, then
the shift" path was timed live with plain tracks and tested with a slow fake stems call); the cap of the ranking
and the two-group "in key" list on a running app with the fixed crate (the exe on the dev instances predates the
cap; checked there only at the level of the store and its tests); a pop-out window on screen (none may be opened
during the checks: source and store tests only); the pitch drift with key lock off; macOS / WKWebView; and a
proposal aimed at deck C or D.

## Desktop co-pilot (WP19-39)

MixAI Decks desktop (`apps/mixai`) uses the same crate through `src-tauri/src/copilot.rs` (commands `copilot_rank`,
`copilot_plan`, `copilot_run`, `copilot_cancel`, `copilot_status`, `copilot_safety`, `copilot_intent`,
`copilot_intent_schema`) and the popover behind the **Copilot** button of the Library toolbar (`src/copilot/`).

**It is a rule-based helper, not a model.** Suggestions are the fixed-weight score above on key, tempo and energy;
plans come from the style table above; typed requests are read by two small parsers. The same input always gives
the same answer, offline, with no network call. The UI never calls it "AI".

| Part | What it does |
|---|---|
| Next track | Ranks the tracks the Library has loaded against the playing deck (its tempo with the pitch fader applied, on a 0.5 BPM grid; its key with the deck's key shift applied) and shows up to 8 with their reasons; **A** / **B** load one. A track that clashes but fits after one or two semitones of key shift says so, never ranks above a track that fits as it is, and has a third button that loads it with the shift (see "Key-shift proposal"). Energy direction: hold / up / down. |
| Set builder | A typed RO / EN request becomes filters on those tracks: free words (title, artist, genre, album, file name; diacritics optional), a tempo window (`95-105 bpm`, `peste 130`, `până la 128`, `around 124`; half / double time counts), decades (`90s`, `anii '90`, `anii 80 și 90`), key relation (`in key` / `harmonic` = compatible by the ranking's key score, incl. tracks a key shift makes compatible, always listed after the ones that need none; `same key`, `relative key`), `more energy` / `mai lent`, `with stems`, favourites, not played tonight. The chips under the field show what was understood. |
| Mix next | Plans a phrase-aligned transition from the playing deck to the other one (length and style can be chosen), **Go** runs it, **Cancel** stops it. Typed commands do the same (`mix next in 8 bars with echo`, `fă tranziția în 16 măsuri`). With an empty incoming deck it first loads the best suggestion that needs no key shift. |
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

Tests: `cargo test -p mixai copilot::` (29; shell: validation, hostile keys end to end, runs against a recording
engine, track change, missing runner thread, the key-shift option off by default and its fields on the wire, a
proposal reaching the UI below every track that fits as it is), and `node --test src/copilot/*.test.ts` in
`apps/mixai` (105: request parser, plural forms RO / EN, row fit incl. touch mode, the wire contract against the
Rust source, the key-shift rule against the shared table, apply / undo of a key shift with fake stores and a fake
clock, the co-pilot store itself with a fake shell and fake engine — when the shift lands, a deck that already
plays, "Mix next", the "in key" order, pop-out, a second press — and a scan that keeps regular-expression
lookbehind out of the shipped sources: WKWebView before Safari 16.4 cannot parse it).

## Tests

- `cargo test -p decks-transition`: 48 (Camelot parsing/scores/pitch classes and keys that are not Camelot, semitone
  shifts against a written-out table of all 24 keys, the key-shift rule over all 576 pairs and against the shared
  table; ranking incl. half/double time, energy direction, penalties, determinism, the key-shift extra on and off;
  a proposal never above a track that fits as it is, and the plain ranking bit for bit as before proposals;
  curves, normalise, edits, runner; plan styles, phrase alignment, bass never doubled, short-track fallback, full
  run; safety; RO/EN intents and LLM validation; riser length/level/swell/determinism).
- `cargo test -p decks-ffi --lib`: rank → plan → safety round trip, intents + schema + riser, runner on a stopped engine.
- `:decks-ui:desktopTest` `TransitionTest` (5): demo engine refuses, suggestions + load, safety, command → plan → run →
  finish, cancel.

## Not in this slice

codai call for unrecognised commands (the schema and validator are ready; the app-side HTTP call needs the MixAI
account token), speech-to-text capture, SwiftUI panel, the automation lane editor UI (the JSON + edit primitives exist).
