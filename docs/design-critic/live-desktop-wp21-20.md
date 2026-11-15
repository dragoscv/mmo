# Design review — MixAI Live desktop, "Stage Console" (WP21-20)

Two passes: a **code-level** one (scoring the source and the layout maths) and, added 2026-11-14, a
**RENDERED** one on the cloud browser runner — `pnpm e2e:cloud --target vm-live`, 3 Playwright tests
at 1280x720 against the app's own production build, with axe. The rendered pass is the one that
counts; the code-level score below is kept because it is what the prescriptions came from.

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

---

## RENDERED PASS (2026-11-14, cloud runner, the one that counts)

`pnpm e2e:cloud --target vm-live` — the desktop app's own `pnpm build` served by `vite preview` on an
ephemeral GCE spot VM, with Playwright + axe. **3 passed, exit 0**, 25 s, ~$0.001. Artifacts:
`.copilot-tmp/e2e-live/out/test-results/live-desktop-{1280x720,stage-1280x720}.png` (screenshots were
brought back and looked at) and `pw-results.json`. Spec: `apps/web/e2e/live-desktop.spec.ts`; the mode
and the bundle change are in `scripts/e2e-cloud/{run.mjs,vm-run.sh}` (commit `749da286`).

**What the rendered screen confirms.**

- The console lays out at its target size with **no horizontal overflow** (measured, not eyeballed) and
  **no page error**, and ships both languages (`document.title` = MixAI; the runner rendered RO).
- The **safety bar** is on screen in both modes: `CURAT` / `MOTOR OPRIT` badges, the engine status, and
  `LIMITATOR 0 dB` reading through a real `role="meter"`. The header also offers `Scenă` / `Ieși din
  scenă` (Stage / Exit stage, i.e. `aria-pressed` works).
- The **spine of direction A** is visible and in the intended order: level meters left, the tuner strip
  and the **pitch ribbon** (with its in-tune bands) in the middle column, **SPECTRU** directly under it
  with its 100 / 1k / 10k log marks, the setlist panel right, and the mix strip at the bottom (Intrare /
  Principal / Monitor / Monitor sec, `Urechi netunate`, `Panică`, `Ocolire`, `Mut`).
- **Stage mode** removes the chain and the setlist editing and keeps the safety bar, the ribbon, the
  spectrum and the mix — seen in the second screenshot, and asserted (the chain region goes from present
  to absent and back).
- **axe reports no serious or critical violation** (WCAG 2.0/2.1 A + AA tags) on the console.

**Two real defects the render caught — both fixed the same hour (`67764bbe`).**

1. **Escape was a no-op after entering Stage mode.** The dialog's own handler and the app's window-level
   shortcut ran in an order that could lose the key, so the console stayed in Stage mode with a dialog
   that reopened: `expect(Chain).toBeVisible()` after Escape failed, twice (both attempts, 5 s each). The
   handler now closes an open panel itself, so the outcome no longer depends on listener order. This is
   exactly the class of bug the source review cannot see, and it was the only failing assertion — the
   first cloud run was 2 passed / 1 failed.
2. **Stale copy on the measure button**: `setup.measureHint` still promised "The live engine stops while
   it measures", which stopped being true in WP21-19 part 3 (measuring now refuses while the engine
   runs). Visible in the rendered Setup panel; both languages corrected.

### Second rendered pass, with a session (`0a707a03` + `39c6be34`): **5 passed, exit 0**

The first pass could only see an empty console, because a browser has no Tauri runtime: the app opens
Setup and says so, and the chain renders "Lanțul e gol". So the console gained a **session fixture**
(`lib/fixture.ts`, gated on the build-time `VITE_LIVE_FIXTURE` that only the cloud render mode sets —
dead code in a real build), and the pass now sees the console **with data**:

- **the hero visual per effect**: `svg[data-fx]` on every chain card, ≥ 9 of them for the fixture's
   nine-insert preset, each with real geometry, ≥ 9 distinct effects drawn, none blank;
- the **state reaching the UI**: the mix knob reports `-3 dB` through `aria-valuetext`, the setlist
   panel reads `Warm up`;
- the **ribbon and the spectrum with live frames**: at least three canvases carry ink (asserted by
   reading the pixels), and the meters move.

