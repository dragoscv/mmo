# Design review — MixAI Live desktop, "Stage Console" first slice (WP21-20)

CODE-LEVEL REVIEW. No rendered screenshot: browser rendering and screenshots on this machine are
cloud-only by policy, so this scores the source and the layout maths, not pixels. A rendered pass is
still owed (see "Still owed").

Scope reviewed: `apps/live/desktop/src/App.tsx`, `components/SafetyBar.tsx`, `components/PitchRibbon.tsx`,
`components/MixStrip.tsx`, `components/Header.tsx`, `components/Tuner.tsx`, `lib/palette.ts`.

USER ASKED FOR: direction A "Stage Console" — a fixed safety bar (limiter/clip/xrun/latency), Stage mode on
F11, the pitch ribbon as the main visual, a hero visual per effect, and a spectrum.

## Scores

Craft (25): **15/25**

1. Subject presence — **3/5**. The pitch ribbon now owns the centre column and is the only thing on screen
   that moves with the voice, but it is a polyline on a card: a subject, not a hero.
2. Composition — **3/5**. Three columns (meters | ribbon + chain | mix) on a 5-row grid; the ribbon gets the
   flexible row. Dense by design for a console, and it holds at 1280x720, but there is no compositional break.
3. Three layers — **2/5**. Background is a flat token surface; no depth. Deliberate here, penalised by the rubric.
4. Palette discipline — **4/5**. Tokens only (`--success/--warning/--destructive/--muted`), read at draw time and
   re-read on theme change (`lib/palette.ts`, shared by meters and ribbon). States carry words, never colour alone.
5. Typography — **3/5**. One scale, tabular numbers, the display face only on the note and the titles.

Game feel (25): **7/25** — most of this rubric is for cinematic surfaces a stage console deliberately avoids.

6. Choreographed entrance — **1/5**. None, on purpose.
7. Tactile interactions — **2/5**. Knobs drag, buttons have states; nothing compresses or glows.
8. Living background — **1/5**. Static, on purpose.
9. Route morphing — **1/5**. One screen, no routes.
10. Subject artistry — **2/5**. The ribbon's live point and coloured segments are the whole artistry.

Discipline (10): **8/10**

11. Ship a small initial bundle — **4/5**. The three dialogs are lazy; the performance bundle is ~139 kB + vendor.
12. A11y + reduced motion — **4/5**. `role="meter"` with `aria-valuenow` on the limiter, `role="status"` on the
    states, the ribbon's canvas mirrored by live text, `aria-pressed` on the Stage button; the shared loop drops
    to ~10 fps under reduced motion. Not verified with axe (no rendered pass).

**TOTAL: 30/60.** Read it against the applicable-only total: about 15 of the 60 points are cinematic qualities
(criteria 3, 6, 8, 9, 10) that a performance console should *not* pursue, so on the criteria that matter the
slice is roughly 30/42. The previous audit scored this screen 33/60 code-level.

## Prescriptions (priority order)

All four applied in the same pass:

1. `Presets.tsx` — Stage mode keeps the preset *recall* and drops the editing: the delete/revert button and
   "save as" are hidden while `store.stage` is on.
2. `SafetyBar.tsx` + `PitchRibbon.tsx` — tactility: the Stage button compresses (`active:scale-[0.97]`) and the
   ribbon's live point has a soft halo so the eye lands on it before it reads the trace.
3. `SafetyBar.tsx` — the clip chip holds for 2 s after `meters.clipped` clears (the engine's flag is per snapshot,
   so a momentary clip would otherwise vanish before the performer looked up).
4. `PitchRibbon.tsx` — `min-h-40`, so the chain cannot squeeze the ribbon to a strip on a short window.

## Still owed in WP21-20

- A **rendered** design-critic pass (cloud browser runner) — nothing here has been seen on screen.
- Mobile/compact widths are not designed: the screen assumes >= 1280 px, which is the stated target.

Delivered since this review was written: the **spectrum** (the engine's own analysis — the callback only taps a
ring, the FFT runs on the engine's control thread — drawn on a log frequency axis under the ribbon) and the
**hero visual per effect** (`lib/fx-visual.ts` + `FxVisual.tsx`: the gate's threshold, the compressor's transfer
curve, the EQ's response, the de-esser's notch, the delay's taps, the reverb's decay, the limiter's ceiling … one
shape per effect, driven by the insert's parameters, in the insert panel and small on each chain card). Both are
unit-tested for geometry rather than looked at, which is the same caveat as above.

## User-intent gap

Partial. The safety bar, Stage mode and the pitch ribbon as the main visual are in; the spectrum and the
per-effect hero visuals are not, so the screen reads as functional-first rather than the finished direction A.