Seen on screen, then (screenshot `live-desktop-fixture-1280x720.png`): the tuner reads `A3` with
`Țintă A3 · Corecție -10 ct`, the ribbon traces `A3 · 10 ¢`, the **spectrum draws its log axis and a
band of content**, the meters show green bars, the preset row has `Pop Polish` lit with `96 BPM`, the
setlist reads `CLUB SET / Warm up / Chorus · A minor · 96 BPM` with its parts, and the mix strip shows
`Intrare 0 dB / Principal -3 dB / Monitor -6 dB / Monitor sec 20%` — i.e. exactly the fixture's state.

**A third real defect, and the most instructive one.** The first pass reported "no serious or critical
axe violation" — and that result was **vacuous**: the Setup dialog was open, Base UI marks the rest of
the page inert, and axe therefore only scanned the dialog. Once Escape actually closed it (defect 1),
axe saw the console and found **`button-name`: 9 nodes — every chain card's summary button had no
accessible name**, because the parameter summary is empty whenever the catalogue is missing (a real
state: `catalogueError`). Fixed with an explicit `aria-label` on that button (`ea465c50`). Both axe
tests now pass **against the console itself**.

**One design weakness the render showed, fixed** (`0a707a03`): the spectrum's floor was the engine's
-90 dB, so ordinary material (the fixture's voice sits at -60…-45 dB) drew as a hairline. The desktop
now rescales from **-70 dB**, where the same frames read as bars.

Two harness defects surfaced and were fixed so the pass is repeatable: the bundle had to keep
`apps/live/desktop` (`749da286`) and a cold pnpm store raced on parallel installs
("failed to import …/…_pacquet-stage_…: No such file or directory"), now retried serially (`f6e5e9c5`).

**Still unseen on screen** (stated, not implied): everything that needs the real engine — the meters'
ballistics, the ribbon and spectrum driven by an actual voice, the hero visuals' contrast on stage, and
the whole Tauri shell (window, installer, pairing QR). That is what the rig measurement with the owner
is for.

**Score, rendered (rubric /60; the cinematic criteria 3, 6, 8, 9, 10 are not applicable to a
performance console and are scored 1-2 as the rubric demands, not by intent).**

| | Code-level | Rendered, empty | Rendered, with a session |
|---|---|---|---|
| Craft (25) | 15 | 17 | **19** — the populated screen reads as a console: hierarchy, the ribbon over the spectrum, the chain with a shape per card; "subject presence" is still a card, not a hero |
| Game feel (25) | 7 | 7 | **8** — the ribbon and the meters are alive; no entrance, no morphing, by design |
| Discipline (10) | 8 | 9 | **10** — axe clean *against the console*, the overflow measured, every interactive element named |
| **Total** | 30/60 | 33/60 | **37/60** (≈ 37/42 on the criteria that apply to a performance console) |

**Prescriptions from this pass, and their state.**

1. ~~A session fixture so the rendered pass can see the chain, the visuals and the ribbon~~ — **done**
   (`39c6be34`); the pass is now 5 tests and looked at the populated console.
2. `components/Presets.tsx` — the preset row overflows to a horizontal scroll with six presets plus
   `Salvează ca…`, and the `96 BPM` pill sits outside the scroll on its own. Checked at 1280 px in the
   render: nothing is broken or clipped, so this is a **layout-preference** item, not a defect — the
   pills scroll as designed. Left as is, recorded so it is not "found" again.
3. ~~`LIMITATOR` type too small~~ — **done** (`39c6be34`): the label, the bar and the `0 dB` readout
   each went one step up, and the render confirms they read at the same weight as the state chips.
4. **New**: the spectrum's floor is now -70 dB for display; when the rig measurement lands, re-check it
   against a real voice at stage level (a quiet passage should still be visible, a loud one must not
   clip flat against the top).
5. **New**: the fixture's synthetic session is the only session this pass has ever seen. A desktop run
   on the owner's machine (or a captured real `state` frame) would let the pass check the visuals at
   real parameter values, including extreme ones (a limiter at -12 dB, a fully wet reverb).

## User-intent gap

Partial. The safety bar, Stage mode and the pitch ribbon as the main visual are in; the spectrum and the
per-effect hero visuals are not, so the screen reads as functional-first rather than the finished direction A.
